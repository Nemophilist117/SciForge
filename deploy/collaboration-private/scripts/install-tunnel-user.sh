#!/usr/bin/env bash

set -euo pipefail

die() {
  echo "ERROR: $*" >&2
  exit 1
}

member="${1:-}"
public_key_input="${2:-}"
source_cidr="${3:-}"
confirmation="${4:-}"
requested_expiry="${5:-}"
[[ "$member" =~ ^[bcde]$ && -n "$public_key_input" && -n "$source_cidr" \
    && "$confirmation" == --confirm-tunnel-account-change ]] \
  || die "Usage: install-tunnel-user.sh <b|c|d|e> <ed25519-public-key-file> <public-IPv4/32> --confirm-tunnel-account-change [expiry-UTC]"
(( EUID == 0 )) || die "Tunnel account installation must run as root."

for command in getent id useradd usermod install ssh-keygen stat mktemp rm chown chmod mv \
  date grep sshd systemctl cat; do
  command -v "$command" >/dev/null 2>&1 || die "Required command is unavailable: $command"
done

[[ "$source_cidr" =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})/32$ ]] \
  || die "Source restriction must be one public IPv4 /32."
for octet in "${BASH_REMATCH[@]:1:4}"; do
  (( 10#$octet <= 255 )) || die "Source restriction contains an invalid IPv4 octet."
done
source_ip="${source_cidr%/32}"
case "$source_ip" in
  0.*|10.*|127.*|169.254.*|192.168.*|224.*|225.*|226.*|227.*|228.*|229.*|23[0-9].*|24[0-9].*|25[0-5].*)
    die "Source restriction must be a routable public IPv4 /32."
    ;;
esac
second_octet="${source_ip#*.}"
second_octet="${second_octet%%.*}"
if [[ "$source_ip" == 172.* ]] && (( second_octet >= 16 && second_octet <= 31 )); then
  die "Source restriction must not use RFC1918 space."
fi

now_epoch="$(date -u +%s)"
maximum_expiry_epoch="$((now_epoch + 14 * 24 * 60 * 60))"
if [[ -n "$requested_expiry" ]]; then
  [[ "$requested_expiry" =~ ^[0-9]{14}Z$ ]] \
    || die "expiry-UTC must use the OpenSSH YYYYMMDDHHMMSSZ form."
  expiry_iso="${requested_expiry:0:4}-${requested_expiry:4:2}-${requested_expiry:6:2}T${requested_expiry:8:2}:${requested_expiry:10:2}:${requested_expiry:12:2}Z"
  expiry_epoch="$(date -u -d "$expiry_iso" +%s 2>/dev/null)" \
    || die "expiry-UTC is not a real UTC timestamp."
  (( expiry_epoch > now_epoch && expiry_epoch <= maximum_expiry_epoch )) \
    || die "Tunnel key expiry must be in the future and no more than 14 days away."
  key_expiry="$requested_expiry"
else
  key_expiry="$(date -u -d '@'"$maximum_expiry_epoch" +%Y%m%d%H%M%SZ)"
fi

if [[ "$public_key_input" = /* ]]; then
  public_key_file="$public_key_input"
else
  public_key_file="$PWD/$public_key_input"
fi
[[ -f "$public_key_file" && ! -L "$public_key_file" ]] \
  || die "Public key input must be a regular, non-symlink file."
public_key_file="$(cd "$(dirname "$public_key_file")" && pwd -P)/$(basename "$public_key_file")"
mapfile -t public_key_lines < "$public_key_file"
(( ${#public_key_lines[@]} == 1 )) || die "Public key input must contain exactly one line."
public_key="${public_key_lines[0]%$'\r'}"
[[ "$public_key" =~ ^ssh-ed25519[[:space:]]+[A-Za-z0-9+/]+={0,3}([[:space:]][^[:cntrl:]]*)?$ ]] \
  || die "Only one plain ssh-ed25519 public key is accepted."
ssh-keygen -l -f "$public_key_file" > /dev/null \
  || die "ssh-keygen rejected the supplied public key."

account="sciforge-tunnel-$member"
account_home="/var/lib/$account"
account_shell=/usr/sbin/nologin
sshd_dropin="/etc/ssh/sshd_config.d/90-$account.conf"
grep -Eiq '^[[:space:]]*Include[[:space:]]+/etc/ssh/sshd_config\.d/\*\.conf([[:space:]]|$)' \
  /etc/ssh/sshd_config \
  || die "sshd_config must include /etc/ssh/sshd_config.d/*.conf before installing tunnel accounts."

if id "$account" >/dev/null 2>&1; then
  passwd_entry="$(getent passwd "$account")"
  [[ "$passwd_entry" == *":$account_home:$account_shell" ]] \
    || die "Existing tunnel account has an unexpected home or shell."
else
  useradd --system --user-group --home-dir "$account_home" --create-home \
    --shell "$account_shell" "$account"
fi
usermod --lock --shell "$account_shell" --home "$account_home" "$account"

install -d -o "$account" -g "$account" -m 0700 "$account_home" "$account_home/.ssh"
[[ ! -e "$account_home/.ssh/authorized_keys" && ! -e "$sshd_dropin" ]] \
  || die "This member already has tunnel authorization; revoke it before installing a replacement key."
temporary_key="$(mktemp "$account_home/.ssh/.authorized_keys.XXXXXX")"
temporary_sshd="$(mktemp /etc/ssh/sshd_config.d/.sciforge-tunnel.XXXXXX)"
installation_complete=false
cleanup() {
  local exit_code=$?
  trap - EXIT INT TERM
  rm -f -- "$temporary_key" "$temporary_sshd"
  if [[ "$installation_complete" != true ]]; then
    rm -f -- "$account_home/.ssh/authorized_keys" "$sshd_dropin"
    if ! sshd -t > /dev/null 2>&1 \
        || ! systemctl reload sshd > /dev/null 2>&1; then
      echo "ERROR: tunnel authorization rollback could not restore and reload sshd." >&2
      exit_code=1
    fi
  fi
  exit "$exit_code"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
authorized_key_line="from=\"$source_cidr\",expiry-time=\"$key_expiry\",restrict,port-forwarding,permitopen=\"127.0.0.1:8787\",command=\"/usr/sbin/nologin\" $public_key"
printf '%s\n' "$authorized_key_line" > "$temporary_key"
chown "$account:$account" "$temporary_key"
chmod 0600 "$temporary_key"

cat > "$temporary_sshd" <<EOF
Match User $account
    AuthenticationMethods publickey
    PubkeyAuthentication yes
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    AllowTcpForwarding local
    AllowStreamLocalForwarding no
    PermitOpen 127.0.0.1:8787
    GatewayPorts no
    PermitTTY no
    X11Forwarding no
    AllowAgentForwarding no
    PermitUserRC no
    ForceCommand /usr/sbin/nologin
EOF
chown root:root "$temporary_sshd"
chmod 0600 "$temporary_sshd"
mv -f -- "$temporary_key" "$account_home/.ssh/authorized_keys"
mv -f -- "$temporary_sshd" "$sshd_dropin"

sshd -t || die "sshd rejected the tunnel-only Match User configuration."
mapfile -t installed_authorized_keys < "$account_home/.ssh/authorized_keys"
[[ ${#installed_authorized_keys[@]} == 1 \
    && "${installed_authorized_keys[0]%$'\r'}" == "$authorized_key_line" ]] \
  || die "Installed authorized key restrictions do not match the requested member/source/expiry."
effective_sshd="$(sshd -T -C "user=$account,host=localhost,addr=$source_ip")"
for required_setting in \
  'authenticationmethods publickey' \
  'passwordauthentication no' \
  'kbdinteractiveauthentication no' \
  'allowtcpforwarding local' \
  'allowstreamlocalforwarding no' \
  'permitopen 127.0.0.1:8787' \
  'gatewayports no' \
  'permittty no' \
  'x11forwarding no' \
  'allowagentforwarding no' \
  'permituserrc no' \
  'forcecommand /usr/sbin/nologin'; do
  grep -Fqx "$required_setting" <<< "$effective_sshd" \
    || die "Effective sshd policy is missing a tunnel-only restriction."
done
systemctl reload sshd \
  || die "Could not reload sshd; the new tunnel authorization was removed."
installation_complete=true

echo "Tunnel account installed for member ${member^^}: $account; source is one /32, the only forwarding destination is TCP 127.0.0.1:8787, expiry is at most 14 days, and shell/PTY/SFTP/SCP/remote or Unix-socket forwarding/agent/X11/user-rc are denied."

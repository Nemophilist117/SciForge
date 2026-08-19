#!/usr/bin/env bash

set -euo pipefail

die() {
  echo "ERROR: $*" >&2
  exit 1
}

member="${1:-}"
confirmation="${2:-}"
[[ "$member" =~ ^[bcde]$ && "$confirmation" == --confirm-tunnel-account-change ]] \
  || die "Usage: revoke-tunnel-user.sh <b|c|d|e> --confirm-tunnel-account-change"
(( EUID == 0 )) || die "Tunnel account revocation must run as root."

for command in id usermod install date mv chown chmod pkill sshd systemctl; do
  command -v "$command" >/dev/null 2>&1 || die "Required command is unavailable: $command"
done

account="sciforge-tunnel-$member"
account_home="/var/lib/$account"
revocation_root="/var/lib/sciforge-tunnel-revoked/$member"
sshd_dropin="/etc/ssh/sshd_config.d/90-$account.conf"
if ! id "$account" >/dev/null 2>&1; then
  echo "Tunnel account for member ${member^^} is already absent."
  exit 0
fi

install -d -o root -g root -m 0700 "$revocation_root"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
if [[ -f "$account_home/.ssh/authorized_keys" && ! -L "$account_home/.ssh/authorized_keys" ]]; then
  revoked_key="$revocation_root/authorized_keys.$timestamp"
  [[ ! -e "$revoked_key" ]] || die "A revocation record already exists for this timestamp."
  mv -- "$account_home/.ssh/authorized_keys" "$revoked_key"
  chown root:root "$revoked_key"
  chmod 0600 "$revoked_key"
fi
if [[ -f "$sshd_dropin" && ! -L "$sshd_dropin" ]]; then
  revoked_sshd="$revocation_root/90-$account.conf.$timestamp"
  [[ ! -e "$revoked_sshd" ]] || die "An sshd revocation record already exists for this timestamp."
  mv -- "$sshd_dropin" "$revoked_sshd"
  chown root:root "$revoked_sshd"
  chmod 0600 "$revoked_sshd"
fi
usermod --lock --shell /usr/sbin/nologin "$account"
sshd -t || die "sshd configuration became invalid while revoking the tunnel account."
systemctl reload sshd || die "Could not reload sshd after tunnel revocation."

# Every member has a dedicated UID, so this terminates only that member's
# established tunnels and cannot revoke B/C/D/E as a group.
account_uid="$(id -u "$account")"
[[ "$account_uid" =~ ^[0-9]+$ && "$account_uid" -ge 100 ]] \
  || die "Refusing to signal an unexpected account UID."
pkill -KILL -u "$account_uid" 2>/dev/null || true

echo "Tunnel account independently revoked for member ${member^^}; active forwarding processes for only $account were terminated."

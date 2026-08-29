# Identity and Access

Identity and Access is the sole contributor of SciForge's generic
`main.principal-provider`. The provider has exactly two states:

- signed out, represented by `principal: null`; or
- a `sciforge-cloud` Principal with `cloud-authenticated` assurance for the
  canonical Cloud User on the exact revalidated `ACTIVE` Desktop Device.

System-browser Authorization Code with PKCE, strict OIDC token verification,
canonical `/v1/me` lookup, and Device enrollment jointly establish that
Principal. Logout, OIDC ownership change, Device revoke, an unconfirmed Device
refresh, or Identity storage failure advances `identityVersion` and fails
closed to `principal: null`. There is no installation-local Human Principal,
Local Account selection, or fallback identity. Local capabilities that do not
require a Human Principal remain available while signed out.

The package-owned SQLite database stores only the monotonic Principal
authorization revision. Schema migration removes the former account tables;
it does not translate an unauthenticated local identity into a Cloud User or
migrate Provider credentials between Principals. OIDC refresh material and
Device authority are restored only through their existing verified paths.

The main process publishes three owner-scoped, token-free internal services.
The authenticated User Cloud transport is available only to its manifest
allowlist. Its `2.0.0` contract accepts only the closed Collaboration
`RestRequest`/`RestResponse` protocol, rejects credential-shaped portable
resource identities, and excludes Agent credential lifecycle envelopes. The
`sciforge.agent-cloud-runtime@3.0.0` owns bounded Device Agent ensure, rotation,
revocation, command, pull, and WSS operations for Collaboration. Bootstrap is
strictly ordered as current OIDC User, freshly revalidated ACTIVE Device, then
configured canonical Agent Runtime. No renderer or consuming domain supplies
an Agent name, node type, capability, bootstrap key, or idempotency key.

Identity derives the Device-bound display name through Cloud and the exact
token-free Runtime/model-access tags from Host readiness. Missing or
unexecutable Runtime configuration fails closed before Agent creation. The
service performs bootstrap decryption and bearer injection without returning
Agent authority. OIDC ownership changes, logout, Device revoke, and
unconfirmed Device refresh fence in-flight Agent authority; same-User token
refresh preserves the existing binding. Cloud remains authoritative for at
most one active, Device-named Agent per Device.

The Device fact-attestation signer is available only to
`sciforge.project-coordinator`, accepts the single
`project-content-provisioning-attestation` fact envelope, revalidates the exact
OIDC User and ACTIVE Device before every signature, and returns public
verification metadata only. No renderer capability, arbitrary-byte signing
surface, Token, Agent authority, or Device private key crosses a service
contract.

OIDC refresh material, the Device signing key, and per-Agent authority remain
behind one Identity private-vault interface. On macOS the vault uses the
in-process Node-API Keychain adapter with `WhenUnlockedThisDeviceOnly` and
non-synchronizable accessibility. On Windows and Linux it uses the public
package-scoped Host secret store; Electron `safeStorage` provides DPAPI on
Windows and requires an approved libsecret or KWallet backend on Linux. Missing
or insecure platform storage fails closed; there is no environment, plaintext
file, subprocess, IPC, renderer, or alternate fallback.

Identity does not own Content Space Provider sessions. A Provider Connector
keeps its own credential, Content Space owns provider-neutral binding and
readiness, and Collaboration consumes only existing non-secret projections.
OpenContent is one Content Space Provider implementation and never becomes a
SciForge login authority.

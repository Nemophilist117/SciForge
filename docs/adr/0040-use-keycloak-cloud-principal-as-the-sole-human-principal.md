---
status: accepted
reviewed: 2026-08-28
supersedes: ADR-0014
amends: ADR-0015, ADR-0018, ADR-0019, ADR-0023, ADR-0026, ADR-0031, ADR-0037
---

# Use Keycloak Cloud Principal as the sole Human Principal

SciForge Desktop no longer creates, selects, renames, or exits an
installation-local Human account. The generic Principal provider publishes
either `principal: null` or one `sciforge-cloud` Principal with
`cloud-authenticated` assurance for the canonical `/v1/me` User on the exact
revalidated `ACTIVE` Desktop Device. There is no weaker fallback Principal.

Signed-out operation is not a guest identity. Local capabilities remain usable
only when their own contracts do not require a Human Principal. Cloud,
cross-user, and Principal-owned Provider operations fail closed while the
Principal is absent. OIDC tokens, Device private keys, Agent credentials, and
authenticated Cloud transport remain inside Identity's existing main-only
boundaries.

The former Local Account database is migrated to a singleton monotonic
`identityVersion` store. Account rows and selection state are deleted. A
Provider credential stored for the former `local-selection` Principal is not
translated, reassigned, or exposed to a Cloud User; only credentials already
bound to the same canonical Cloud Principal can be reached after verified
session and Device restoration.

This decision does not make any Provider account a SciForge identity.
Content Space remains the provider-neutral owner of Provider Instances,
`ContentSpaceProvider`, binding attestation, resources, readiness, and
admission. OpenContent remains one Provider implementation whose Connector
owns only its native login, Token custody, external subject observation, and
native calls.

No Cloud command, REST endpoint, IPC, manifest internal service, Host provider
branch, Content Space SPI method, Provider capability ID, or Collaboration
protocol is added by this decision. Provider Principal Fact synchronization
continues to use the existing provider-neutral Content Space observations,
`provider_directory_principal.publish`, and Identity's existing
`AuthenticatedCloudTransport.execute()` boundary.

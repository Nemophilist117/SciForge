# Identity and Access

> Current-state audit: 2026-08-28. Identity and Access publishes either no Human Principal or one OIDC-backed `cloud-authenticated` Principal on an `ACTIVE` Desktop Device. Local Account selection and `local-selection` are removed. Provider accounts remain outside SciForge identity and are reached only through their provider-neutral Content Space integration.

Identity and Access is the SciForge bounded context for authenticating the
current person and holding User, Device, and Agent credentials. It does not own
Projects, Provider accounts, Content Space readiness, or external ACLs.

## Language

**SciForge User**:
A person with one stable identity owned by SciForge Cloud and used consistently
for Devices, Agents, Projects, remote Sessions, attribution, and audit.
_Avoid_: Provider user, installation ID, window caller, Agent thread

**Canonical User ID**:
The opaque `usr_*` identifier returned by SciForge Cloud after a validated OIDC
`issuer + subject` is resolved through `/v1/me`. It is never derived from an
email, display name, Provider account, or renderer input.
_Avoid_: Keycloak subject, email, username, Provider principal ID

**OIDC Subject Binding**:
The Cloud-owned association between one Canonical SciForge User and one
immutable Keycloak `issuer + subject` pair. It is authentication evidence, not
a Project role or Provider identity.
_Avoid_: email match, Project membership, Provider binding

**Desktop OIDC Client**:
The secretless public Keycloak client used by SciForge Desktop through the
system browser and Authorization Code with PKCE.
_Avoid_: embedded login, Desktop client secret, shared Provider login

**Signed-out State**:
The state represented by `principal: null`. Local chat, Workspace, models, and
tools whose own contracts do not require a Human Principal may remain usable;
Cloud and Principal-owned Provider operations fail closed.
_Avoid_: guest User, anonymous cloud User, installation Principal

**Connected Mode**:
The state backed by a current OIDC User and an exact, freshly revalidated
`ACTIVE` Desktop Device. Only this state publishes a Human Principal.
_Avoid_: internet available, Provider connected, Device installed

**OIDC Session**:
The Identity-owned, main-only authentication session mapped to one Canonical
SciForge User. Token material is never renderer state, a Collaboration
contract, a Provider credential, or an Agent machine credential.
_Avoid_: Provider session, shared bearer, collaboration login

**Human Principal**:
The current canonical SciForge User together with `cloud-authenticated`
assurance, the exact Cloud Device ID, and a monotonic `identityVersion`. It
exists only while both OIDC User and ACTIVE Device facts are current.
_Avoid_: caller ID, installation ID, email, Provider login

**Principal Assurance**:
The evidence class used by Identity to establish a Human Principal. The current
schema contains only `cloud-authenticated`; absence of that evidence is
represented by `principal: null`, not by a weaker fallback assurance.
_Avoid_: role, permission, login boolean, Provider readiness

**Token-Free Authenticated Cloud Transport**:
The main-only boundary through which an allowlisted trusted domain asks
Identity to execute one existing Cloud operation as the current OIDC User.
Consumers never receive authorization headers or Token material.
_Avoid_: Token broker, renderer HTTP client, parallel Cloud client

**Active Desktop Device**:
The current User's exact Desktop Device whose lifecycle state Cloud has
revalidated as `ACTIVE`. It is required for Human and Agent authority but does
not prove Provider permission.
_Avoid_: installation ID alone, OIDC Session alone, Provider Connection

**Device Signing Key**:
A non-exportable Device key used only by the Identity/Host boundary for
domain-approved fact digests. The private key is not an Agent tool, Provider
credential, or arbitrary signing API.
_Avoid_: OIDC Token, Agent credential, Provider credential

**Agent Cloud Session**:
Identity's main-only authority for one Cloud-issued Agent bound to the current
User and exact ACTIVE Device. Identity stores and injects replayable Agent
credential material privately; Collaboration receives only token-free
operations and non-secret facts.
_Avoid_: Collaboration credential store, Device identity alone, Project role

**Device Agent Binding**:
The Cloud-authoritative one-to-one binding from an exact ACTIVE Desktop Device
to its active Agent. Identity ensures it only after the canonical Agent Runtime
is ready.
_Avoid_: manual primary Agent, hostname identity, account type

**External Account**:
An account whose lifecycle and permissions are owned by a service outside
SciForge. It never becomes the SciForge User through matching attributes.
_Avoid_: SciForge User, Login Method

**Provider Connection**:
A node-local, revocable credential binding owned by a provider-specific
Connector for the complete current Human Principal and exact Provider Instance.
It does not merge identities or confer Cloud Project authority.
_Avoid_: SciForge login, shared credential, email-based binding

**Content Space Provider Binding**:
The provider-neutral Content Space evidence and readiness for one exact
`ContentSpaceProvider` instance. The Provider Connector authenticates its
external session; Content Space owns binding attestation and admission;
Identity only supplies the current Principal.
_Avoid_: Identity-owned Provider login, Cloud membership, OpenContent-only contract

**OpenContent Account**:
An External Account observed by the OpenContent Connector when the selected
Content Space Provider implementation is OpenContent. Its native identity and
ACL remain OpenContent authority; it is not a SciForge User or Human Principal.
_Avoid_: SciForge account, top-level Content Space identity, email match

**Agent Host**:
A Device capable of running a SciForge Agent with locally authorized models,
tools, data, and network resources.
_Avoid_: Human Principal, Cloud Coordinator, mobile Agent

**Communication Device**:
A Device that delivers messages and Human responses but does not execute an
Agent merely by being registered.
_Avoid_: Worker, Agent Host, Human Principal

**Agent**:
An execution identity owned by one SciForge User and hosted by one Agent Host.
Coordinator and Worker are Project/Task relationships, not account types.
_Avoid_: person, Device, permanent Coordinator account

## Boundary Rules

1. Keycloak authentication plus `/v1/me` establishes the canonical User; an
   exact ACTIVE Device is additionally required before publishing a Principal.
2. Logout, User change, Device revoke, Device uncertainty, or Identity storage
   failure advances authority and publishes `principal: null`.
3. Renderer code may trigger Identity capabilities and display status only. It
   never handles Tokens, Device keys, Cloud commands, or Principal IDs.
4. Collaboration uses existing token-free Identity services. Identity does not
   create Project membership, Task Authority, or Provider Principal Facts.
5. Content Space owns provider-neutral Provider Instance, binding attestation,
   resource references, readiness, and admission. OpenContent is one Provider
   implementation behind that abstraction.
6. Provider credentials remain scoped to the complete current Principal. No
   credential stored for a removed weaker assurance is migrated or borrowed.

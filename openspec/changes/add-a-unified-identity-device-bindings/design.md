## Context

The A server currently resolves database-backed opaque User and Agent bearer credentials. Anonymous `pairing.begin/redeem` can create a User and return a User credential, while `agent.register` identifies an installation directly and therefore conflates the durable Device with the Agent node. The target model instead makes Keycloak `(issuer, sub)` the only User login identity, keeps Device and Agent separate, and binds a verified Zulip identity to an existing User.

The implementation lands on top of an intentionally dirty A worktree containing unrelated A-MVP execution, confirmation, resource, capability, and Inbox work. Those changes and the existing cross-team umbrella OpenSpec are protected inputs. This change uses its own OpenSpec directory and migration `0005`; edits to shared source files must be narrow additions over their current contents.

The D-to-A production authentication mechanism for binding confirmation is not frozen. Offline implementation therefore needs a fail-closed injectable service-actor boundary. Real Keycloak, Desktop PKCE, and Zulip Bot environments are external and must not be represented by fixture tests.

## Goals / Non-Goals

**Goals:**

- Resolve a strictly verified RS256 OIDC access token to one stable ACTIVE A User, creating the User and OIDC identity exactly once under concurrent first use.
- Add Device enrollment and proof-of-possession APIs whose durable Device record owns installation, platform, public Ed25519 JWK, and capability summary.
- Replace anonymous User bootstrap with an authenticated User-to-Zulip binding state machine and a trusted confirmation boundary.
- Link Agent registration to an ACTIVE Device of the same OIDC User while preserving Agent node capabilities and credentials independently.
- Preserve repository Fake/PostgreSQL parity, append-only audit, idempotency, readiness, backup/recovery, and existing collaboration behavior outside identity bootstrap.
- Provide offline contract, Service, HTTP, Provider-boundary, concurrency, real PostgreSQL, security-log, and regression evidence using the supplied dynamic fixtures.

**Non-Goals:**

- Desktop/Web browser login, PKCE, token storage, Device private-key generation/storage, or UI.
- Zulip Bot `/bind` parsing, Bot deployment, general message forwarding, or choosing the final D-to-A credential mechanism.
- B Coordinator algorithms, C AgentRuntime/journal, E UI, node execution, Project/Task state-machine changes, or shared-document content.
- Email-based migration or merge of legacy Users, automatic migration of provider identities, or continued opaque User-token authentication.
- Claiming fixture-based tests as real Keycloak/Desktop/Zulip E2E.

## Decisions

### 1. Keep identity as a cohesive A server module

Public identity schemas and entities live in the collaboration contracts package. OIDC verification, identity authentication, Device/binding Service logic, and HTTP adapters remain explicit server components wired by bootstrap. Project/Task logic only consumes the resulting `UserActor` or `AgentActor`; it does not learn Keycloak, JWK, or Zulip details.

This avoids a second server or provider-owned identity database while keeping identity internals out of the collaboration kernel. A generic external auth framework was rejected because only one issuer and one strict token profile are required, and an extra dependency would enlarge the authentication supply chain.

### 2. Strictly separate OIDC User JWTs from opaque Agent credentials

Tokens with JWT structure are processed only by the OIDC verifier. Any parse, header, signature, discovery, JWKS, claim, issuer, audience, client, or time failure is terminal and never falls back to the credential table. Non-JWT opaque tokens are accepted only for existing Agent credentials; legacy opaque User credentials no longer produce a User actor.

`UserActor` carries stable `userId`, OIDC identity ID, exact issuer and subject, and the verified `auth_time`. Its `actorKey` is stable for the OIDC identity rather than JWT-specific, so token refresh does not change idempotency ownership. `AgentActor` additionally carries `deviceId`; authentication checks that the User, Device, Agent, credential generation, and ownership are all ACTIVE/current.

### 3. Use native Node verification with bounded discovery and JWKS caching

The configured issuer is the only discovery root. The verifier fetches `<issuer>/.well-known/openid-configuration`, requires the returned issuer to match byte-for-byte, accepts a bounded `jwks_uri` only from the validated discovery document, and imports public RSA JWKs with Node crypto. Production endpoints require HTTPS; loopback HTTP is allowed only for explicit local/test configuration.

JWT header `alg` must equal `RS256`; `kid` is required and selects exactly one signing key. JWKS entries must be RSA signing keys compatible with RS256. Cache lifetime is bounded by configuration/HTTP cache metadata, concurrent refreshes are coalesced, and an unknown `kid` triggers at most one forced refresh per verification. Response/body sizes, key counts, redirects, and timeouts are bounded to prevent SSRF/resource amplification.

Claims are strict: exact `iss`; `aud` string/array containing `sciforge-cloud-api`; `azp` in `sciforge-desktop|sciforge-web-mobile`; non-empty string `sub`; and finite integer `exp`, `nbf`, `iat`, `auth_time` with valid current-time relationships and a small configured skew. Raw JWTs, Authorization values, full claims, binding codes, nonces, signatures, and key material never enter errors, audit, or diagnostics.

### 4. Make JIT resolution an atomic repository operation

`oidc_identities` has a database unique constraint on `(issuer, subject)`. PostgreSQL resolution runs in one transaction, takes a transaction-scoped advisory lock derived from a stable digest of that pair, re-reads the identity, and only the lock winner creates both User and identity. The unique constraint remains the final invariant. The Fake repository serializes the same operation so Service and concurrency tests have equivalent behavior.

Email is optional link-time metadata only. It does not participate in lookup or merging. User status is checked after resolution on every request, and no raw token or full claims are persisted.

### 5. Use one-time Device enrollment with explicit nonce proof

`POST /v1/device-enrollments` is OIDC User-authenticated, generates at least 32 random bytes, returns the nonce once, and stores only its digest with User, requested installation ID, five-minute expiry, and consumption state.

Because the server cannot reconstruct a random nonce from a digest, `POST /v1/devices` includes the returned nonce as a transport-only proof in addition to the plan's business fields. The server hashes it, compares it to the stored digest, and never persists it in plaintext. This resolves the otherwise impossible combination of signing the nonce while storing only its digest.

The canonical UTF-8 payload is exactly six LF-separated fields with no terminal newline. The public JWK is strict `OKP/Ed25519/EdDSA/sig`, contains no private `d`, and decodes to a 32-byte `x`. Node crypto verifies the signature before a transaction consumes enrollment and creates the ACTIVE Device. Unknown fields, invalid platform/architecture, oversized capability summary, wrong User/installation, expiry, and replay fail closed.

Device revocation requires verified `auth_time` no older than 300 seconds. One transaction marks the Device REVOKED, revokes every credential for Agents linked to it, and writes audit. Reads preserve history. `(user_id, installation_id)` and a global installation ownership invariant prevent silent cross-User transfer.

### 6. Keep one Zulip binding state machine

An OIDC User creates a five-minute binding request for a normalized HTTPS realm URL. A new request expires older PENDING requests for the same User and realm. Only a digest of the high-entropy display code is stored; the plaintext code is returned once.

`POST /v1/integrations/zulip/bindings/confirm` first invokes an injected confirmation authenticator. That component must return a `ServiceActor` and the verified Zulip realm/user context. If no authenticator is configured, or it returns no trusted context, the route is forbidden. User/anonymous actors and caller-declared service identity cannot reach Service confirmation. The initial production bootstrap deliberately leaves this adapter absent until D authentication is frozen; tests inject a non-secret actor/identity resolver.

Confirmation locks the request and conflicting identity rows, never creates a User, and binds only the code's existing User. Partial unique indexes enforce at most one ACTIVE binding for `(realm_id, zulip_user_id)` and at most one ACTIVE Zulip identity for `(user_id, realm_id)` while retaining REVOKED history. Same-User replays with the same idempotency key return the original result; used, expired, and cross-User conflict outcomes retain their stable public codes.

External identity revocation also requires recent `auth_time`, marks history REVOKED, and expires pending requests. Rebinding always creates a new request and binding record.

The old pairing command path is no longer anonymous and no longer creates a User or returns a User credential. If retained as a transition adapter, it delegates to this same binding state machine; there is no second challenge authority. Provider runtime code cannot verify an old challenge into a new User.

### 7. Link, but never merge, Agent and Device

`agent.register` accepts `deviceId` and derives owner from the OIDC User actor. A transitional `ownerUserId`, if present in protocol fixtures, must equal that actor and is never authoritative. In the registration transaction the Device is locked/re-read, must be ACTIVE and owned by the actor, and is stored as `agent_nodes.device_id`.

Device platform, JWK, and `capabilitySummary` are not copied to Agent. Agent retains node `capabilities`, heartbeat updates, status, and existing credential generation/rotation. `agentId` and `deviceId` use distinct namespaces. Revoking an Agent does not modify Device; revoking Device invalidates all linked Agent authentication and writes.

### 8. Preserve strict HTTP/idempotency/error/audit behavior

The four Device routes and four Zulip identity routes are direct JSON HTTP resources with strict schemas and bounded bodies. Every mutation requires a matching `Idempotency-Key` header/body key; GETs do not. `/v1/me` uses the same OIDC resolver as `/v1/commands`. Authoritative User IDs always come from the authentication context.

Accepted and rejected security boundaries write redacted append-only audit metadata. Binding codes, enrollment nonces, JWTs, claims, signatures, JWK private fields, Authorization headers, service credentials, and Bot credentials are prohibited from logs, traces, errors, receipts, and audit. Existing public error envelopes remain canonical, with the binding-specific stable codes added to their error registry.

### 9. Add schema version 5 without rewriting prior work

Migration `0005_unified_identity_device_bindings.sql` adds `oidc_identities`, `device_enrollments`, `devices`, binding request/history structures, `agent_nodes.device_id`, indexes, checks, and foreign keys. It follows the existing untracked `0004_coordination_contract.sql` and does not edit it. Readiness is updated to validate the exact schema, required constraints, and indexes. Historical Agents cannot be assigned a fabricated Ed25519 Device: the column remains nullable for history, migration revokes legacy ACTIVE Agents and their credentials, and a check requires every ACTIVE Agent to have a non-null Device.

Legacy User/pairing rows are preserved for backup/audit but are not guessed into OIDC identities. Deployment policy is backup first, then require Users to log in through OIDC and rebind Zulip. A migration mapping is only allowed later from an explicit `(issuer, sub)` table supplied outside this change.

### 10. Treat fixture tests and external E2E as different evidence classes

Exact copies/adapters of the supplied dynamic OIDC/JWKS, Ed25519, and binding fixtures are made available to the target repository's tests so clean CI and release verification do not depend on the untracked parent directory. Tests cover contracts, Service, HTTP, provider/service boundaries, concurrency, log redaction, real PostgreSQL migration/restart/backup behavior, and all existing collaboration regressions.

Dynamic local servers and generated keys prove offline protocol behavior only. A real Keycloak account with required mappers, a current Desktop, and a real D/Zulip Bot are separately gated external evidence and remain explicitly not-run until available.

## Risks / Trade-offs

- **[Existing dirty files overlap identity code]** → Record the pre-change patch hash, edit only narrow regions, never reset/stash/clean, keep the new OpenSpec and migration paths independent, and review the final diff against the protected file list.
- **[Discovery/JWKS compromise or SSRF]** → Exact issuer checks, restricted URL policy, bounded fetches/cache/refresh, strict RSA JWK selection, no algorithm negotiation, and negative tests.
- **[Concurrent JIT or binding creates duplicates]** → Transaction locks plus database unique/partial-unique constraints; test both Service concurrency and real PostgreSQL races.
- **[Device revocation races an Agent write]** → Authentication checks Device ACTIVE and sensitive Agent mutations re-lock/revalidate Device in their transaction.
- **[OIDC migration locks out legacy Users]** → This is an intentional security break; backup first, deploy issuer configuration, communicate re-login/rebind, and never restore opaque User fallback.
- **[D authentication remains undecided]** → Confirm is disabled without an injected trusted resolver; no environment flag, header, or anonymous shortcut impersonates D.
- **[External systems are unavailable]** → Deployable code and offline evidence can complete, but status reporting labels real Keycloak/Desktop/Zulip E2E as not run.

## Migration Plan

1. Preserve and test the current dirty A-MVP baseline; create the new A-only artifacts and migration without touching the umbrella change or `0004`.
2. Implement contracts, verifier/authentication, repository/model/schema, identity Service, HTTP routes, pairing replacement, and Agent linkage with Fake parity.
3. Run the supplied fixture self-test, focused identity tests, full collaboration contract/Service/HTTP/Provider tests, real PostgreSQL concurrency/migration/restart tests, security audit, typecheck, and original regression suite.
4. Build a fixed release bundle from the reviewed tree and record exact commit/artifact digests. Do not include parent-workspace fixtures, tokens, keys, environment files, or source-only secrets.
5. On A ECS, take and verify a database backup, install issuer/audience/client configuration, run migration 5, deploy the fixed bundle, then verify health, readiness, schema, core regressions, and fail-closed confirm behavior.
6. Rollback application code to the previous fixed bundle if health/readiness fails. The additive tables/history remain; restore the verified backup only if database correctness requires full rollback. Never attempt email-based reverse migration.
7. When Keycloak and D authentication are later available, configure the production confirmation adapter and run real `OIDC User → Device → Agent` plus `OIDC User ↔ Zulip identity` E2E. Record that as separate evidence.

## Open Questions

- Which production mechanism authenticates `sciforge-zulip-bot` to A: Keycloak client credentials (recommended), mTLS, or a same-process trusted call? Until frozen, confirm remains disabled outside injected tests.
- Which explicit `(issuer, sub)` mappings, if any, should migrate legacy test Users? Default deployment performs no identity merge and requires re-login/rebind.

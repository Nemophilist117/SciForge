## 1. Protected baseline and change boundary

- [x] 1.1 Record the target HEAD, branch, dirty tracked/untracked file inventory, patch digest, baseline typecheck, and baseline collaboration regression result without resetting or rewriting existing work.
- [x] 1.2 Verify the external `A-unified-identity-test-kit` self-test and record that it is offline-only evidence.
- [x] 1.3 Keep this change A-only: verify no B/C/D/E private implementation, Project/Task state-machine change, or edit to the existing umbrella OpenSpec is introduced.

## 2. Public identity contracts

- [x] 2.1 Add strict OIDC User/me, Device enrollment/create/list/revoke, external identity, and Zulip binding begin/confirm contract schemas and public entities.
- [x] 2.2 Add stable identity/binding error codes and HTTP rules, including `IDENTITY_ALREADY_BOUND`, `BINDING_CODE_USED`, and `BINDING_CODE_EXPIRED`.
- [x] 2.3 Change `agent.register` to require `deviceId`, derive owner from the authenticated User, and keep Agent runtime capabilities distinct from Device capability summary.
- [x] 2.4 Remove anonymous/User-credential issuance semantics from pairing contracts or make the retained commands strict adapters over the one binding state machine.
- [x] 2.5 Add focused contract tests and update machine-readable protocol artifacts/freshness checks without overwriting unrelated A-MVP artifacts.

## 3. OIDC verification and User resolution

- [x] 3.1 Implement bounded exact-issuer Discovery/JWKS fetching, caching, coalesced refresh, strict RS256/kid/JWK verification, and key rotation using Node crypto.
- [x] 3.2 Implement strict iss/aud/azp/sub/exp/nbf/iat/auth_time claim validation, URL/time bounds, and redacted failure diagnostics.
- [x] 3.3 Add atomic `(issuer, subject)` JIT User resolution with a stable OIDC actor key, database uniqueness/transaction locking, Fake parity, and no email merge.
- [x] 3.4 Make `/v1/me` and User commands share the OIDC resolver; reject legacy opaque User credentials and never fall back after JWT failure while preserving opaque Agent credentials.
- [x] 3.5 Add dynamic OIDC/JWKS tests for valid identity, all negative claims/signature cases, same-email separation, concurrent first login, local User status, caching, rotation, and secret-free diagnostics.

## 4. Identity persistence and migration

- [x] 4.1 Extend stored models and repository interfaces/Fake with OIDC identities, Device enrollments, Devices, Zulip binding requests/history, Device-linked Agents, and required locking/listing operations.
- [x] 4.2 Add `0005_unified_identity_device_bindings.sql` with tables, foreign keys, status/check constraints, active partial unique indexes, single-consumption invariants, and safe legacy Agent revocation without fabricating Devices.
- [x] 4.3 Implement PostgreSQL CRUD/transaction behavior and precise allowlisted constraint/error mapping for all new identity records and Agent linkage.
- [x] 4.4 Advance migration/readiness validation to schema version 5 and verify exact tables, columns, indexes, constraints, foreign keys, rollback, and Fake/PostgreSQL parity.

## 5. Device enrollment and lifecycle

- [x] 5.1 Implement five-minute User/installation-bound Device enrollment with a 32-byte-or-greater random nonce returned once and only a digest persisted.
- [x] 5.2 Implement strict platform, Ed25519 public JWK, capability summary, nonce, canonical LF payload, and proof-of-possession validation.
- [x] 5.3 Implement atomic Device create/idempotent replay, owner-scoped list, global installation ownership conflict, revisioned history, and append-only redacted audit.
- [x] 5.4 Implement recent-auth Device revocation, linked Agent credential cascade, transaction-time Device fencing, and non-destructive history retention.
- [x] 5.5 Add fixture-backed Service and HTTP tests for success, wrong User/installation, malformed/private JWK, signature tamper, expiry, replay/concurrency, list isolation, recent-auth, and cascade revocation.

## 6. Zulip User binding

- [x] 6.1 Implement OIDC User binding begin with a five-minute one-time code digest and automatic expiry of older same-User/Realm pending requests.
- [x] 6.2 Implement a fail-closed injectable confirmation authenticator that supplies a trusted service actor and verified Zulip context; leave production confirm disabled when no adapter is configured.
- [x] 6.3 Implement atomic confirm without User creation, dual ACTIVE uniqueness, same-User idempotency, provider-event replay, stable used/expired/conflict errors, Human Endpoint integration, and redacted audit.
- [x] 6.4 Implement owner-scoped external identity list and recent-auth revoke/rebind history while invalidating pending codes and identity resolution.
- [x] 6.5 Remove the old anonymous pairing/User credential bootstrap and ensure any retained pairing/provider path delegates to the same binding state machine without parsing D `/bind` messages.
- [x] 6.6 Add fixture-backed Service/HTTP/provider-boundary tests for trusted/untrusted confirm, no anonymous backdoor, conflict/concurrency, used/expired codes, idempotency, revoke/rebind, and no User creation.

## 7. Agent-to-Device linkage

- [x] 7.1 Persist `agent_nodes.device_id` and validate ACTIVE same-owner Device under transaction lock during `agent.register` and credential rotation/ownership-sensitive operations.
- [x] 7.2 Keep Device platform/JWK/capability summary out of Agent records while preserving Agent runtime capabilities, heartbeat, capability profile, credential generation, and distinct IDs.
- [x] 7.3 Make every Agent authentication and critical write reject revoked/mismatched Devices, including register-vs-revoke and authenticate-vs-revoke races; keep Agent-only revoke from changing Device.
- [x] 7.4 Update Agent registration/authentication tests and existing collaboration fixtures to create an OIDC User and Device first, with explicit Device/Agent capability separation.

## 8. Runtime, deployment, and documentation

- [x] 8.1 Wire strict OIDC issuer/audience/client/fetch settings and identity Service through bootstrap/CLI; add safe environment examples and no secret-bearing defaults.
- [x] 8.2 Add the direct identity HTTP routes with strict body limits, matching idempotency header/body enforcement, canonical error envelopes, and service-actor isolation.
- [x] 8.3 Expand log/trace/audit redaction tests for JWT, Authorization, claims, nonce, signature, binding code/digest, Bot secret, API key, and private JWK material.
- [x] 8.4 Update A server/deployment/public API documentation and verification scripts to describe OIDC User → Device → Agent and User ↔ Zulip binding, remove anonymous bootstrap claims, and label fixture evidence as offline only.
- [ ] 8.5 Update private Compose/release assets for schema 5 and configured test/production issuer while keeping the confirm route fail-closed until D authentication is frozen.

## 9. Verification and release

- [x] 9.1 Run fixture self-tests, contract artifact checks, contract/Service/HTTP/Provider boundary tests, typecheck, changed-file lint/secret audit, and the full existing collaboration regression suite.
- [x] 9.2 Run real PostgreSQL migration, constraint, concurrent JIT/binding/enrollment, restart, and backup/restore verification; record exact results separately from SQL-mock tests.
- [x] 9.3 Review the combined diff against the protected dirty baseline, confirm unrelated A-MVP work remains present, and audit for legacy anonymous/User-opaque/pairing bypasses and duplicate identity state machines.
- [x] 9.4 Create a fixed commit and reproducible A release bundle with exact manifest/digests and no credentials, parent-workspace-only fixtures, source tree, or development environment files.
- [x] 9.5 Back up A ECS, deploy migration 5 and the fixed bundle, then verify health, readiness, schema, fail-closed confirm, OIDC dependency behavior, core contract, restart, and recovery gates.
- [x] 9.6 Report real Keycloak/Desktop/D-Zulip E2E as not run until those external environments and service authentication are available; never promote offline fixtures to real E2E evidence.

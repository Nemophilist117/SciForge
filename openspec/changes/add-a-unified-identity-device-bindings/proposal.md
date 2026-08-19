## Why

A currently bootstraps human identity through anonymous provider pairing and treats an Agent credential as the first durable machine identity. That cannot safely make the same OIDC user stable across desktops, prove control of a Device key, or bind a Zulip identity to an already authenticated User without creating a second identity authority.

## What Changes

- Add strict RS256 OIDC access-token verification and concurrency-safe JIT mapping from `(issuer, sub)` to one stable A `userId`; `GET /v1/me` and User commands share this resolver.
- Add Device enrollment, creation, listing, and revocation APIs. Device owns installation identity, platform metadata, Ed25519 public JWK, and `capabilitySummary`.
- **BREAKING**: change provider pairing from anonymous User bootstrap into an OIDC-authenticated Zulip binding flow. Pairing no longer creates Users or issues User credentials.
- Add a trusted Zulip binding-confirm boundary backed by an injectable service actor until D-to-A production authentication is frozen; ordinary User and anonymous actors cannot confirm.
- Require `agent.register` to reference an existing ACTIVE Device owned by the authenticated User. Agent remains a distinct node entity and retains runtime `capabilities` and its existing credential lifecycle.
- Add PostgreSQL constraints, append-only audit events, readiness checks, redacted diagnostics, and Fake/PostgreSQL repository parity for the new identity state.
- Keep all C browser/PKCE/private-key work, D `/bind` parsing, E UI, B coordination logic, node runtime implementation, message forwarding, and Project/Task state-machine changes outside A.

## Capabilities

### New Capabilities

- `oidc-user-identity`: Strict OIDC discovery/JWKS validation, User actor resolution, concurrency-safe JIT identity mapping, and stable `/v1/me` behavior.
- `device-identity`: One-time Device enrollment with Ed25519 proof of possession, Device ownership/list/revocation, and Device-to-Agent credential invalidation.
- `zulip-user-binding`: OIDC User-initiated binding codes, trusted service-actor confirmation, external-identity query/revoke, conflict, expiry, replay, and audit semantics.
- `agent-device-linkage`: Agent registration and authentication rules that link each Agent to an ACTIVE, same-owner Device while preserving node capabilities separately.

### Modified Capabilities

None. The repository has no archived canonical specs; this A-only change deliberately does not edit the dirty cross-team umbrella change.

## Impact

- Public A HTTP surface: `/v1/me`, Device enrollment/Device APIs, Zulip binding APIs, and the existing `/v1/commands` authentication boundary.
- Collaboration contracts and server: identity entities/commands/errors, authentication, Service, repositories, PostgreSQL migrations, audit, readiness, HTTP mapping, and security logging.
- Existing pairing and `agent.register` callers must move to OIDC User authentication and Device-first enrollment.
- Deployment gains explicit OIDC issuer/audience/client configuration and an injectable binding-confirm service-auth adapter; no anonymous fallback or embedded secret is introduced.
- Verification uses `A-unified-identity-test-kit` dynamic OIDC/JWKS, Ed25519, and binding fixtures, plus real PostgreSQL and existing collaboration regressions. Mock fixtures are offline evidence only, not Keycloak/Desktop/Zulip E2E evidence.

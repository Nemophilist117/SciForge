import { describe, expect, it } from 'vitest'

import { safeAuditMetadata } from './crypto.js'

describe('identity security diagnostics', () => {
  it('removes every replayable identity and provider secret class from audit metadata', () => {
    const canaries = {
      authorization: ['Bearer', 'jwt-canary'].join(' '),
      accessToken: 'access-token-canary',
      idToken: 'id-token-canary',
      refresh_token: 'refresh-token-canary',
      credential: 'credential-canary',
      apiKey: ['api', 'key', 'canary'].join('-'),
      botKey: 'bot-key-canary',
      privateJwk: 'private-jwk-canary',
      deviceNonce: 'nonce-canary',
      deviceSignature: 'signature-canary',
      bindingCode: 'binding-code-canary',
      binding_code_digest: 'binding-digest-canary',
      jwt: 'jwt-canary',
      errorCode: 'BINDING_CODE_USED',
      correlationId: 'corr_identity_safe_0001'
    }
    const output = safeAuditMetadata(canaries)
    const serialized = JSON.stringify(output)
    for (const canary of Object.values(canaries).filter((value) => value.endsWith('-canary'))) {
      expect(serialized).not.toContain(canary)
    }
    expect(output).toEqual({ errorCode: 'BINDING_CODE_USED', correlationId: 'corr_identity_safe_0001' })
  })

  it('does not serialize nested full claims or JWK objects', () => {
    expect(safeAuditMetadata({
      claims: { sub: 'subject-canary', email: 'email-canary@example.invalid' },
      publicJwk: { kty: 'OKP', d: 'private-canary' },
      issuer: 'https://login-test.sciforge.cn/realms/SciForge'
    })).toEqual({ issuer: 'https://login-test.sciforge.cn/realms/SciForge' })
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  DomainMainProviderCredentialAccess,
  DomainMainProviderCredentialStoreHost
} from '@sciforge/domain-sdk/package-storage'
import type { PrincipalSnapshot } from '@sciforge/domain-sdk/principal'

import type { DomainPackageStorageFactory } from './domain-package-storage'
import {
  currentProviderCredentialAcceptancePrincipal,
  installProviderCredentialAcceptance
} from './provider-credential-acceptance'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => '/tmp/sciforge-provider-credential-acceptance-test'
  }
}))

afterEach(() => {
  delete process.env.SCIFORGE_PROVIDER_CREDENTIAL_ACCEPTANCE
  globalThis.__SCIFORGE_PROVIDER_CREDENTIAL_ACCEPTANCE__ = undefined
})

describe('provider credential acceptance seam', () => {
  it('exposes a canonical Cloud Principal only for the explicit smoke process', () => {
    expect(currentProviderCredentialAcceptancePrincipal()).toBeUndefined()

    process.env.SCIFORGE_PROVIDER_CREDENTIAL_ACCEPTANCE = '1'
    expect(currentProviderCredentialAcceptancePrincipal()).toEqual({
      authority: 'sciforge-cloud',
      subject: 'usr_ProviderCredentialAcceptance01',
      assurance: 'cloud-authenticated',
      deviceId: 'dev_ProviderCredentialAcceptance01',
      identityVersion: 1
    })
  })

  it('binds every phase operation to the exact Principal observed at phase start', async () => {
    process.env.SCIFORGE_PROVIDER_CREDENTIAL_ACCEPTANCE = '1'
    const principal: PrincipalSnapshot = Object.freeze({
      authority: 'sciforge-cloud',
      subject: 'usr_AcceptanceUser01',
      assurance: 'cloud-authenticated',
      deviceId: 'dev_AcceptanceDevice01',
      identityVersion: 4
    })
    const accesses: DomainMainProviderCredentialAccess[] = []
    let storedSecret: string | undefined
    const credentials: DomainMainProviderCredentialStoreHost = Object.freeze({
      status: async (access) => {
        accesses.push(access)
        return storedSecret === undefined
          ? Object.freeze({ state: 'absent' as const })
          : Object.freeze({ state: 'available' as const, recordVersion: 1 as const })
      },
      replace: async (access, secret) => {
        accesses.push(access)
        storedSecret = secret
      },
      use: async <T>(access: DomainMainProviderCredentialAccess, operation: (
        secret: string
      ) => T | Promise<T>) => {
        accesses.push(access)
        if (storedSecret === undefined) throw new Error('missing fixture secret')
        return operation(storedSecret)
      },
      remove: async (access) => {
        accesses.push(access)
        storedSecret = undefined
      }
    })
    const storageFactory = Object.freeze({
      forOwner: () => Object.freeze({
        settings: Object.freeze({}) as never,
        secrets: Object.freeze({ providerCredentials: credentials }) as never
      })
    }) satisfies DomainPackageStorageFactory

    installProviderCredentialAcceptance(storageFactory, () => principal)
    await expect(globalThis.__SCIFORGE_PROVIDER_CREDENTIAL_ACCEPTANCE__?.('store'))
      .resolves.toMatchObject({ phase: 'store', verified: true })
    expect(accesses).toHaveLength(3)
    for (const access of accesses) {
      expect(access.expectedPrincipal).toEqual(principal)
      expect(access).not.toHaveProperty('acceptedPrincipalAssurances')
    }
  })
})

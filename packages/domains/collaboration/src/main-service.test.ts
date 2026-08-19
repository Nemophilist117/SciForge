import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  DomainMainHost,
  DomainMainInternalServiceRegistration
} from '@sciforge/domain-sdk/host'

import { createDomainMainEntry } from './main.js'
import {
  COLLABORATION_BC_NODE_CONTRACT_VERSION,
  COLLABORATION_BC_NODE_SERVICE_ID,
  type CollaborationBCNodePort
} from './main/bc-node-port.js'

test('C registers one owner-scoped B/C service through the Host', () => {
  let registered: DomainMainInternalServiceRegistration<CollaborationBCNodePort> | undefined
  const host = {
    getUserDataDir: () => '/tmp/sciforge-test',
    defineCapability: (definition: unknown) => definition,
    packageSettings: {
      read: async () => ({ revision: 0, value: null }),
      write: async (value: never) => ({ revision: 1, value }),
      clear: async () => ({ revision: 1, value: null })
    },
    packageSecrets: {
      has: async () => false,
      read: async () => null,
      write: async () => undefined,
      remove: async () => undefined
    },
    internalServices: {
      register: (candidate: DomainMainInternalServiceRegistration<CollaborationBCNodePort>) => {
        registered = candidate
      },
      acquire: () => { throw new Error('C does not acquire its own service.') }
    }
  } as unknown as DomainMainHost

  const entry = createDomainMainEntry(host)

  assert.equal(registered?.serviceId, COLLABORATION_BC_NODE_SERVICE_ID)
  assert.equal(registered?.contractVersion, COLLABORATION_BC_NODE_CONTRACT_VERSION)
  assert.deepEqual(registered?.allowedConsumerModuleIds, ['sciforge.project-coordinator'])
  assert.equal(typeof registered?.service.register, 'function')
  assert.equal(typeof registered?.service.current, 'function')
  assert.equal(typeof registered?.service.execute, 'function')
  assert.equal(typeof registered?.service.wake, 'function')
  assert.equal(entry.contributions.some((item) => item.id === 'collaboration.bc-service'), true)
})

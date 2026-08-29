import type { ReactElement } from 'react'
import { UserRound } from 'lucide-react'
import type { DomainRendererHost } from '@sciforge/domain-sdk/host'
import {
  defineTrustedRendererDomainPackageEntry,
  type DomainRendererCommandHandler,
  type DomainRendererWorkbenchGlobalOverlayValue,
  type DomainRendererWorkbenchToolbarActionValue,
  type TrustedRendererDomainPackageEntry
} from '@sciforge/domain-sdk/renderer'
import {
  IDENTITY_RENDERER_COMMAND_CONTRIBUTION,
  IDENTITY_RENDERER_GLOBAL_OVERLAY_CONTRACT,
  IDENTITY_RENDERER_GLOBAL_OVERLAY_CONTRIBUTION,
  IDENTITY_RENDERER_I18N_CONTRIBUTION,
  IDENTITY_RENDERER_LIFECYCLE_CONTRIBUTION,
  IDENTITY_RENDERER_TOOLBAR_ACTION_CONTRACT,
  IDENTITY_RENDERER_TOOLBAR_ACTION_CONTRIBUTION,
  domainPackageDefinition
} from '../definition.js'
import { IdentityOverlay } from './IdentityOverlay.js'
import { createIdentityRendererClient } from './client.js'
import {
  identityI18nResourceContribution,
  type IdentityI18nResourceContribution
} from './messages.js'
import { IdentityRendererProjection } from './projection.js'

type IdentityRendererLifecycle = Readonly<{
  activate(): void | (() => void)
}>

type IdentityRendererContribution =
  | DomainRendererCommandHandler
  | DomainRendererWorkbenchToolbarActionValue<typeof UserRound>
  | DomainRendererWorkbenchGlobalOverlayValue<ReactElement>
  | IdentityRendererLifecycle
  | IdentityI18nResourceContribution

export function createDomainRendererEntry(
  host: DomainRendererHost
): TrustedRendererDomainPackageEntry<IdentityRendererContribution> {
  if (!host.workbench?.toggleGlobalOverlay) {
    throw new Error('Identity requires the generic Workbench global-overlay host.')
  }
  const workbench = host.workbench
  const projection = new IdentityRendererProjection(
    createIdentityRendererClient(host.capabilityInvoker)
  )

  const command: DomainRendererCommandHandler = Object.freeze({
    execute: (invocation) => {
      const active = invocation.activeSurface?.kind === 'global-overlay' &&
        invocation.activeSurface.contributionId ===
          IDENTITY_RENDERER_GLOBAL_OVERLAY_CONTRIBUTION.id
      workbench.toggleGlobalOverlay!({
        contributionId: IDENTITY_RENDERER_GLOBAL_OVERLAY_CONTRIBUTION.id,
        ...(invocation.sessionId ? { sessionId: invocation.sessionId } : {}),
        open: !active
      })
    },
    isAvailable: (invocation) => Boolean(invocation.sessionId),
    isActive: (invocation) =>
      invocation.activeSurface?.kind === 'global-overlay' &&
      invocation.activeSurface.contributionId ===
        IDENTITY_RENDERER_GLOBAL_OVERLAY_CONTRIBUTION.id
  })
  const toolbar: DomainRendererWorkbenchToolbarActionValue<typeof UserRound> =
    Object.freeze({ icon: UserRound })
  const overlay: DomainRendererWorkbenchGlobalOverlayValue<ReactElement> =
    Object.freeze({
      render: (context) => (
        <IdentityOverlay
          projection={projection}
          onClose={context.onClose}
        />
      )
    })
  const lifecycle: IdentityRendererLifecycle = Object.freeze({
    activate: () => {
      void projection.load()
      return () => {
        projection.dispose()
      }
    }
  })

  return defineTrustedRendererDomainPackageEntry<IdentityRendererContribution>({
    definition: domainPackageDefinition,
    contributions: [
      {
        ...IDENTITY_RENDERER_COMMAND_CONTRIBUTION,
        value: command
      },
      {
        ...IDENTITY_RENDERER_TOOLBAR_ACTION_CONTRIBUTION,
        contract: IDENTITY_RENDERER_TOOLBAR_ACTION_CONTRACT,
        value: toolbar
      },
      {
        ...IDENTITY_RENDERER_GLOBAL_OVERLAY_CONTRIBUTION,
        contract: IDENTITY_RENDERER_GLOBAL_OVERLAY_CONTRACT,
        value: overlay
      },
      {
        ...IDENTITY_RENDERER_LIFECYCLE_CONTRIBUTION,
        value: lifecycle
      },
      {
        ...IDENTITY_RENDERER_I18N_CONTRIBUTION,
        value: identityI18nResourceContribution
      }
    ]
  })
}

export * from './client.js'
export * from './messages.js'
export * from './projection.js'

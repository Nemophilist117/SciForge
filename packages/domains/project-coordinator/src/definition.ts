import {
  defineTrustedDomainPackage,
  type DomainPackageProcess,
  type TrustedDomainPackageDefinition,
  type TrustedDomainPackageDefinitionInput
} from '@sciforge/domain-sdk/contract'
import manifest from '../sciforge.domain.json' with { type: 'json' }

export const domainPackageDefinition: TrustedDomainPackageDefinition =
  defineTrustedDomainPackage(manifest as TrustedDomainPackageDefinitionInput)

export const PROJECT_COORDINATOR_DOMAIN_MODULE_ID = domainPackageDefinition.module.id
export const PROJECT_COORDINATOR_DOMAIN_PACKAGE_NAME = domainPackageDefinition.packageName
export const PROJECT_COORDINATOR_CAPABILITY_FACTORY_CONTRIBUTION = contributionFor(
  'main',
  'main.capability-factory'
)
export const PROJECT_COORDINATOR_RUNTIME_LIFECYCLE_CONTRIBUTION = contributionFor(
  'main',
  'main.runtime-lifecycle'
)

function contributionFor(process: DomainPackageProcess, kind: string) {
  const contribution = domainPackageDefinition.entrypoints
    .find((entrypoint) => entrypoint.process === process)
    ?.contributions.find((candidate) => candidate.kind === kind)
  if (!contribution) throw new Error(`B manifest is missing ${process}:${kind}.`)
  return contribution
}

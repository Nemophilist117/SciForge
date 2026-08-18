import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

import {
  buildCollaborationServerBundle,
  COLLABORATION_RELEASE_PACKAGES,
  assertFullCommit,
  parseArguments,
  readNpmPackageArchiveFiles,
  validateContractArtifactFiles,
  validatePackManifest
} from './build-collaboration-server-bundle.mjs'

const approvedCommit = '063155e8d378693bfeba5a926e12b74eeafb3cf8'
const privateTestCommit = 'a63155e8d378693bfeba5a926e12b74eeafb3cf8'
const sourceRepositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

function validFilesFor(packageName) {
  if (packageName === '@sciforge/collaboration-contracts') {
    return [
      'package.json',
      'dist/index.js',
      'dist/index.d.ts',
      'artifacts/protocol-1.0/ARTIFACT_MANIFEST.json',
      'artifacts/protocol-1.0/state-and-actors.json'
    ]
  }
  if (packageName === '@sciforge/collaboration-provider-zulip') {
    return [
      'package.json',
      'README.md',
      'sciforge.provider.json',
      'dist/server.js',
      'dist/server.d.ts'
    ]
  }
  return [
    'package.json',
    'README.md',
    '.env.example',
    'dist/cli.js',
    'dist/index.js',
    'dist/index.d.ts',
    'migrations/0001_initial.sql',
    'deploy/collaboration-server.env.example',
    'deploy/sciforge-collaboration.service'
  ]
}

function stringifyJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

function createContractArtifactFiles(commit) {
  const state = stringifyJson({
    artifactVersion: 1,
    protocolVersion: '1.0',
    contractCommit: commit,
    actors: {},
    permissions: [],
    stateTransitions: {}
  })
  const files = [{
    path: 'state-and-actors.json',
    sha256: createHash('sha256').update(state).digest('hex'),
    bytes: Buffer.byteLength(state)
  }]
  return new Map([
    ['state-and-actors.json', state],
    ['ARTIFACT_MANIFEST.json', stringifyJson({
      artifactVersion: 1,
      contractVersion: '1.0',
      protocolVersion: '1.0',
      contractCommit: commit,
      commitInjectionPlaceholder: '__SCIFORGE_COLLABORATION_COMMIT__',
      files
    })]
  ])
}

const testBundleDependencies = Object.freeze({
  generateContractArtifactFiles: createContractArtifactFiles
})

function writeTarOctal(header, offset, length, value) {
  const encoded = `${value.toString(8).padStart(length - 1, '0')}\0`
  header.write(encoded, offset, length, 'ascii')
}

function createTarHeader(path, size) {
  if (Buffer.byteLength(path) > 100) throw new Error(`Test tar path is too long: ${path}`)
  const header = Buffer.alloc(512)
  header.write(path, 0, 100, 'utf8')
  writeTarOctal(header, 100, 8, 0o644)
  writeTarOctal(header, 108, 8, 0)
  writeTarOctal(header, 116, 8, 0)
  writeTarOctal(header, 124, 12, size)
  writeTarOctal(header, 136, 12, 0)
  header.fill(32, 148, 156)
  header[156] = '0'.charCodeAt(0)
  header.write('ustar\0', 257, 6, 'ascii')
  header.write('00', 263, 2, 'ascii')
  const checksum = header.reduce((sum, byte) => sum + byte, 0)
  header.write(checksum.toString(8).padStart(6, '0'), 148, 6, 'ascii')
  header[154] = 0
  header[155] = 32
  return header
}

async function writeNpmArchive(path, entries) {
  const parts = []
  for (const [relativePath, value] of entries) {
    const content = Buffer.isBuffer(value) ? value : Buffer.from(value)
    parts.push(createTarHeader(`package/${relativePath}`, content.byteLength), content)
    const padding = (512 - (content.byteLength % 512)) % 512
    if (padding > 0) parts.push(Buffer.alloc(padding))
  }
  parts.push(Buffer.alloc(1024))
  await writeFile(path, gzipSync(Buffer.concat(parts)))
}

async function readOrCreatePackFile(packageDirectory, relativePath, packageName) {
  try {
    return await readFile(join(packageDirectory, relativePath))
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    if (relativePath === 'package.json') {
      return Buffer.from(stringifyJson({ name: packageName, version: '0.1.0' }))
    }
    return Buffer.from(`fixture:${packageName}:${relativePath}`)
  }
}

async function createRepository() {
  const root = await mkdtemp(join(tmpdir(), 'sciforge-collaboration-bundle-test-'))
  for (const specification of COLLABORATION_RELEASE_PACKAGES) {
    const directory = join(root, specification.directory)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'package.json'), `${JSON.stringify({
      name: specification.name,
      version: '0.1.0'
    })}\n`)
    if (specification.name === '@sciforge/collaboration-contracts') {
      await mkdir(join(directory, 'dist'), { recursive: true })
      await writeFile(join(directory, 'dist', 'index.js'), 'export {}\n')
      await writeFile(join(directory, 'dist', 'index.d.ts'), 'export {}\n')
      await mkdir(join(directory, 'artifacts', 'protocol-1.0'), { recursive: true })
      await writeFile(
        join(directory, 'artifacts', 'protocol-1.0', 'ARTIFACT_MANIFEST.json'),
        stringifyJson({ contractCommit: '__SCIFORGE_COLLABORATION_COMMIT__' })
      )
    }
  }
  return root
}

function createCommandHarness({
  dirty = false,
  failPacking,
  headCommit = approvedCommit,
  isAncestor = () => true,
  originGuiCommit = approvedCommit,
  tamperContractArchive
} = {}) {
  const calls = []
  const runCommand = async ({ command, args, cwd }) => {
    calls.push({ command: basename(command), args: [...args], cwd })
    if (basename(command).startsWith('git')) {
      if (args[0] === 'rev-parse' && args[2] === 'HEAD^{commit}') {
        return { stdout: `${headCommit}\n`, stderr: '' }
      }
      if (args[0] === 'rev-parse' && args[2] === 'origin/gui^{commit}') {
        return { stdout: `${originGuiCommit}\n`, stderr: '' }
      }
      if (args[0] === 'status') return { stdout: dirty ? '?? local-secret.env\n' : '', stderr: '' }
      if (args[0] === 'merge-base') {
        if (!isAncestor(args[2], args[3])) throw new Error('simulated non-ancestor')
        return { stdout: '', stderr: '' }
      }
    }

    if (command === process.execPath && args[0] === 'scripts/collaboration-providers.mjs') {
      assert.deepEqual(args, ['scripts/collaboration-providers.mjs', '--check'])
      return { stdout: '', stderr: '' }
    }

    if (basename(command).startsWith('npm') && args.includes('run')) {
      const packageName = args[args.indexOf('--workspace') + 1]
      if (packageName === '@sciforge/collaboration-contracts') {
        const directory = join(cwd, 'packages/collaboration-contracts/dist')
        await mkdir(directory, { recursive: true })
        await writeFile(join(directory, 'index.js'), 'export {}\n')
        await writeFile(join(directory, 'index.d.ts'), 'export {}\n')
      }
      return { stdout: '', stderr: '' }
    }
    if (basename(command).startsWith('npm') && args[0] === 'pack') {
      const workspaceIndex = args.indexOf('--workspace')
      let packageDirectory
      let packageName
      if (workspaceIndex === -1) {
        packageDirectory = args[1]
        packageName = JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8')).name
      } else {
        packageName = args[workspaceIndex + 1]
        packageDirectory = join(cwd, COLLABORATION_RELEASE_PACKAGES.find(
          (specification) => specification.name === packageName
        ).directory)
      }
      if (failPacking === packageName) throw new Error('simulated pack failure')
      const destination = args[args.indexOf('--pack-destination') + 1]
      const filename = `${packageName.replace('@sciforge/', 'sciforge-')}-0.1.0.tgz`
      const relativePaths = validFilesFor(packageName)
      const archiveEntries = new Map()
      for (const relativePath of relativePaths) {
        archiveEntries.set(
          relativePath,
          await readOrCreatePackFile(packageDirectory, relativePath, packageName)
        )
      }
      if (packageName === '@sciforge/collaboration-contracts') {
        if (tamperContractArchive === 'commit') {
          const manifestPath = 'artifacts/protocol-1.0/ARTIFACT_MANIFEST.json'
          const manifest = JSON.parse(archiveEntries.get(manifestPath).toString('utf8'))
          manifest.contractCommit = privateTestCommit
          archiveEntries.set(manifestPath, Buffer.from(stringifyJson(manifest)))
        } else if (tamperContractArchive === 'hash') {
          const statePath = 'artifacts/protocol-1.0/state-and-actors.json'
          archiveEntries.set(statePath, Buffer.concat([archiveEntries.get(statePath), Buffer.from(' ')]))
        }
      }
      await writeNpmArchive(join(destination, filename), archiveEntries)
      return {
        stderr: '',
        stdout: JSON.stringify([{
          name: packageName,
          version: '0.1.0',
          filename,
          files: relativePaths.map((path) => ({ path }))
        }])
      }
    }
    if (basename(command).startsWith('npm') && args[0] === 'install') {
      const packageJson = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8'))
      await writeFile(join(cwd, 'package-lock.json'), `${JSON.stringify({
        name: packageJson.name,
        version: packageJson.version,
        lockfileVersion: 3,
        requires: true,
        packages: {
          '': {
            name: packageJson.name,
            version: packageJson.version,
            dependencies: packageJson.dependencies
          }
        }
      }, null, 2)}\n`)
      return { stdout: '', stderr: '' }
    }
    throw new Error(`Unexpected command: ${command} ${args.join(' ')}`)
  }
  return { calls, runCommand }
}

test('CLI requires a complete immutable commit argument', () => {
  assert.equal(assertFullCommit(approvedCommit), approvedCommit)
  assert.throws(() => assertFullCommit(approvedCommit.slice(0, 12)), /complete 40-character/u)
  assert.deepEqual(parseArguments([
    '--commit', approvedCommit,
    '--output', 'release'
  ]), {
    help: false,
    commit: approvedCommit,
    outputDirectory: 'release',
    privateTestRelease: false,
    teamPrivateAcceptance: false
  })
  assert.deepEqual(parseArguments(['--private-test-release']), {
    help: false,
    privateTestRelease: true,
    teamPrivateAcceptance: false
  })
  assert.deepEqual(parseArguments(['--team-private-acceptance']), {
    help: false,
    privateTestRelease: false,
    teamPrivateAcceptance: true
  })
  assert.throws(() => parseArguments([
    '--private-test-release', '--private-test-release'
  ]), /only be provided once/u)
  assert.throws(() => parseArguments([
    '--team-private-acceptance', '--team-private-acceptance'
  ]), /only be provided once/u)
  assert.throws(() => parseArguments([
    '--private-test-release', '--team-private-acceptance'
  ]), /mutually exclusive/u)
  assert.throws(() => parseArguments(['--output']), /Missing value/u)
  assert.throws(() => parseArguments(['--unknown']), /Unknown argument/u)
})

test('server archive accepts examples but rejects source, real env, secret, and log paths', () => {
  const server = COLLABORATION_RELEASE_PACKAGES.find(({ name }) => (
    name === '@sciforge/collaboration-server'
  ))
  const base = {
    name: server.name,
    version: '0.1.0',
    filename: 'sciforge-collaboration-server-0.1.0.tgz',
    files: validFilesFor(server.name).map((path) => ({ path }))
  }
  assert.equal(validatePackManifest(server, base).files.includes('.env.example'), true)
  assert.equal(
    validatePackManifest(server, base).files.includes('deploy/collaboration-server.env.example'),
    true
  )

  assert.doesNotThrow(() => validatePackManifest(server, {
    ...base,
    files: [...base.files, { path: 'dist/index.js.map' }, { path: 'dist/index.d.ts.map' }]
  }))

  for (const forbiddenPath of [
    '.env',
    'deploy/production.env',
    'deploy/provider-secret.json',
    'logs/server.log',
    'src/index.ts',
    'debug/index.js.map'
  ]) {
    assert.throws(() => validatePackManifest(server, {
      ...base,
      files: [...base.files, { path: forbiddenPath }]
    }), /forbidden/u, forbiddenPath)
  }
})

test('private deployment assets keep provider secrets app-only and preserve the loopback boundary', async () => {
  const deployRoot = join(sourceRepositoryRoot, 'deploy', 'collaboration-private')
  const [baseCompose, providerCompose, dockerfile, common, baseDeploy, providerDeploy,
    backupScript, providerVerify, restartVerify, tunnelInstall, tunnelRevoke] = await Promise.all([
    readFile(join(deployRoot, 'compose.yml'), 'utf8'),
    readFile(join(deployRoot, 'compose.provider-zulip.yml'), 'utf8'),
    readFile(join(deployRoot, 'Dockerfile.runtime'), 'utf8'),
    readFile(join(deployRoot, 'scripts', 'common.sh'), 'utf8'),
    readFile(join(deployRoot, 'scripts', 'deploy.sh'), 'utf8'),
    readFile(join(deployRoot, 'scripts', 'deploy-provider-zulip.sh'), 'utf8'),
    readFile(join(deployRoot, 'scripts', 'backup.sh'), 'utf8'),
    readFile(join(deployRoot, 'scripts', 'verify-provider-zulip.sh'), 'utf8'),
    readFile(join(deployRoot, 'scripts', 'verify-postgres-restart.sh'), 'utf8'),
    readFile(join(deployRoot, 'scripts', 'install-tunnel-user.sh'), 'utf8'),
    readFile(join(deployRoot, 'scripts', 'revoke-tunnel-user.sh'), 'utf8')
  ])

  assert.match(baseCompose, /host_ip:\s*127\.0\.0\.1/u)
  assert.doesNotMatch(baseCompose, /SCIFORGE_COLLABORATION_PROVIDER_CONFIG_FILE/u)
  assert.match(baseCompose, /migrate:[\s\S]*?user:\s*"10001:10001"/u)
  assert.match(baseCompose, /app:[\s\S]*?user:\s*"10001:10001"/u)
  assert.match(providerCompose, /^services:\n {2}app:/u)
  assert.doesNotMatch(providerCompose, /^ {2}migrate:/mu)
  assert.equal((providerCompose.match(/read_only:\s*true/gu) ?? []).length, 2)
  assert.match(providerCompose, /target:\s*\/run\/sciforge-provider\/config\/providers\.json/u)
  assert.match(providerCompose, /target:\s*\/run\/sciforge-provider\/secrets/u)
  assert.match(dockerfile, /--uid 10001 --gid 10001[\s\S]*--shell \/usr\/sbin\/nologin/u)
  assert.match(dockerfile, /^USER 10001:10001$/mu)
  assert.match(common, /Every provider secret must be root:10001 mode 0640/u)
  for (const deployScript of [baseDeploy, providerDeploy]) {
    assert.match(deployScript, /stop -t 20 app/u)
    assert.match(deployScript, /up -d postgres/u)
    assert.ok(
      deployScript.indexOf('stop -t 20 app') < deployScript.indexOf('up -d postgres'),
      'the old app must stop before a release can touch PostgreSQL'
    )
  }
  assert.match(backupScript, /install -d -o root -g root -m 0700 -- "\$backup_dir"/u)
  assert.match(backupScript, /backup_owner.*stat -c '%u:%g'/su)
  assert.match(backupScript, /backup_permissions" == 700 && "\$backup_owner" == 0:0/u)

  assert.match(providerVerify, /providers\.length !== 1/u)
  assert.match(providerVerify, /body\.providers\[0\]\?\.provider !== 'zulip'/u)
  assert.match(providerVerify, /status = 'healthy'/u)
  assert.match(providerVerify, /checked_at >= to_timestamp\(\$app_started_epoch\)/u)
  assert.doesNotMatch(providerVerify, /cat .*secret/iu)

  assert.match(restartVerify, /--confirm-postgres-restart/u)
  assert.match(restartVerify, /enable_zulip_provider_compose/u)
  assert.match(restartVerify, /zulip-provider-private/u)
  assert.match(restartVerify, /config_mount_rw.*secret_mount_rw/su)
  assert.match(restartVerify, /providers\.length !== 1/u)
  assert.match(restartVerify, /body\.providers\[0\]\?\.provider !== 'zulip'/u)
  assert.match(restartVerify, /trap restore_postgres EXIT/u)
  assert.match(restartVerify, /stop -t 30 postgres/u)
  assert.match(restartVerify, /rows_after.*rows_before/u)
  assert.match(restartVerify, /app_pid_after" == "\$app_pid_before/u)
  assert.match(restartVerify, /app_restarts_after" == "\$app_restarts_before/u)
  assert.match(restartVerify, /safe_pool_diagnostic_count/u)
  assert.match(restartVerify, /postgres\\\.pool\\\.idle_client_error/u)
  assert.match(restartVerify, /57P0\[1-3\]/u)
  assert.match(restartVerify, /unsafe_runtime_detail_count/u)
  assert.match(restartVerify, /sensitive_log_pattern_count/u)
  assert.match(restartVerify, /safe_pool_diagnostic_count >= 1/u)
  assert.doesNotMatch(restartVerify, /grep .*-[A-Za-z]*n/u)

  assert.match(tunnelInstall, /member" =~ \^\[bcde\]\$/u)
  assert.match(tunnelInstall, /account="sciforge-tunnel-\$member"/u)
  assert.match(tunnelInstall, /authorized_key_line="from=\\"\$source_cidr\\",expiry-time=\\"\$key_expiry\\"/u)
  assert.match(tunnelInstall, /restrict,port-forwarding,permitopen=\\"127\.0\.0\.1:8787\\"/u)
  assert.match(tunnelInstall, /Match User \$account/u)
  assert.match(tunnelInstall, /AllowTcpForwarding local/u)
  assert.match(tunnelInstall, /ForceCommand \/usr\/sbin\/nologin/u)
  assert.match(tunnelInstall, /source_cidr.*\/32/u)
  assert.match(tunnelInstall, /14 \* 24 \* 60 \* 60/u)
  assert.match(tunnelInstall, /\/usr\/sbin\/nologin/u)
  assert.match(tunnelInstall, /installation_complete=false/u)
  assert.match(tunnelInstall, /trap cleanup EXIT/u)
  assert.match(tunnelInstall, /installation_complete=true/u)
  assert.ok(
    tunnelInstall.indexOf('installation_complete=true') > tunnelInstall.indexOf('systemctl reload sshd'),
    'tunnel install rollback must remain armed until sshd reload succeeds'
  )
  assert.doesNotMatch(tunnelInstall, /permitopen="0\.0\.0\.0/u)
  assert.match(tunnelRevoke, /member" =~ \^\[bcde\]\$/u)
  assert.match(tunnelRevoke, /account="sciforge-tunnel-\$member"/u)
  assert.match(tunnelRevoke, /pkill -KILL -u/u)
  assert.match(tunnelRevoke, /--confirm-tunnel-account-change/u)
})

test('builder emits only immutable release files and pins all official packages', async () => {
  const repositoryRoot = await createRepository()
  const outputDirectory = join(repositoryRoot, 'release')
  const harness = createCommandHarness()
  try {
    const result = await buildCollaborationServerBundle({
      ...testBundleDependencies,
      commit: approvedCommit,
      outputDirectory,
      repositoryRoot,
      runCommand: harness.runCommand
    })
    assert.equal(result.commit, approvedCommit)
    assert.equal(result.outputDirectory, outputDirectory)

    const entries = (await readdir(outputDirectory)).sort()
    assert.deepEqual(entries, [
      'CONTRACT_COMMIT',
      'RELEASE_MANIFEST.json',
      'SHA256SUMS',
      'package-lock.json',
      'package.json',
      'sciforge-collaboration-contracts-0.1.0.tgz',
      'sciforge-collaboration-provider-zulip-0.1.0.tgz',
      'sciforge-collaboration-server-0.1.0.tgz'
    ])
    assert.equal(await readFile(join(outputDirectory, 'CONTRACT_COMMIT'), 'utf8'), `${approvedCommit}\n`)

    const packageJson = JSON.parse(await readFile(join(outputDirectory, 'package.json'), 'utf8'))
    assert.deepEqual(Object.keys(packageJson.dependencies), COLLABORATION_RELEASE_PACKAGES.map(({ name }) => name))
    for (const reference of Object.values(packageJson.dependencies)) {
      assert.match(reference, /^file:\.\/.*\.tgz$/u)
    }

    const manifest = JSON.parse(await readFile(join(outputDirectory, 'RELEASE_MANIFEST.json'), 'utf8'))
    assert.equal(manifest.contractCommit, approvedCommit)
    assert.equal(manifest.releaseMode, 'origin-gui')
    assert.equal(Object.hasOwn(manifest, 'baseCommit'), false)
    assert.equal(manifest.packages.length, 3)
    for (const packageEntry of manifest.packages) {
      assert.equal(packageEntry.version, '0.1.0')
      const archive = await readFile(join(outputDirectory, packageEntry.filename))
      assert.equal(packageEntry.sha256, createHash('sha256').update(archive).digest('hex'))
    }

    const contractsArchive = join(outputDirectory, 'sciforge-collaboration-contracts-0.1.0.tgz')
    const packedContractFiles = await readNpmPackageArchiveFiles(contractsArchive)
    const packedArtifactFiles = new Map([...packedContractFiles]
      .filter(([path]) => path.startsWith('artifacts/protocol-1.0/'))
      .map(([path, content]) => [path.slice('artifacts/protocol-1.0/'.length), content]))
    const packedArtifacts = validateContractArtifactFiles(packedArtifactFiles, approvedCommit)
    assert.equal(packedArtifacts.manifest.contractCommit, manifest.contractCommit)
    assert.equal(
      JSON.parse(packedArtifactFiles.get('state-and-actors.json')).contractCommit,
      approvedCommit
    )
    assert.equal(
      JSON.parse(await readFile(join(
        repositoryRoot,
        'packages/collaboration-contracts/artifacts/protocol-1.0/ARTIFACT_MANIFEST.json'
      ), 'utf8')).contractCommit,
      '__SCIFORGE_COLLABORATION_COMMIT__'
    )

    const checksumLines = (await readFile(join(outputDirectory, 'SHA256SUMS'), 'utf8')).trim().split('\n')
    assert.equal(checksumLines.length, 7)
    assert.equal(harness.calls.filter(({ args }) => (
      args[0] === 'scripts/collaboration-providers.mjs' && args[1] === '--check'
    )).length, 1)
    assert.equal(harness.calls.filter(({ args }) => args.includes('run') && args.includes('build')).length, 3)
    assert.equal(harness.calls.filter(({ args }) => args[0] === 'pack').length, 3)
    const contractsPackCall = harness.calls.find(({ args }) => (
      args[0] === 'pack' && !args.includes('--workspace')
    ))
    assert.ok(contractsPackCall)
    assert.match(contractsPackCall.args[1], /\.collaboration-contracts-package$/u)
    assert.deepEqual(harness.calls.find(({ args }) => args[0] === 'merge-base')?.args, [
      'merge-base', '--is-ancestor', approvedCommit, 'origin/gui'
    ])
    const installCalls = harness.calls.filter(({ args }) => args[0] === 'install')
    assert.equal(installCalls.length, 1)
    assert.equal(installCalls[0].args.filter((argument) => argument === 'install').length, 1)
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true })
  }
})

test('builder fails closed when the packed contract provenance or artifact hash is changed', async () => {
  for (const [tamperContractArchive, expectedError] of [
    ['commit', /manifest commit does not match the release commit/u],
    ['hash', /SHA-256 mismatch/u]
  ]) {
    const repositoryRoot = await createRepository()
    const outputDirectory = join(repositoryRoot, `tampered-${tamperContractArchive}`)
    try {
      await assert.rejects(buildCollaborationServerBundle({
        ...testBundleDependencies,
        commit: approvedCommit,
        outputDirectory,
        repositoryRoot,
        runCommand: createCommandHarness({ tamperContractArchive }).runCommand
      }), expectedError)
      const leftovers = (await readdir(repositoryRoot)).filter((entry) => (
        entry.startsWith('.collaboration-bundle-tmp-')
      ))
      assert.deepEqual(leftovers, [])
      await assert.rejects(readFile(join(outputDirectory, 'RELEASE_MANIFEST.json')), /ENOENT/u)
    } finally {
      await rm(repositoryRoot, { recursive: true, force: true })
    }
  }
})

test('private test release is explicit, records its base, and checks ancestry in the safe direction', async () => {
  const repositoryRoot = await createRepository()
  const outputDirectory = join(repositoryRoot, 'private-test-release')
  const messages = []
  const harness = createCommandHarness({
    headCommit: privateTestCommit,
    isAncestor: (ancestor, descendant) => (
      ancestor === approvedCommit && descendant === privateTestCommit
    ),
    originGuiCommit: approvedCommit
  })
  try {
    const result = await buildCollaborationServerBundle({
      ...testBundleDependencies,
      commit: privateTestCommit,
      log: (message) => messages.push(message),
      outputDirectory,
      privateTestRelease: true,
      repositoryRoot,
      runCommand: harness.runCommand
    })
    assert.equal(result.commit, privateTestCommit)
    assert.equal(await readFile(join(outputDirectory, 'CONTRACT_COMMIT'), 'utf8'), `${privateTestCommit}\n`)

    const manifest = JSON.parse(await readFile(join(outputDirectory, 'RELEASE_MANIFEST.json'), 'utf8'))
    assert.equal(manifest.contractCommit, privateTestCommit)
    assert.equal(manifest.releaseMode, 'private-test')
    assert.equal(manifest.baseCommit, approvedCommit)
    assert.match(messages.join('\n'), /TEST-ONLY PRIVATE RELEASE/u)
    assert.match(messages.join('\n'), /never publish as production/u)

    assert.deepEqual(harness.calls.find(({ args }) => args[0] === 'merge-base')?.args, [
      'merge-base', '--is-ancestor', approvedCommit, privateTestCommit
    ])
    assert.deepEqual(harness.calls.find(({ args }) => (
      args[0] === 'rev-parse' && args[2] === 'origin/gui^{commit}'
    ))?.args, ['rev-parse', '--verify', 'origin/gui^{commit}'])
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true })
  }
})

test('team private acceptance is explicit and records commit, base, mode, and tunnel boundary', async () => {
  const repositoryRoot = await createRepository()
  const outputDirectory = join(repositoryRoot, 'team-private-acceptance')
  const messages = []
  const harness = createCommandHarness({
    headCommit: privateTestCommit,
    isAncestor: (ancestor, descendant) => (
      ancestor === approvedCommit && descendant === privateTestCommit
    ),
    originGuiCommit: approvedCommit
  })
  try {
    const result = await buildCollaborationServerBundle({
      ...testBundleDependencies,
      commit: privateTestCommit,
      log: (message) => messages.push(message),
      outputDirectory,
      repositoryRoot,
      runCommand: harness.runCommand,
      teamPrivateAcceptance: true
    })
    assert.equal(result.commit, privateTestCommit)
    const manifest = JSON.parse(await readFile(join(outputDirectory, 'RELEASE_MANIFEST.json'), 'utf8'))
    assert.equal(manifest.contractCommit, privateTestCommit)
    assert.equal(manifest.baseCommit, approvedCommit)
    assert.equal(manifest.releaseMode, 'team-private-acceptance')
    assert.equal(manifest.deploymentBoundary, 'loopback-ssh-tunnel-only')
    assert.match(messages.join('\n'), /TEAM-PRIVATE ACCEPTANCE/u)
    assert.match(messages.join('\n'), /loopback \+ SSH tunnel only/u)
    assert.deepEqual(harness.calls.find(({ args }) => args[0] === 'merge-base')?.args, [
      'merge-base', '--is-ancestor', approvedCommit, privateTestCommit
    ])
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true })
  }
})

test('production and private test releases reject the opposite or missing ancestry', async () => {
  const repositoryRoot = await createRepository()
  try {
    const featureDescendsFromGui = (ancestor, descendant) => (
      ancestor === approvedCommit && descendant === privateTestCommit
    )
    await assert.rejects(buildCollaborationServerBundle({
      commit: privateTestCommit,
      outputDirectory: join(repositoryRoot, 'must-not-be-production'),
      repositoryRoot,
      runCommand: createCommandHarness({
        headCommit: privateTestCommit,
        isAncestor: featureDescendsFromGui
      }).runCommand
    }), /simulated non-ancestor/u)

    await assert.rejects(buildCollaborationServerBundle({
      commit: privateTestCommit,
      outputDirectory: join(repositoryRoot, 'unrelated-private-test'),
      privateTestRelease: true,
      repositoryRoot,
      runCommand: createCommandHarness({
        headCommit: privateTestCommit,
        isAncestor: () => false
      }).runCommand
    }), /must descend from the current origin\/gui/u)

    await assert.rejects(buildCollaborationServerBundle({
      commit: privateTestCommit,
      outputDirectory: join(repositoryRoot, 'short-base-private-test'),
      privateTestRelease: true,
      repositoryRoot,
      runCommand: createCommandHarness({
        headCommit: privateTestCommit,
        originGuiCommit: approvedCommit.slice(0, 12)
      }).runCommand
    }), /complete 40-character/u)

    await assert.rejects(buildCollaborationServerBundle({
      commit: approvedCommit,
      outputDirectory: join(repositoryRoot, 'mismatched-private-test-head'),
      privateTestRelease: true,
      repositoryRoot,
      runCommand: createCommandHarness({ headCommit: privateTestCommit }).runCommand
    }), /must equal the currently checked out HEAD/u)

    await assert.rejects(buildCollaborationServerBundle({
      privateTestRelease: 'true',
      repositoryRoot,
      runCommand: createCommandHarness().runCommand
    }), /must be an explicit boolean/u)
    await assert.rejects(buildCollaborationServerBundle({
      teamPrivateAcceptance: 'true',
      repositoryRoot,
      runCommand: createCommandHarness().runCommand
    }), /must be an explicit boolean/u)
    await assert.rejects(buildCollaborationServerBundle({
      privateTestRelease: true,
      teamPrivateAcceptance: true,
      repositoryRoot,
      runCommand: createCommandHarness().runCommand
    }), /mutually exclusive/u)
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true })
  }
})

test('builder refuses dirty or non-empty targets and cleans failed staging directories', async () => {
  const repositoryRoot = await createRepository()
  try {
    const dirtyHarness = createCommandHarness({ dirty: true })
    await assert.rejects(buildCollaborationServerBundle({
      repositoryRoot,
      runCommand: dirtyHarness.runCommand
    }), /clean worktree/u)

    await assert.rejects(buildCollaborationServerBundle({
      commit: privateTestCommit,
      privateTestRelease: true,
      repositoryRoot,
      runCommand: createCommandHarness({
        dirty: true,
        headCommit: privateTestCommit
      }).runCommand
    }), /clean worktree/u)

    const nonEmptyOutput = join(repositoryRoot, 'existing-release')
    await mkdir(nonEmptyOutput)
    await writeFile(join(nonEmptyOutput, 'keep.txt'), 'do not replace')
    await assert.rejects(buildCollaborationServerBundle({
      outputDirectory: nonEmptyOutput,
      repositoryRoot,
      runCommand: createCommandHarness().runCommand
    }), /Refusing to overwrite non-empty/u)
    assert.equal(await readFile(join(nonEmptyOutput, 'keep.txt'), 'utf8'), 'do not replace')

    const failedOutput = join(repositoryRoot, 'failed-release')
    await assert.rejects(buildCollaborationServerBundle({
      ...testBundleDependencies,
      outputDirectory: failedOutput,
      repositoryRoot,
      runCommand: createCommandHarness({
        failPacking: '@sciforge/collaboration-provider-zulip'
      }).runCommand
    }), /simulated pack failure/u)
    const leftovers = (await readdir(repositoryRoot)).filter((entry) => (
      entry.startsWith('.collaboration-bundle-tmp-')
    ))
    assert.deepEqual(leftovers, [])
    await assert.rejects(readFile(join(failedOutput, 'RELEASE_MANIFEST.json')), /ENOENT/u)
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true })
  }
})

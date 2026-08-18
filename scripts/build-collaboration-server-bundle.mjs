#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import {
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rmdir,
  rm,
  writeFile
} from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const defaultRepositoryRoot = resolve(scriptDirectory, '..')
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const gitCommand = process.platform === 'win32' ? 'git.exe' : 'git'
const manifestFilename = 'RELEASE_MANIFEST.json'
const collaborationContractsPackageName = '@sciforge/collaboration-contracts'
const contractArtifactPrefix = 'artifacts/protocol-1.0/'
const contractArtifactManifestFilename = 'ARTIFACT_MANIFEST.json'
const contractCommitPlaceholder = '__SCIFORGE_COLLABORATION_COMMIT__'
const maximumUnpackedArchiveBytes = 128 * 1024 * 1024
const tarBlockBytes = 512

export const COLLABORATION_RELEASE_PACKAGES = Object.freeze([
  Object.freeze({
    directory: 'packages/collaboration-contracts',
    name: collaborationContractsPackageName,
    requiredFiles: Object.freeze([
      'package.json',
      `${contractArtifactPrefix}${contractArtifactManifestFilename}`
    ]),
    requiredPrefixes: Object.freeze(['dist/', contractArtifactPrefix])
  }),
  Object.freeze({
    directory: 'packages/collaboration-provider-zulip',
    name: '@sciforge/collaboration-provider-zulip',
    requiredFiles: Object.freeze(['package.json', 'README.md', 'sciforge.provider.json']),
    requiredPrefixes: Object.freeze(['dist/'])
  }),
  Object.freeze({
    directory: 'packages/collaboration-server',
    name: '@sciforge/collaboration-server',
    requiredFiles: Object.freeze(['package.json', 'README.md', '.env.example']),
    requiredPrefixes: Object.freeze(['dist/', 'migrations/', 'deploy/'])
  })
])

function usage() {
  return [
    'Usage: node scripts/build-collaboration-server-bundle.mjs [options]',
    '',
    'Options:',
    '  --commit <40-char-sha>  Approved origin/gui commit (defaults to clean HEAD).',
    '  --output <directory>    Bundle destination (must be absent or empty).',
    '  --private-test-release  TEST-ONLY: allow a clean HEAD descended from origin/gui.',
    '  --team-private-acceptance  TEAM-ONLY: clean descendant for loopback/tunnel acceptance.',
    '  -h, --help              Show this help.',
    ''
  ].join('\n')
}

export function parseArguments(argv) {
  const result = { help: false, privateTestRelease: false, teamPrivateAcceptance: false }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') {
      result.help = true
      continue
    }
    if (argument === '--private-test-release') {
      if (result.privateTestRelease) {
        throw new Error('--private-test-release may only be provided once.')
      }
      result.privateTestRelease = true
      continue
    }
    if (argument === '--team-private-acceptance') {
      if (result.teamPrivateAcceptance) {
        throw new Error('--team-private-acceptance may only be provided once.')
      }
      result.teamPrivateAcceptance = true
      continue
    }
    if (argument !== '--commit' && argument !== '--output') {
      throw new Error(`Unknown argument: ${argument}`)
    }
    const value = argv[index + 1]
    if (!value || value.startsWith('-')) {
      throw new Error(`Missing value for ${argument}.`)
    }
    index += 1
    const property = argument === '--commit' ? 'commit' : 'outputDirectory'
    if (result[property]) throw new Error(`${argument} may only be provided once.`)
    result[property] = value
  }
  if (result.privateTestRelease && result.teamPrivateAcceptance) {
    throw new Error('Private release modes are mutually exclusive.')
  }
  return result
}

export function assertFullCommit(commit) {
  if (!/^[0-9a-f]{40}$/iu.test(commit)) {
    throw new Error('The release commit must be a complete 40-character Git SHA.')
  }
  return commit.toLowerCase()
}

function normalizePackPath(path) {
  if (typeof path !== 'string' || path.length === 0 || path.includes('\\')) {
    throw new Error('npm pack returned an invalid file path.')
  }
  const normalized = path.startsWith('package/') ? path.slice('package/'.length) : path
  if (
    normalized.length === 0 ||
    normalized.startsWith('/') ||
    normalized.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error(`npm pack returned an unsafe file path: ${path}`)
  }
  return normalized
}

function isEnvironmentSecretPath(path) {
  const filename = basename(path).toLowerCase()
  if (filename.endsWith('.env.example')) return false
  return filename === '.env' || filename.endsWith('.env') || filename.includes('.env.')
}

function forbiddenPackPathReason(path) {
  const lower = path.toLowerCase()
  const segments = lower.split('/')
  const filename = segments.at(-1)

  if (isEnvironmentSecretPath(path)) return 'environment file'
  if (filename === '.npmrc' || filename === '.yarnrc' || filename === '.pypirc') {
    return 'package-manager credential file'
  }
  if (segments.some((segment) => /^(?:src|source|sources|test|tests|__tests__)$/u.test(segment))) {
    return 'source or test tree'
  }
  if (segments.some((segment) => /(?:^|[-_.])secrets?(?:$|[-_.])/u.test(segment))) {
    return 'secret path'
  }
  if (segments.some((segment) => /^(?:log|logs)$/u.test(segment)) || /\.log(?:\.|$)/u.test(filename)) {
    return 'log path'
  }
  if (/\.map$/u.test(filename) && !lower.startsWith('dist/')) return 'source map outside dist'
  if (/\.(?:pem|key|p12|pfx|jks|keystore)$/u.test(filename)) {
    return 'credential material'
  }
  if (
    /\.(?:ts|tsx|mts|cts|jsx)$/u.test(filename) &&
    !/\.d\.(?:ts|mts|cts)$/u.test(filename)
  ) {
    return 'source file'
  }
  if (/(?:^|[.-])(?:test|spec)\.[cm]?[jt]sx?$/u.test(filename)) return 'test file'
  return undefined
}

export function validatePackManifest(packageSpecification, packed) {
  if (!packed || typeof packed !== 'object') throw new Error('npm pack returned no package metadata.')
  if (packed.name !== packageSpecification.name) {
    throw new Error(`npm pack returned ${String(packed.name)} for ${packageSpecification.name}.`)
  }
  if (typeof packed.version !== 'string' || packed.version.length === 0) {
    throw new Error(`npm pack omitted the version for ${packageSpecification.name}.`)
  }
  if (!Array.isArray(packed.files) || packed.files.length === 0) {
    throw new Error(`npm pack omitted the file manifest for ${packageSpecification.name}.`)
  }
  if (
    typeof packed.filename !== 'string' ||
    packed.filename !== basename(packed.filename) ||
    !packed.filename.endsWith('.tgz')
  ) {
    throw new Error(`npm pack returned an unsafe archive name for ${packageSpecification.name}.`)
  }

  const files = packed.files.map((entry) => normalizePackPath(entry?.path))
  for (const path of files) {
    const reason = forbiddenPackPathReason(path)
    if (reason) {
      throw new Error(`${packageSpecification.name} archive contains forbidden ${reason}: ${path}`)
    }
  }

  const fileSet = new Set(files)
  for (const requiredFile of packageSpecification.requiredFiles) {
    if (!fileSet.has(requiredFile)) {
      throw new Error(`${packageSpecification.name} archive is missing ${requiredFile}.`)
    }
  }
  for (const requiredPrefix of packageSpecification.requiredPrefixes) {
    if (!files.some((path) => path.startsWith(requiredPrefix))) {
      throw new Error(`${packageSpecification.name} archive is missing ${requiredPrefix}.`)
    }
  }

  return Object.freeze({
    filename: packed.filename,
    files: Object.freeze(files),
    name: packed.name,
    version: packed.version
  })
}

export async function sha256File(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function sha256Content(content) {
  return createHash('sha256').update(content).digest('hex')
}

function parseJson(content, label) {
  try {
    return JSON.parse(Buffer.isBuffer(content) ? content.toString('utf8') : content)
  } catch {
    throw new Error(`${label} is not valid JSON.`)
  }
}

function collectContractCommits(value, commits = []) {
  if (Array.isArray(value)) {
    for (const nested of value) collectContractCommits(nested, commits)
    return commits
  }
  if (value === null || typeof value !== 'object') return commits
  for (const [key, nested] of Object.entries(value)) {
    if (key === 'contractCommit') commits.push(nested)
    collectContractCommits(nested, commits)
  }
  return commits
}

export function validateContractArtifactFiles(files, expectedCommitInput) {
  const expectedCommit = assertFullCommit(expectedCommitInput)
  if (!(files instanceof Map)) {
    throw new Error('Generated collaboration contract artifacts must be a Map.')
  }

  const normalizedFiles = new Map()
  for (const [relativePath, content] of files) {
    const normalizedPath = normalizePackPath(relativePath)
    if (normalizedPath !== relativePath || !normalizedPath.endsWith('.json')) {
      throw new Error(`Contract artifact has an invalid path: ${String(relativePath)}`)
    }
    if (normalizedFiles.has(normalizedPath)) {
      throw new Error(`Contract artifact path is duplicated: ${normalizedPath}`)
    }
    if (typeof content !== 'string' && !Buffer.isBuffer(content)) {
      throw new Error(`Contract artifact is not text: ${normalizedPath}`)
    }
    normalizedFiles.set(normalizedPath, Buffer.from(content))
  }

  const manifestContent = normalizedFiles.get(contractArtifactManifestFilename)
  if (!manifestContent) {
    throw new Error(`Contract artifacts are missing ${contractArtifactManifestFilename}.`)
  }
  const manifest = parseJson(manifestContent, contractArtifactManifestFilename)
  if (manifest?.contractCommit !== expectedCommit) {
    throw new Error('Contract artifact manifest commit does not match the release commit.')
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error('Contract artifact manifest has no file inventory.')
  }

  const describedPaths = new Set()
  for (const entry of manifest.files) {
    const relativePath = normalizePackPath(entry?.path)
    if (relativePath !== entry.path || relativePath === contractArtifactManifestFilename) {
      throw new Error(`Contract artifact manifest has an invalid file path: ${String(entry?.path)}`)
    }
    if (describedPaths.has(relativePath)) {
      throw new Error(`Contract artifact manifest duplicates ${relativePath}.`)
    }
    describedPaths.add(relativePath)
    const content = normalizedFiles.get(relativePath)
    if (!content) throw new Error(`Contract artifact manifest references missing ${relativePath}.`)
    if (!/^[0-9a-f]{64}$/u.test(entry.sha256)) {
      throw new Error(`Contract artifact manifest has an invalid SHA-256 for ${relativePath}.`)
    }
    if (entry.sha256 !== sha256Content(content)) {
      throw new Error(`Contract artifact SHA-256 mismatch for ${relativePath}.`)
    }
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes !== content.byteLength) {
      throw new Error(`Contract artifact byte count mismatch for ${relativePath}.`)
    }
  }

  const actualPaths = [...normalizedFiles.keys()]
    .filter((relativePath) => relativePath !== contractArtifactManifestFilename)
    .sort()
  if (JSON.stringify(actualPaths) !== JSON.stringify([...describedPaths].sort())) {
    throw new Error('Contract artifact package contains an unlisted file.')
  }

  for (const [relativePath, content] of normalizedFiles) {
    const document = parseJson(content, relativePath)
    const commits = collectContractCommits(document)
    if (commits.length === 0 || commits.some((commit) => commit !== expectedCommit)) {
      throw new Error(`Contract artifact commit provenance mismatch for ${relativePath}.`)
    }
    if (
      relativePath !== contractArtifactManifestFilename &&
      content.includes(Buffer.from(contractCommitPlaceholder))
    ) {
      throw new Error(`Contract artifact still contains the source commit placeholder: ${relativePath}`)
    }
  }

  return Object.freeze({ manifest, files: normalizedFiles })
}

function readTarString(header, offset, length) {
  const field = header.subarray(offset, offset + length)
  const end = field.indexOf(0)
  return field.subarray(0, end === -1 ? field.length : end).toString('utf8')
}

function readTarOctal(header, offset, length, label) {
  const field = readTarString(header, offset, length).trim()
  if (!/^[0-7]+$/u.test(field)) throw new Error(`Packed archive has an invalid ${label}.`)
  const value = Number.parseInt(field, 8)
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Packed archive has an unsafe ${label}.`)
  }
  return value
}

function isZeroBlock(block) {
  return block.every((byte) => byte === 0)
}

function verifyTarHeaderChecksum(header) {
  const expected = readTarOctal(header, 148, 8, 'header checksum')
  let actual = 0
  for (let index = 0; index < header.length; index += 1) {
    actual += index >= 148 && index < 156 ? 32 : header[index]
  }
  if (actual !== expected) throw new Error('Packed archive has an invalid header checksum.')
}

export async function readNpmPackageArchiveFiles(path) {
  let archive
  try {
    archive = gunzipSync(await readFile(path), { maxOutputLength: maximumUnpackedArchiveBytes })
  } catch (error) {
    throw new Error('Unable to safely decompress the packed npm archive.', { cause: error })
  }
  if (archive.length === 0 || archive.length % tarBlockBytes !== 0) {
    throw new Error('Packed npm archive is not a complete tar stream.')
  }

  const files = new Map()
  let offset = 0
  let terminated = false
  while (offset < archive.length) {
    const header = archive.subarray(offset, offset + tarBlockBytes)
    if (isZeroBlock(header)) {
      const secondEndBlock = archive.subarray(offset + tarBlockBytes, offset + (2 * tarBlockBytes))
      if (secondEndBlock.length !== tarBlockBytes || !isZeroBlock(secondEndBlock)) {
        throw new Error('Packed npm archive has an incomplete end marker.')
      }
      if (!isZeroBlock(archive.subarray(offset))) {
        throw new Error('Packed npm archive contains data after its end marker.')
      }
      terminated = true
      break
    }

    verifyTarHeaderChecksum(header)
    if (!readTarString(header, 257, 6).startsWith('ustar')) {
      throw new Error('Packed npm archive is not in the supported USTAR format.')
    }
    const name = readTarString(header, 0, 100)
    const prefix = readTarString(header, 345, 155)
    const archivePath = prefix ? `${prefix}/${name}` : name
    if (!archivePath.startsWith('package/')) {
      throw new Error(`Packed npm archive has an invalid root path: ${archivePath}`)
    }
    const normalizedPath = normalizePackPath(archivePath)
    const size = readTarOctal(header, 124, 12, 'entry size')
    const type = header[156]
    if (type !== 0 && type !== 48) {
      throw new Error(`Packed npm archive contains a non-regular entry: ${normalizedPath}`)
    }
    const contentStart = offset + tarBlockBytes
    const contentEnd = contentStart + size
    if (contentEnd > archive.length) {
      throw new Error(`Packed npm archive truncates ${normalizedPath}.`)
    }
    if (files.has(normalizedPath)) {
      throw new Error(`Packed npm archive duplicates ${normalizedPath}.`)
    }
    files.set(normalizedPath, Buffer.from(archive.subarray(contentStart, contentEnd)))
    offset = contentStart + Math.ceil(size / tarBlockBytes) * tarBlockBytes
  }
  if (!terminated) throw new Error('Packed npm archive has no end marker.')
  return files
}

async function verifyPackedPackageArchive(archivePath, packed, specification, expectedCommit) {
  const files = await readNpmPackageArchiveFiles(archivePath)
  const actualPaths = [...files.keys()].sort()
  if (JSON.stringify(actualPaths) !== JSON.stringify([...packed.files].sort())) {
    throw new Error(`${specification.name} archive does not match the npm pack file manifest.`)
  }

  const packageJsonContent = files.get('package.json')
  if (!packageJsonContent) throw new Error(`${specification.name} archive is missing package.json.`)
  const packageJson = parseJson(packageJsonContent, `${specification.name} package.json`)
  if (packageJson.name !== packed.name || packageJson.version !== packed.version) {
    throw new Error(`${specification.name} archive package identity does not match npm pack metadata.`)
  }

  if (specification.name === collaborationContractsPackageName) {
    const artifactFiles = new Map([...files]
      .filter(([relativePath]) => relativePath.startsWith(contractArtifactPrefix))
      .map(([relativePath, content]) => [relativePath.slice(contractArtifactPrefix.length), content]))
    validateContractArtifactFiles(artifactFiles, expectedCommit)
  }
}

async function defaultGenerateContractArtifactFiles(commit) {
  const { tsImport } = await import('tsx/esm/api')
  const artifacts = await tsImport('./collaboration-contract-artifacts.mjs', import.meta.url)
  return artifacts.generateContractArtifactFiles(commit)
}

async function stageCollaborationContractsPackage({
  commit,
  generateContractArtifactFiles,
  repositoryRoot,
  stagingDirectory
}) {
  const sourceDirectory = join(repositoryRoot, 'packages/collaboration-contracts')
  const packageDirectory = join(stagingDirectory, '.collaboration-contracts-package')
  await mkdir(packageDirectory)
  await copyFile(join(sourceDirectory, 'package.json'), join(packageDirectory, 'package.json'))
  await cp(join(sourceDirectory, 'dist'), join(packageDirectory, 'dist'), { recursive: true })

  const generatedFiles = await generateContractArtifactFiles(commit)
  const validated = validateContractArtifactFiles(generatedFiles, commit)
  const artifactDirectory = join(packageDirectory, contractArtifactPrefix)
  for (const [relativePath, content] of validated.files) {
    const destination = join(artifactDirectory, relativePath)
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, content, { mode: 0o644 })
  }
  return packageDirectory
}

async function defaultRunCommand({ command, args, cwd }) {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        NPM_CONFIG_CACHE: process.env.NPM_CONFIG_CACHE || join(tmpdir(), 'sciforge-a-npm-cache')
      },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const stdout = []
    const stderr = []
    let capturedBytes = 0
    const maximumCapturedBytes = 16 * 1024 * 1024
    const capture = (target) => (chunk) => {
      capturedBytes += chunk.length
      if (capturedBytes > maximumCapturedBytes) {
        child.kill('SIGKILL')
        return
      }
      target.push(chunk)
    }
    child.stdout.on('data', capture(stdout))
    child.stderr.on('data', capture(stderr))
    child.once('error', (error) => rejectPromise(new Error(`Unable to run ${command}: ${error.message}`)))
    child.once('close', (code, signal) => {
      if (capturedBytes > maximumCapturedBytes) {
        rejectPromise(new Error(`${command} produced more than 16 MiB of output.`))
        return
      }
      if (code !== 0) {
        const termination = signal ? `signal ${signal}` : `exit code ${String(code)}`
        rejectPromise(new Error(`${command} ${args[0] ?? ''} failed with ${termination}.`))
        return
      }
      resolvePromise({
        stderr: Buffer.concat(stderr).toString('utf8'),
        stdout: Buffer.concat(stdout).toString('utf8')
      })
    })
  })
}

async function outputDirectoryState(path) {
  try {
    const details = await lstat(path)
    if (!details.isDirectory()) throw new Error(`Bundle output is not a directory: ${path}`)
    if ((await readdir(path)).length > 0) {
      throw new Error(`Refusing to overwrite non-empty bundle output: ${path}`)
    }
    return 'empty'
  } catch (error) {
    if (error?.code === 'ENOENT') return 'missing'
    throw error
  }
}

async function readWorkspacePackages(repositoryRoot) {
  const packages = []
  for (const specification of COLLABORATION_RELEASE_PACKAGES) {
    const packageJson = JSON.parse(await readFile(
      join(repositoryRoot, specification.directory, 'package.json'),
      'utf8'
    ))
    if (packageJson.name !== specification.name) {
      throw new Error(`${specification.directory} does not contain ${specification.name}.`)
    }
    if (typeof packageJson.version !== 'string' || packageJson.version.length === 0) {
      throw new Error(`${specification.name} does not declare a version.`)
    }
    packages.push({ packageJson, specification })
  }
  return packages
}

function parsePackOutput(stdout, packageName) {
  let parsed
  try {
    parsed = JSON.parse(stdout.trim())
  } catch {
    throw new Error(`npm pack returned invalid JSON for ${packageName}.`)
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error(`npm pack did not produce exactly one archive for ${packageName}.`)
  }
  return parsed[0]
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o644 })
}

async function assertGeneratedLock(stagingDirectory, dependencies) {
  const lock = JSON.parse(await readFile(join(stagingDirectory, 'package-lock.json'), 'utf8'))
  if (lock?.packages?.['']?.dependencies === undefined) {
    throw new Error('npm did not generate a root dependency lock.')
  }
  for (const [name, expected] of Object.entries(dependencies)) {
    if (lock.packages[''].dependencies[name] !== expected) {
      throw new Error(`package-lock.json did not pin ${name} to its release archive.`)
    }
  }
  return lock
}

async function assertBundleFileSet(stagingDirectory, expectedFilenames) {
  const entries = await readdir(stagingDirectory, { withFileTypes: true })
  const actualFilenames = entries.map((entry) => entry.name).sort()
  if (entries.some((entry) => !entry.isFile())) {
    throw new Error('Release bundle may only contain immutable files.')
  }
  const expected = [...expectedFilenames].sort()
  if (JSON.stringify(actualFilenames) !== JSON.stringify(expected)) {
    throw new Error('Release bundle contains an unexpected file.')
  }
}

export async function buildCollaborationServerBundle({
  commit,
  generateContractArtifactFiles = defaultGenerateContractArtifactFiles,
  log = () => {},
  outputDirectory,
  privateTestRelease = false,
  teamPrivateAcceptance = false,
  repositoryRoot = defaultRepositoryRoot,
  runCommand = defaultRunCommand
} = {}) {
  if (typeof privateTestRelease !== 'boolean') {
    throw new Error('privateTestRelease must be an explicit boolean.')
  }
  if (typeof teamPrivateAcceptance !== 'boolean') {
    throw new Error('teamPrivateAcceptance must be an explicit boolean.')
  }
  if (privateTestRelease && teamPrivateAcceptance) {
    throw new Error('Private release modes are mutually exclusive.')
  }
  if (typeof generateContractArtifactFiles !== 'function') {
    throw new Error('generateContractArtifactFiles must be a function.')
  }
  const privateFeatureRelease = privateTestRelease || teamPrivateAcceptance
  const root = resolve(repositoryRoot)
  const headResult = await runCommand({
    command: gitCommand,
    args: ['rev-parse', '--verify', 'HEAD^{commit}'],
    cwd: root
  })
  const head = assertFullCommit(headResult.stdout.trim())
  const approvedCommit = assertFullCommit(commit ?? head)
  if (approvedCommit !== head) {
    throw new Error('The approved release commit must equal the currently checked out HEAD.')
  }

  const statusResult = await runCommand({
    command: gitCommand,
    args: ['status', '--porcelain=v1', '--untracked-files=all'],
    cwd: root
  })
  if (statusResult.stdout.trim().length > 0) {
    throw new Error('The collaboration release must be built from a clean worktree.')
  }
  let baseCommit
  if (privateFeatureRelease) {
    const baseResult = await runCommand({
      command: gitCommand,
      args: ['rev-parse', '--verify', 'origin/gui^{commit}'],
      cwd: root
    })
    baseCommit = assertFullCommit(baseResult.stdout.trim())
    try {
      await runCommand({
        command: gitCommand,
        args: ['merge-base', '--is-ancestor', baseCommit, approvedCommit],
        cwd: root
      })
    } catch (error) {
      throw new Error(
        `${teamPrivateAcceptance ? 'Team private acceptance' : 'Private test release'} HEAD must descend from the current origin/gui commit.`,
        { cause: error }
      )
    }
  } else {
    await runCommand({
      command: gitCommand,
      args: ['merge-base', '--is-ancestor', approvedCommit, 'origin/gui'],
      cwd: root
    })
  }

  const destination = resolve(
    root,
    outputDirectory ?? join('dist', `collaboration-server-bundle-${approvedCommit.slice(0, 12)}`)
  )
  const destinationState = await outputDirectoryState(destination)
  const destinationParent = dirname(destination)
  await mkdir(destinationParent, { recursive: true })
  const stagingDirectory = await mkdtemp(join(destinationParent, '.collaboration-bundle-tmp-'))
  let published = false

  try {
    if (teamPrivateAcceptance) {
      log('*** TEAM-PRIVATE ACCEPTANCE: loopback + SSH tunnel only; never publish as production. ***')
      log(`Verified clean team acceptance commit ${approvedCommit} descends from origin/gui ${baseCommit}.`)
    } else if (privateTestRelease) {
      log('*** TEST-ONLY PRIVATE RELEASE: loopback-only A ECS; never publish as production. ***')
      log(`Verified clean feature commit ${approvedCommit} descends from origin/gui ${baseCommit}.`)
    } else {
      log(`Verified origin/gui release commit ${approvedCommit}.`)
    }
    const workspacePackages = await readWorkspacePackages(root)
    const packedPackages = []

    log('Checking collaboration provider composition.')
    await runCommand({
      command: process.execPath,
      args: ['scripts/collaboration-providers.mjs', '--check'],
      cwd: root
    })

    for (const { specification } of workspacePackages) {
      log(`Building ${specification.name}.`)
      await rm(join(root, specification.directory, 'dist'), { recursive: true, force: true })
      await runCommand({
        command: npmCommand,
        args: ['--workspace', specification.name, 'run', 'build'],
        cwd: root
      })
    }

    log(`Generating ${collaborationContractsPackageName} artifacts for ${approvedCommit}.`)
    const contractsPackageDirectory = await stageCollaborationContractsPackage({
      commit: approvedCommit,
      generateContractArtifactFiles,
      repositoryRoot: root,
      stagingDirectory
    })

    for (const { packageJson, specification } of workspacePackages) {
      log(`Packing ${specification.name}.`)
      const packageTarget = specification.name === collaborationContractsPackageName
        ? [contractsPackageDirectory]
        : ['--workspace', specification.name]
      const packResult = await runCommand({
        command: npmCommand,
        args: [
          'pack',
          ...packageTarget,
          '--json',
          '--ignore-scripts',
          '--pack-destination', stagingDirectory
        ],
        cwd: root
      })
      const packed = validatePackManifest(
        specification,
        parsePackOutput(packResult.stdout, specification.name)
      )
      if (packed.version !== packageJson.version) {
        throw new Error(`${specification.name} packed version does not match its package.json.`)
      }
      if (packedPackages.some((candidate) => candidate.filename === packed.filename)) {
        throw new Error(`npm pack produced duplicate archive name ${packed.filename}.`)
      }
      const archiveDetails = await lstat(join(stagingDirectory, packed.filename))
      if (!archiveDetails.isFile()) {
        throw new Error(`npm pack did not create a regular archive for ${specification.name}.`)
      }
      await verifyPackedPackageArchive(
        join(stagingDirectory, packed.filename),
        packed,
        specification,
        approvedCommit
      )
      packedPackages.push(packed)
    }
    await rm(contractsPackageDirectory, { recursive: true, force: true })

    const dependencies = Object.fromEntries(packedPackages.map((packed) => [
      packed.name,
      `file:./${packed.filename}`
    ]))
    const serverPackage = workspacePackages.find(({ specification }) => (
      specification.name === '@sciforge/collaboration-server'
    )).packageJson
    const bundlePackageJson = {
      name: '@sciforge/collaboration-server-release',
      version: serverPackage.version,
      private: true,
      description: 'Immutable SciForge collaboration server release bundle.',
      engines: { node: '>=22.12.0' },
      scripts: {
        migrate: 'sciforge-collaboration-server migrate',
        start: 'sciforge-collaboration-server'
      },
      dependencies
    }
    await writeJson(join(stagingDirectory, 'package.json'), bundlePackageJson)
    await runCommand({
      command: npmCommand,
      args: [
        'install',
        '--package-lock-only',
        '--ignore-scripts',
        '--omit=dev',
        '--no-audit',
        '--no-fund'
      ],
      cwd: stagingDirectory
    })
    const lock = await assertGeneratedLock(stagingDirectory, dependencies)
    await writeFile(join(stagingDirectory, 'CONTRACT_COMMIT'), `${approvedCommit}\n`, {
      encoding: 'utf8',
      mode: 0o644
    })

    const releasePackages = []
    for (const packed of packedPackages) {
      releasePackages.push({
        name: packed.name,
        version: packed.version,
        filename: packed.filename,
        sha256: await sha256File(join(stagingDirectory, packed.filename))
      })
    }
    const manifest = {
      schemaVersion: 1,
      artifact: 'sciforge-collaboration-server-bundle',
      contractCommit: approvedCommit,
      releaseMode: teamPrivateAcceptance
        ? 'team-private-acceptance'
        : privateTestRelease
          ? 'private-test'
          : 'origin-gui',
      ...(privateFeatureRelease ? { baseCommit } : {}),
      ...(teamPrivateAcceptance ? { deploymentBoundary: 'loopback-ssh-tunnel-only' } : {}),
      packageManager: {
        name: 'npm',
        lockfileVersion: lock.lockfileVersion
      },
      packages: releasePackages
    }
    await writeJson(join(stagingDirectory, manifestFilename), manifest)

    const checksumFilenames = [
      ...packedPackages.map((packed) => packed.filename),
      'CONTRACT_COMMIT',
      manifestFilename,
      'package-lock.json',
      'package.json'
    ].sort()
    const checksumLines = []
    for (const filename of checksumFilenames) {
      checksumLines.push(`${await sha256File(join(stagingDirectory, filename))}  ${filename}`)
    }
    await writeFile(join(stagingDirectory, 'SHA256SUMS'), `${checksumLines.join('\n')}\n`, {
      encoding: 'utf8',
      mode: 0o644
    })
    await assertBundleFileSet(stagingDirectory, [...checksumFilenames, 'SHA256SUMS'])

    if (destinationState === 'empty') await rmdir(destination)
    try {
      await rename(stagingDirectory, destination)
    } catch (error) {
      if (destinationState === 'empty') await mkdir(destination).catch(() => {})
      throw error
    }
    published = true
    log(teamPrivateAcceptance
      ? `Created TEAM-PRIVATE acceptance collaboration bundle at ${destination}.`
      : privateTestRelease
        ? `Created TEST-ONLY private collaboration bundle at ${destination}.`
        : `Created immutable collaboration release bundle at ${destination}.`)
    return Object.freeze({
      commit: approvedCommit,
      manifest,
      outputDirectory: destination
    })
  } finally {
    if (!published) await rm(stagingDirectory, { recursive: true, force: true })
  }
}

const invokedAsMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedAsMain) {
  try {
    const arguments_ = parseArguments(process.argv.slice(2))
    if (arguments_.help) {
      process.stdout.write(usage())
    } else {
      await buildCollaborationServerBundle({
        commit: arguments_.commit,
        log: (message) => process.stdout.write(`[collaboration-bundle] ${message}\n`),
        outputDirectory: arguments_.outputDirectory,
        privateTestRelease: arguments_.privateTestRelease,
        teamPrivateAcceptance: arguments_.teamPrivateAcceptance
      })
    }
  } catch (error) {
    process.stderr.write(`[collaboration-bundle] ${error instanceof Error ? error.message : 'Build failed.'}\n`)
    process.exitCode = 1
  }
}

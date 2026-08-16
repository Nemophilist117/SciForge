#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import {
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

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const defaultRepositoryRoot = resolve(scriptDirectory, '..')
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const gitCommand = process.platform === 'win32' ? 'git.exe' : 'git'
const manifestFilename = 'RELEASE_MANIFEST.json'

export const COLLABORATION_RELEASE_PACKAGES = Object.freeze([
  Object.freeze({
    directory: 'packages/collaboration-contracts',
    name: '@sciforge/collaboration-contracts',
    requiredFiles: Object.freeze(['package.json']),
    requiredPrefixes: Object.freeze(['dist/'])
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
    '  -h, --help              Show this help.',
    ''
  ].join('\n')
}

export function parseArguments(argv) {
  const result = { help: false, privateTestRelease: false }
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
  log = () => {},
  outputDirectory,
  privateTestRelease = false,
  repositoryRoot = defaultRepositoryRoot,
  runCommand = defaultRunCommand
} = {}) {
  if (typeof privateTestRelease !== 'boolean') {
    throw new Error('privateTestRelease must be an explicit boolean.')
  }
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
  if (privateTestRelease) {
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
        'Private test release HEAD must descend from the current origin/gui commit.',
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
    if (privateTestRelease) {
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

    for (const { packageJson, specification } of workspacePackages) {
      log(`Packing ${specification.name}.`)
      const packResult = await runCommand({
        command: npmCommand,
        args: [
          'pack',
          '--workspace', specification.name,
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
      packedPackages.push(packed)
    }

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
      releaseMode: privateTestRelease ? 'private-test' : 'origin-gui',
      ...(privateTestRelease ? { baseCommit } : {}),
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
    log(privateTestRelease
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
        privateTestRelease: arguments_.privateTestRelease
      })
    }
  } catch (error) {
    process.stderr.write(`[collaboration-bundle] ${error instanceof Error ? error.message : 'Build failed.'}\n`)
    process.exitCode = 1
  }
}

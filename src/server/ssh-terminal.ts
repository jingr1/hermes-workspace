/**
 * SSH terminal helpers for remote workspace browsing.
 *
 * Folder listing and file ops must run on the SSH target, not the Workspace host.
 */
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import {
  WorkspaceFolderAccessError,
  listWorkspaceFolders,
  type WorkspaceFolderEntry,
  type WorkspaceFolderListResponse,
} from './workspace-path-policy'
import {
  ensureRemoteWorkspacePath,
  remoteTerminalWorkspaceCandidate,
  type TerminalConfig,
} from './workspace-remote'
import {
  remoteWorkspaceContextForScope,
  workspaceProfileScope,
} from './workspace-profile'

export type SshTerminalConfig = {
  host: string
  user: string
  key: string
  port: number
  cwd: string
}

export type SshExecResult = {
  stdout: Buffer
  stderr: string
  code: number
}

export type SshRunner = (
  ssh: SshTerminalConfig,
  remoteArgv: string[],
  options?: { stdin?: Buffer | string; timeoutMs?: number },
) => Promise<SshExecResult>

const DEFAULT_TIMEOUT_MS = 15_000
const MAX_READ_BYTES = 2 * 1024 * 1024

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  '.turbo',
  '.cache',
  '__pycache__',
  '.venv',
  'dist',
  '.hermes',
])

export function readSshTerminalConfig(
  config: Record<string, unknown>,
): SshTerminalConfig | null {
  const terminal = config.terminal
  if (!terminal || typeof terminal !== 'object' || Array.isArray(terminal)) {
    return null
  }
  const t = terminal as TerminalConfig
  const backend = String(t.backend ?? '')
    .trim()
    .toLowerCase()
  if (backend !== 'ssh') return null
  const host = String(t.ssh_host ?? '').trim()
  const cwd = String(t.cwd ?? '').trim()
  if (!host || !cwd || cwd === '.') return null
  return {
    host,
    user: String(t.ssh_user ?? '').trim(),
    key: String(t.ssh_key ?? '').trim(),
    port: Number(t.ssh_port) || 22,
    cwd,
  }
}

function posixQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function buildRemoteSshCommand(argv: string[]): string {
  return argv.map(posixQuote).join(' ')
}

export function sshControlPath(ssh: SshTerminalConfig): string {
  const token = `${ssh.user || 'user'}@${ssh.host}:${ssh.port}`.replace(
    /[^A-Za-z0-9.@:_-]/g,
    '_',
  )
  return path.join(os.tmpdir(), `hermes-ws-ssh-${token}`)
}

export function buildSshArgs(ssh: SshTerminalConfig, remoteArgv: string[]): string[] {
  const args = [
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=8',
    '-o',
    'ConnectionAttempts=1',
    '-o',
    'ServerAliveInterval=5',
    '-o',
    'ServerAliveCountMax=2',
    // Reuse a Workspace-owned multiplex socket. Never inherit ~/.ssh/config
    // ControlPath, which can hang on a stale master.
    '-o',
    'ControlMaster=auto',
    '-o',
    `ControlPath=${sshControlPath(ssh)}`,
    '-o',
    'ControlPersist=120',
    '-o',
    'StrictHostKeyChecking=accept-new',
  ]
  if (ssh.key) {
    args.push('-i', ssh.key, '-o', 'IdentitiesOnly=yes')
  }
  if (ssh.port) args.push('-p', String(ssh.port))
  if (ssh.user) args.push('-l', ssh.user)
  // OpenSSH joins extra argv with spaces and runs them via the remote shell.
  // Pass one pre-quoted command so find/sh -c arguments stay intact.
  args.push(ssh.host, buildRemoteSshCommand(remoteArgv))
  return args
}

export async function defaultSshRunner(
  ssh: SshTerminalConfig,
  remoteArgv: string[],
  options?: { stdin?: Buffer | string; timeoutMs?: number },
): Promise<SshExecResult> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', buildSshArgs(ssh, remoteArgv), {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let settled = false

    const killChild = () => {
      try {
        child.kill('SIGKILL')
      } catch {
        // already exited
      }
      child.stdout.destroy()
      child.stderr.destroy()
      child.stdin.destroy()
    }

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      killChild()
      reject(new Error(`SSH timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk)
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        code: code ?? 1,
      })
    })

    if (options?.stdin !== undefined) {
      const payload =
        typeof options.stdin === 'string'
          ? Buffer.from(options.stdin, 'utf8')
          : options.stdin
      child.stdin.end(payload)
    } else {
      child.stdin.end()
    }
  })
}

let sshRunner: SshRunner = defaultSshRunner

export function setSshRunnerForTests(runner: SshRunner | null): void {
  sshRunner = runner ?? defaultSshRunner
}

async function runSsh(
  ssh: SshTerminalConfig,
  remoteArgv: string[],
  options?: { stdin?: Buffer | string; timeoutMs?: number },
): Promise<SshExecResult> {
  return sshRunner(ssh, remoteArgv, options)
}

function rejectUnsafeRemotePath(value: string): void {
  if (!value || value.includes('\0') || /[\n\r]/.test(value)) {
    throw new WorkspaceFolderAccessError(400, 'Invalid remote path')
  }
}

export function resolveRemoteListTarget(
  subPath: string,
  remoteCwd: string,
): string {
  const raw = subPath.trim()
  const target = raw
    ? raw.startsWith('/')
      ? raw
      : path.posix.join(remoteCwd, raw)
    : remoteCwd
  const normalized = remoteTerminalWorkspaceCandidate(target, remoteCwd)
  if (!normalized) {
    throw new WorkspaceFolderAccessError(403, 'Access denied')
  }
  return normalized
}

export async function listSshWorkspaceFolders(
  config: Record<string, unknown>,
  subPath = '',
): Promise<WorkspaceFolderListResponse> {
  const ssh = readSshTerminalConfig(config)
  if (!ssh) {
    throw new WorkspaceFolderAccessError(
      503,
      'SSH terminal is not configured on this profile',
    )
  }
  const target = resolveRemoteListTarget(subPath, ssh.cwd)
  rejectUnsafeRemotePath(target)

  // Prefer /bin/ls so aliases/bashrc wrappers cannot stall listing.
  const result = await runSsh(ssh, ['/bin/ls', '-1p', '--', target], {
    timeoutMs: 20_000,
  })
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `ssh exited ${result.code}`
    throw new WorkspaceFolderAccessError(
      502,
      `Cannot list remote folders: ${detail}`,
    )
  }

  let names = result.stdout
    .toString('utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.endsWith('/'))
    .map((line) => line.replace(/\/+$/, ''))
    .map((name) => path.posix.basename(name))
    .filter((name) => name && !name.startsWith('.'))

  if (names.length === 0) {
    const findResult = await runSsh(
      ssh,
      [
        '/usr/bin/find',
        target,
        '-mindepth',
        '1',
        '-maxdepth',
        '1',
        '-type',
        'd',
        '!',
        '-name',
        '.*',
        '-printf',
        '%f\\n',
      ],
      { timeoutMs: 12_000 },
    )
    if (findResult.code === 0) {
      names = findResult.stdout
        .toString('utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((name) => name && !name.startsWith('.'))
    }
  }

  const folders: Array<WorkspaceFolderEntry> = names
    .sort((a, b) => a.localeCompare(b))
    .map((name) => {
      const fullPath = path.posix.join(target, name)
      return { name, path: fullPath, fullPath }
    })

  return {
    base: ssh.cwd,
    current: target === ssh.cwd ? '' : target,
    folders,
    remote: true,
    backend: 'ssh',
    host: ssh.user ? `${ssh.user}@${ssh.host}` : ssh.host,
  }
}

export async function listActiveWorkspaceFolders(
  subPath = '',
  profileName?: string | null,
): Promise<WorkspaceFolderListResponse> {
  const scope = workspaceProfileScope(profileName)
  const remote = remoteWorkspaceContextForScope(scope)
  if (!remote) {
    return listWorkspaceFolders(subPath)
  }
  if (String((remote.config.terminal as TerminalConfig)?.backend ?? '')
    .trim()
    .toLowerCase() !== 'ssh') {
    const backend = String((remote.config.terminal as TerminalConfig)?.backend ?? '')
      .trim()
      .toLowerCase()
    throw new WorkspaceFolderAccessError(
      501,
      `Folder browsing for terminal.backend=${backend} is not supported yet. Enter a remote path under ${remote.remoteCwd}.`,
    )
  }
  return listSshWorkspaceFolders(remote.config, subPath)
}

export type RemoteFileEntry = {
  name: string
  path: string
  type: 'file' | 'folder'
  children?: Array<RemoteFileEntry>
}

function shouldIgnoreRelative(relativePath: string): boolean {
  return relativePath.split('/').some((segment) => IGNORED_DIRS.has(segment))
}

function insertTreeEntry(
  roots: Array<RemoteFileEntry>,
  relativePath: string,
  type: 'file' | 'folder',
): void {
  const parts = relativePath.split('/').filter(Boolean)
  if (parts.length === 0) return
  let siblings = roots
  for (let index = 0; index < parts.length; index += 1) {
    const name = parts[index]
    const isLeaf = index === parts.length - 1
    const entryPath = parts.slice(0, index + 1).join('/')
    let node = siblings.find((entry) => entry.name === name)
    if (!node) {
      node = {
        name,
        path: entryPath,
        type: isLeaf ? type : 'folder',
        children: isLeaf && type === 'file' ? undefined : [],
      }
      siblings.push(node)
    }
    if (!isLeaf) {
      node.type = 'folder'
      node.children ??= []
      siblings = node.children
    }
  }
}

function sortRemoteEntries(
  entries: Array<RemoteFileEntry>,
): Array<RemoteFileEntry> {
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  for (const entry of entries) {
    if (entry.children) sortRemoteEntries(entry.children)
  }
  return entries
}

function parseSshLsEntries(
  stdout: string,
  target: string,
  workspaceRoot: string,
): Array<RemoteFileEntry> {
  const entries: Array<RemoteFileEntry> = []
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const isDir = trimmed.endsWith('/')
    const name = (isDir ? trimmed.replace(/\/+$/, '') : trimmed)
      .split('/')
      .pop()
    if (!name || name.startsWith('.')) continue
    const fullPath = path.posix.join(target, name)
    const relative = path.posix.relative(workspaceRoot, fullPath)
    if (relative.startsWith('..')) continue
    entries.push({
      name,
      path: relative || name,
      type: isDir ? 'folder' : 'file',
      children: isDir ? [] : undefined,
    })
  }
  return sortRemoteEntries(entries)
}

async function listSshShallowDirectory(input: {
  config: Record<string, unknown>
  workspaceRoot: string
  dirPath: string
}): Promise<Array<RemoteFileEntry>> {
  const ssh = readSshTerminalConfig(input.config)
  if (!ssh) {
    throw new Error('SSH terminal is not configured on this profile')
  }
  const target = ensureRemoteWorkspacePath(input.dirPath, input.workspaceRoot)
  rejectUnsafeRemotePath(target)
  const result = await runSsh(ssh, ['/bin/ls', '-1p', '--', target], {
    timeoutMs: 8_000,
  })
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `ssh exited ${result.code}`
    throw new Error(`Cannot list remote files: ${detail}`)
  }
  return parseSshLsEntries(
    result.stdout.toString('utf8'),
    target,
    input.workspaceRoot,
  )
}

export async function listSshFileTree(input: {
  config: Record<string, unknown>
  workspaceRoot: string
  dirPath: string
  maxDepth: number
}): Promise<Array<RemoteFileEntry>> {
  const ssh = readSshTerminalConfig(input.config)
  if (!ssh) {
    throw new Error('SSH terminal is not configured on this profile')
  }
  const target = ensureRemoteWorkspacePath(input.dirPath, input.workspaceRoot)
  rejectUnsafeRemotePath(target)
  const depth = Math.max(1, input.maxDepth)
  if (depth <= 1) {
    return listSshShallowDirectory(input)
  }
  const pruneNames = [...IGNORED_DIRS]
  const pruneExpr = pruneNames.flatMap((name, index) =>
    index === 0 ? ['-name', name] : ['-o', '-name', name],
  )
  const result = await runSsh(
    ssh,
    [
      'find',
      target,
      '-mindepth',
      '1',
      '-maxdepth',
      String(depth),
      '(',
      ...pruneExpr,
      ')',
      '-prune',
      '-o',
      '(',
      '-type',
      'd',
      '-printf',
      'd\\t%p\\n',
      '-o',
      '-type',
      'f',
      '-printf',
      'f\\t%p\\n',
      ')',
    ],
    { timeoutMs: 30_000 },
  )
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `ssh exited ${result.code}`
    throw new Error(`Cannot list remote files: ${detail}`)
  }

  const roots: Array<RemoteFileEntry> = []
  for (const line of result.stdout.toString('utf8').split('\n')) {
    const trimmed = line.trimEnd()
    if (!trimmed) continue
    const tab = trimmed.indexOf('\t')
    if (tab < 0) continue
    const kind = trimmed.slice(0, tab)
    const fullPath = trimmed.slice(tab + 1).replace(/\\/g, '/')
    const relative = path.posix.relative(target, fullPath)
    if (
      !relative ||
      relative.startsWith('..') ||
      shouldIgnoreRelative(relative)
    ) {
      continue
    }
    insertTreeEntry(roots, relative, kind === 'd' ? 'folder' : 'file')
  }
  return sortRemoteEntries(roots)
}

export async function readSshFile(input: {
  config: Record<string, unknown>
  workspaceRoot: string
  filePath: string
}): Promise<Buffer> {
  const ssh = readSshTerminalConfig(input.config)
  if (!ssh) {
    throw new Error('SSH terminal is not configured on this profile')
  }
  const target = ensureRemoteWorkspacePath(input.filePath, input.workspaceRoot)
  rejectUnsafeRemotePath(target)
  const result = await runSsh(ssh, ['head', '-c', String(MAX_READ_BYTES), '--', target], {
    timeoutMs: 20_000,
  })
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `ssh exited ${result.code}`
    throw new Error(`Cannot read remote file: ${detail}`)
  }
  if (result.stdout.length > MAX_READ_BYTES) {
    return result.stdout.subarray(0, MAX_READ_BYTES)
  }
  return result.stdout
}

export async function writeSshFile(input: {
  config: Record<string, unknown>
  workspaceRoot: string
  filePath: string
  content: Buffer | string
}): Promise<void> {
  const ssh = readSshTerminalConfig(input.config)
  if (!ssh) {
    throw new Error('SSH terminal is not configured on this profile')
  }
  const target = ensureRemoteWorkspacePath(input.filePath, input.workspaceRoot)
  rejectUnsafeRemotePath(target)
  const parent = path.posix.dirname(target)
  const mkdir = await runSsh(ssh, ['mkdir', '-p', parent])
  if (mkdir.code !== 0) {
    throw new Error(
      `Cannot create remote directory: ${mkdir.stderr.trim() || mkdir.code}`,
    )
  }
  const result = await runSsh(ssh, ['dd', `of=${target}`, 'bs=65536', 'status=none'], {
    stdin: input.content,
    timeoutMs: 20_000,
  })
  if (result.code !== 0) {
    throw new Error(
      `Cannot write remote file: ${result.stderr.trim() || result.code}`,
    )
  }
}

export async function mkdirSshPath(input: {
  config: Record<string, unknown>
  workspaceRoot: string
  dirPath: string
}): Promise<void> {
  const ssh = readSshTerminalConfig(input.config)
  if (!ssh) {
    throw new Error('SSH terminal is not configured on this profile')
  }
  const target = ensureRemoteWorkspacePath(input.dirPath, input.workspaceRoot)
  rejectUnsafeRemotePath(target)
  const result = await runSsh(ssh, ['mkdir', '-p', target])
  if (result.code !== 0) {
    throw new Error(
      `Cannot create remote directory: ${result.stderr.trim() || result.code}`,
    )
  }
}

export async function renameSshPath(input: {
  config: Record<string, unknown>
  workspaceRoot: string
  from: string
  to: string
}): Promise<void> {
  const ssh = readSshTerminalConfig(input.config)
  if (!ssh) {
    throw new Error('SSH terminal is not configured on this profile')
  }
  const from = ensureRemoteWorkspacePath(input.from, input.workspaceRoot)
  const to = ensureRemoteWorkspacePath(input.to, input.workspaceRoot)
  rejectUnsafeRemotePath(from)
  rejectUnsafeRemotePath(to)
  const result = await runSsh(ssh, ['mv', '-f', from, to])
  if (result.code !== 0) {
    throw new Error(`Cannot rename remote path: ${result.stderr.trim() || result.code}`)
  }
}

export async function deleteSshPath(input: {
  config: Record<string, unknown>
  workspaceRoot: string
  targetPath: string
}): Promise<void> {
  const ssh = readSshTerminalConfig(input.config)
  if (!ssh) {
    throw new Error('SSH terminal is not configured on this profile')
  }
  const target = ensureRemoteWorkspacePath(input.targetPath, input.workspaceRoot)
  rejectUnsafeRemotePath(target)
  if (target === input.workspaceRoot) {
    throw new Error('Refusing to delete workspace root')
  }
  const result = await runSsh(ssh, ['rm', '-rf', '--', target])
  if (result.code !== 0) {
    throw new Error(`Cannot delete remote path: ${result.stderr.trim() || result.code}`)
  }
}

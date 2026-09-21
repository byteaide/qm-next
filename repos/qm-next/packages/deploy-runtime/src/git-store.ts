/**
 * Deploy git store (cluster 1 phase 2, parity #45b remaining slice):
 * per-deployment bare git repos under `<repoRoot>/<safeName(id)>.git`,
 * with the same commit/bundle/diff surface as qm's
 * `src/deploy/deploy-git-store.ts`. The HTTP transport rides
 * `git http-backend` CGI (see `deployment-git-routes.ts`).
 *
 * Optional `archiveStore` keeps a per-deployment bundle in a
 * `GitArchiveStore` so a fresh process can rebuild the bare repo
 * without re-committing every version. Without it the store is
 * process-local only.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { DurableByteStore } from '@qm/store'
import type {
  DeployGitArchive,
  DeployGitDiff,
  DeployGitInputFile,
  DeployGitStore,
  DeployGitTreeFile,
} from '@qm/types'

export type { DeployGitArchive, DeployGitDiff, DeployGitInputFile, DeployGitStore, DeployGitTreeFile }

export interface GitArchiveStore {
  get(key: string): Promise<DeployGitArchive | null | undefined>
  put(key: string, value: DeployGitArchive): Promise<unknown>
  update?(key: string, fn: (cur: DeployGitArchive) => DeployGitArchive): Promise<unknown>
  delete?(key: string): Promise<unknown>
}

export interface DeployGitStoreOptions {
  repoRoot?: string
  gitBin?: string
  archiveStore?: GitArchiveStore
  archiveBytes?: DurableByteStore
}

const CURRENT_REF = 'refs/heads/current'
const DEFAULT_REPO_ROOT = join(tmpdir(), 'qm-next-deploy-git')
const GIT_AUTHOR = ['-c', 'user.name=qm-next', '-c', 'user.email=deployments@qm-next.local']
const ARCHIVE_ETAG_FILE = 'qm-next-archive-etag'

interface GitResult {
  code: number
  stdout: Buffer
}

export function createDeployGitStore(opts: DeployGitStoreOptions = {}): DeployGitStore {
  const repoRoot = opts.repoRoot ?? DEFAULT_REPO_ROOT
  const gitBin = opts.gitBin ?? 'git'
  const archiveStore = opts.archiveStore
  const archiveBytes = opts.archiveBytes
  const repoPath = (deploymentId: string): string => join(repoRoot, `${safeRepoName(deploymentId)}.git`)

  async function gitResult(
    args: string[],
    options: { cwd?: string; okExitCodes?: number[] } = {},
  ): Promise<GitResult> {
    const ok = new Set(options.okExitCodes ?? [0])
    return await new Promise<GitResult>((resolveGit, rejectGit) => {
      const child = spawn(gitBin, args, { cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      child.stdout.on('data', (d) => stdout.push(Buffer.from(d)))
      child.stderr.on('data', (d) => stderr.push(Buffer.from(d)))
      child.on('error', rejectGit)
      child.on('close', (code) => {
        if (ok.has(code ?? -1)) return resolveGit({ code: code ?? -1, stdout: Buffer.concat(stdout) })
        rejectGit(
          new Error(
            `git ${args.join(' ')} exited ${code}: ${Buffer.concat(stderr).toString('utf8').trim()}`,
          ),
        )
      })
    })
  }
  const git = async (
    args: string[],
    options: { cwd?: string; okExitCodes?: number[] } = {},
  ): Promise<Buffer> => (await gitResult(args, options)).stdout

  async function localArchiveEtag(repo: string): Promise<string | null> {
    try {
      const raw = await readFile(join(repo, ARCHIVE_ETAG_FILE), 'utf8')
      return raw.trim() || null
    } catch {
      return null
    }
  }

  async function archiveBundleBytes(archive: DeployGitArchive): Promise<Buffer> {
    if (archive.blobKey && archiveBytes) {
      const blob = await archiveBytes.open(archive.blobKey)
      if (blob) return blob.bytes
    }
    if (archive.bundleB64 != null) return Buffer.from(archive.bundleB64, 'base64')
    throw new Error(
      `deploy git archive for ${archive.deploymentId} has no readable bundle (blobKey=${archive.blobKey ?? 'none'})`,
    )
  }

  async function restoreArchive(deploymentId: string, archive: DeployGitArchive): Promise<string> {
    const repo = repoPath(deploymentId)
    const tmp = await mkdtemp(join(tmpdir(), 'qm-next-deploy-git-bundle-'))
    try {
      const bundle = join(tmp, 'repo.bundle')
      const data = await archiveBundleBytes(archive)
      await rm(repo, { recursive: true, force: true })
      await mkdir(repoRoot, { recursive: true })
      await writeFile(bundle, data)
      await git(['init', '--bare', repo])
      await git(['--git-dir', repo, 'symbolic-ref', 'HEAD', CURRENT_REF])
      await git(['--git-dir', repo, 'fetch', bundle, '+refs/*:refs/*'])
      await writeFile(join(repo, ARCHIVE_ETAG_FILE), `${archive.etag}\n`, 'utf8')
      return repo
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  }

  async function storeArchive(deploymentId: string, data: Buffer, etag: string): Promise<void> {
    if (!archiveStore) return
    if (archiveBytes) {
      const { blobKey } = await archiveBytes.put(data)
      await archiveStore.put(deploymentId, {
        deploymentId,
        blobKey,
        etag,
        updatedAt: Date.now(),
      })
    } else {
      await archiveStore.put(deploymentId, {
        deploymentId,
        bundleB64: data.toString('base64'),
        etag,
        updatedAt: Date.now(),
      })
    }
  }

  async function persistArchive(deploymentId: string, repo: string): Promise<void> {
    if (!archiveStore) return
    const tmp = await mkdtemp(join(tmpdir(), 'qm-next-deploy-git-bundle-'))
    try {
      const bundle = join(tmp, 'repo.bundle')
      const refs = await gitResult(['--git-dir', repo, 'show-ref'], { okExitCodes: [0, 1] })
      if (refs.code === 1) {
        await archiveStore.delete?.(deploymentId)
        return
      }
      await git(['--git-dir', repo, 'bundle', 'create', bundle, '--all'])
      const data = await readFile(bundle)
      const etag = createHash('sha256').update(data).digest('hex')
      await storeArchive(deploymentId, data, etag)
      await writeFile(join(repo, ARCHIVE_ETAG_FILE), `${etag}\n`, 'utf8')
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  }

  async function migrateArchive(archive: DeployGitArchive): Promise<void> {
    if (!archiveStore?.update || !archiveBytes || archive.bundleB64 == null) return
    const { blobKey } = await archiveBytes.put(Buffer.from(archive.bundleB64, 'base64'))
    const slim: DeployGitArchive = {
      deploymentId: archive.deploymentId,
      blobKey,
      etag: archive.etag,
      updatedAt: archive.updatedAt,
    }
    await archiveStore.update(archive.deploymentId, (cur) =>
      cur.bundleB64 != null && cur.etag === archive.etag ? slim : cur,
    )
  }

  async function ensureRepo(deploymentId: string): Promise<string> {
    const repo = repoPath(deploymentId)
    const archive = archiveStore ? await archiveStore.get(deploymentId) : null
    if (archive) {
      try {
        await migrateArchive(archive)
      } catch {
        // migration best-effort; fall through to restore
      }
      const hasRepo = existsSync(join(repo, 'HEAD'))
      if (!hasRepo || (await localArchiveEtag(repo)) !== archive.etag) return restoreArchive(deploymentId, archive)
      return repo
    }
    if (existsSync(join(repo, 'HEAD'))) return repo
    await mkdir(repoRoot, { recursive: true })
    await git(['init', '--bare', repo])
    await git(['--git-dir', repo, 'symbolic-ref', 'HEAD', CURRENT_REF])
    return repo
  }

  async function checkoutForCommit(
    deploymentId: string,
    parent: string | undefined,
  ): Promise<{ repo: string; workdir: string }> {
    const repo = await ensureRepo(deploymentId)
    const workdir = await mkdtemp(join(tmpdir(), 'qm-next-deploy-git-'))
    await git(['clone', '--quiet', repo, workdir])
    if (parent) await git(['checkout', '--quiet', parent], { cwd: workdir })
    await clearWorktree(workdir)
    return { repo, workdir }
  }

  async function treeOf(deploymentId: string, commitSha: string): Promise<DeployGitTreeFile[]> {
    const repo = await ensureRepo(deploymentId)
    const out = await git(['--git-dir', repo, 'ls-tree', '-r', '-z', '--long', commitSha])
    return out
      .toString('utf8')
      .split('\0')
      .filter(Boolean)
      .map((entry) => {
        const m = /^(100644) blob ([0-9a-f]{40})\s+(\d+)\t(.+)$/.exec(entry)
        if (!m) throw new Error(`unexpected git tree entry: ${entry}`)
        return { mode: '100644' as const, sha: m[2]!, size: Number(m[3]!), path: m[4]! }
      })
      .sort(byPath)
  }

  async function blob(deploymentId: string, sha: string): Promise<Uint8Array | null> {
    const repo = await ensureRepo(deploymentId)
    try {
      return await git(['--git-dir', repo, 'cat-file', '-p', sha])
    } catch {
      return null
    }
  }

  return {
    async commit(input) {
      const { repo, workdir } = await checkoutForCommit(input.deploymentId, input.parent)
      try {
        await writeFiles(workdir, input.files)
        await git(['add', '-A', '--force'], { cwd: workdir })
        const diff = await gitResult(['diff', '--cached', '--quiet'], { cwd: workdir, okExitCodes: [0, 1] })
        const changed = diff.code === 1
        if (!changed && input.parent) return input.parent
        await git(
          [
            ...GIT_AUTHOR,
            'commit',
            '--quiet',
            ...(changed ? [] : ['--allow-empty']),
            '-m',
            input.message ?? `deploy v${input.version}`,
          ],
          { cwd: workdir },
        )
        const sha = (await git(['rev-parse', 'HEAD'], { cwd: workdir })).toString('utf8').trim()
        await git(['push', '--quiet', repo, `HEAD:refs/deploy-commits/${sha}`], { cwd: workdir })
        await persistArchive(input.deploymentId, repo)
        return sha
      } finally {
        await rm(workdir, { recursive: true, force: true })
      }
    },
    treeOf,
    async filesOf(deploymentId, commitSha, paths) {
      const wanted = paths ? new Set(paths.map(normalizeRelPath)) : null
      const entries = await treeOf(deploymentId, commitSha)
      const files: DeployGitInputFile[] = []
      for (const entry of entries) {
        if (wanted && !wanted.has(entry.path)) continue
        const data = await blob(deploymentId, entry.sha)
        if (data == null) throw new Error(`missing blob ${entry.sha} for ${entry.path}`)
        files.push({ path: entry.path, data })
      }
      return files
    },
    async diff(deploymentId, fromCommit, toCommit) {
      const toFiles = new Map((await treeOf(deploymentId, toCommit)).map((f) => [f.path, f]))
      if (!fromCommit) {
        return { added: [...toFiles.values()].sort(byPath), modified: [], deleted: [] }
      }
      const out = await git([
        '--git-dir',
        await ensureRepo(deploymentId),
        'diff',
        '--name-status',
        '-z',
        fromCommit,
        toCommit,
      ])
      const parts = out.toString('utf8').split('\0').filter(Boolean)
      const added: DeployGitTreeFile[] = []
      const modified: DeployGitTreeFile[] = []
      const deleted: DeployGitTreeFile[] = []
      for (let i = 0; i < parts.length; ) {
        const status = parts[i++]!
        const code = status[0]!
        const path = normalizeRelPath(parts[i++]!)
        if (code === 'D') {
          deleted.push({ path, sha: '', size: 0, mode: '100644' })
          continue
        }
        const nextPath = code === 'R' || code === 'C' ? normalizeRelPath(parts[i++]!) : path
        const file = toFiles.get(nextPath)
        if (!file) continue
        if (code === 'A' || code === 'C') added.push(file)
        else if (code === 'R') {
          deleted.push({ path, sha: '', size: 0, mode: '100644' })
          added.push(file)
        } else modified.push(file)
      }
      return { added: added.sort(byPath), modified: modified.sort(byPath), deleted: deleted.sort(byPath) }
    },
    async bundle(deploymentId, commitSha) {
      const repo = await ensureRepo(deploymentId)
      const tmp = await mkdtemp(join(tmpdir(), 'qm-next-deploy-git-bundle-'))
      try {
        const bundle = join(tmp, 'repo.bundle')
        await git(['--git-dir', repo, 'bundle', 'create', bundle, `refs/deploy-commits/${commitSha}`])
        return await readFile(bundle)
      } finally {
        await rm(tmp, { recursive: true, force: true })
      }
    },
    async setRef(deploymentId, ref, sha) {
      const repo = await ensureRepo(deploymentId)
      await git(['--git-dir', repo, 'update-ref', ref, sha])
      await persistArchive(deploymentId, repo)
    },
    async deleteRef(deploymentId, ref) {
      const repo = await ensureRepo(deploymentId)
      await git(['--git-dir', repo, 'update-ref', '-d', ref])
      await persistArchive(deploymentId, repo)
    },
    async refOf(deploymentId, ref) {
      const repo = await ensureRepo(deploymentId)
      try {
        return (await git(['--git-dir', repo, 'rev-parse', '--verify', ref])).toString('utf8').trim()
      } catch {
        return null
      }
    },
    blob,
    repoUrl: ensureRepo,
  }
}

async function clearWorktree(workdir: string): Promise<void> {
  for (const entry of await readdir(workdir, { withFileTypes: true })) {
    if (entry.name === '.git') continue
    await rm(join(workdir, entry.name), { recursive: true, force: true })
  }
}

async function writeFiles(root: string, files: DeployGitInputFile[]): Promise<void> {
  for (const file of files) {
    const rel = normalizeRelPath(file.path)
    const target = resolve(root, rel)
    const back = relative(root, target)
    if (back.startsWith('..') || isAbsolute(back)) throw new Error(`deploy git file escapes worktree: ${file.path}`)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, typeof file.data === 'string' ? file.data : Buffer.from(file.data))
  }
}

function safeRepoName(deploymentId: string): string {
  return deploymentId.replace(/[^a-zA-Z0-9._-]/g, '_')
}

function normalizeRelPath(path: string): string {
  const p = path.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '')
  const parts = p.split('/').filter(Boolean)
  if (
    !parts.length ||
    path.startsWith('/') ||
    parts.some((part) => part === '.' || part === '..' || part.includes('\0')) ||
    parts.some(isGitMetadataComponent)
  ) {
    throw new Error(`invalid deploy git path: ${path}`)
  }
  return parts.join('/')
}

function isGitMetadataComponent(part: string): boolean {
  const p = part
    .normalize('NFC')
    .replace(/[.\s]+$/, '')
    .toLowerCase()
  return p === '.git' || /^git~[0-9]+$/.test(p)
}

function byPath(a: DeployGitTreeFile, b: DeployGitTreeFile): number {
  if (a.path < b.path) return -1
  if (a.path > b.path) return 1
  return 0
}
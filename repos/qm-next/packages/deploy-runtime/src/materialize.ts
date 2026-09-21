/**
 * Materialize hook (cluster 1 MVP) — turns a `DeployInput.files` array
 * into a concrete workspace directory the docker provider can mount
 * read-only at `/app`. Each file is `{ path, blobKey }`; the blob
 * bytes are pulled through `DurableByteStore.open()` and written to
 * `<workspaceDir>/<path>`. Atomicity: parent directories are created
 * with `mkdir -p`, and individual files use write-rename so a partial
 * materialize can't leave half-written files behind.
 *
 * Workspace isolation: per-deployment/per-version paths are disjoint
 * (`<root>/<deploymentId>/v<version>`) so rollback can re-materialize
 * an old version without colliding with the current workspace.
 */
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, normalize, isAbsolute } from 'node:path'
import type { DurableByteStore } from '@qm/store'
import type { DeployMaterializer } from '@qm/types'

export interface MaterializerOptions {
  workspaceRoot?: string
}

const SAFE_PATH = /^[A-Za-z0-9._/-]+$/

function safeRelativePath(raw: string): string {
  if (!SAFE_PATH.test(raw) || raw.includes('..')) {
    throw new Error(`unsafe file path: ${raw}`)
  }
  const normalized = normalize(raw)
  if (isAbsolute(normalized) || normalized.startsWith('..')) {
    throw new Error(`unsafe file path: ${raw}`)
  }
  return normalized
}

export function createMaterializer(
  byteStore: DurableByteStore,
  options: MaterializerOptions = {},
): DeployMaterializer {
  const root = options.workspaceRoot ?? join(tmpdir(), 'qm-next-deployments')

  return {
    async materialize({ deploymentId, version, files }): Promise<string> {
      const workspaceDir = join(root, deploymentId, `v${version}`)
      const stagingDir = `${workspaceDir}.staging.${process.pid}.${Date.now()}`
      await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined)
      await mkdir(stagingDir, { recursive: true })

      try {
        for (const file of files) {
          const target = safeRelativePath(file.path)
          let bytes: Buffer
          if (file.blobKey) {
            const opened = await byteStore.open(file.blobKey)
            if (!opened) throw new Error(`blob not found: ${file.blobKey}`)
            bytes = opened.bytes
          } else if (file.content !== undefined) {
            bytes = typeof file.content === 'string' ? Buffer.from(file.content, 'utf8') : Buffer.from(file.content)
          } else {
            throw new Error(`DeployFile ${file.path} has neither blobKey nor content`)
          }
          const absolute = join(stagingDir, target)
          await mkdir(join(absolute, '..'), { recursive: true })
          await writeFile(absolute, bytes)
        }
        await rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined)
        await rename(stagingDir, workspaceDir)
        return workspaceDir
      } catch (error) {
        await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined)
        throw error
      }
    },
  }
}
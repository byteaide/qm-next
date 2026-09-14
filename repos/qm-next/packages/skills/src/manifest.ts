/**
 * Skill manifest helpers, ported from qm's `skill-store.ts`: `safeSkillFilePath`
 * rejects path escapes, `canonicalFiles` produces the sort-stable tuple used
 * by HMAC signing, and `signManifest`/`verifyManifest` produce a stable
 * hex digest. The signing secret is per-store; both impls accept an
 * `opts.signingSecret` (memory default: a random uuid, postgres default: the
 * store's per-instance secret).
 */
import { createHmac, randomUUID } from 'node:crypto'
import type { SkillFile, SkillManifest } from './contract.ts'
import { assertSafeSkillName, isSafeSkillName } from './skill-name.ts'

export function safeSkillFilePath(path: string): string {
  const p = path
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/\/+$/, '')
  const parts = p.split('/').filter(Boolean)
  if (
    !parts.length ||
    path.startsWith('/') ||
    parts.some((part) => part === '.' || part === '..' || part.includes('\0'))
  ) {
    throw new Error(`invalid skill file path: ${path}`)
  }
  return parts.join('/')
}

export function canonicalFiles(files: SkillFile[] | undefined): Array<[string, string, boolean]> {
  return [...(files ?? [])]
    .map((f): [string, string, boolean] => [f.path, f.content, f.executable === true])
    .sort((a, b) => {
      if (a[0] < b[0]) return -1
      if (a[0] > b[0]) return 1
      return 0
    })
}

export function manifestPayload(manifest: SkillManifest): string {
  const files = canonicalFiles(manifest.files)
  return JSON.stringify({
    name: manifest.name,
    description: manifest.description,
    requiredCapabilities: [...manifest.requiredCapabilities].sort(),
    body: manifest.body,
    ...(files.length ? { files } : {}),
  })
}

export function signManifest(manifest: SkillManifest, secret: string): string {
  return createHmac('sha256', secret).update(manifestPayload(manifest)).digest('hex')
}

export function verifyManifest(manifest: SkillManifest, signature: string, secret: string): boolean {
  return signManifest(manifest, secret) === signature
}

export interface Signer {
  sign(manifest: SkillManifest): string
  verify(manifest: SkillManifest, signature: string): boolean
}

export function createSigner(secret?: string): Signer {
  const key = secret ?? randomUUID()
  return {
    sign(manifest) {
      return signManifest(manifest, key)
    },
    verify(manifest, signature) {
      return verifyManifest(manifest, signature, key)
    },
  }
}

/** Safe-skill-dirname alias (qm `safeSkillDirName`); just runs the name check. */
export function safeSkillDirName(name: string): string {
  return assertSafeSkillName(name)
}

export function isSafeSkillFilePath(path: string): boolean {
  try {
    return safeSkillFilePath(path) === path
  } catch {
    return false
  }
}

void isSafeSkillName

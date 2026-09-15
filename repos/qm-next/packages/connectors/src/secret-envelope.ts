/**
 * Connector secret envelope (qm `src/connectors/connector-client-store.ts`
 * helpers): HKDF-derived secret keys (`v2` IV + GCM tag + ciphertext)
 * and the public projection that hides the encrypted secret behind
 * `hasSecret` so admin routes can list client registrations without
 * exposing credential material.
 */
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto'

export interface SecretKey {
  current: Buffer
  legacy: Buffer
  fallbacks?: SecretKey[]
}

const HKDF_SALT = 'agent-platform.secret-box'

export function deriveConnectorKey(material: Buffer | string, purpose = 'connector-secrets'): SecretKey {
  const ikm = Buffer.isBuffer(material) ? material : Buffer.from(material, 'utf8')
  const current = Buffer.from(hkdfSync('sha256', ikm, HKDF_SALT, `${purpose}.v2`, 32))
  const legacy =
    Buffer.isBuffer(material) && material.length === 32 ? material : createHash('sha256').update(material).digest()
  return { current, legacy }
}

export function encryptSecret(plain: string, key: SecretKey): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key.current, iv)
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `v2:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`
}

export function decryptSecret(enc: string, key: SecretKey): string {
  const parts = enc.split(':')
  const v2 = parts[0] === 'v2'
  const [ivB, tagB, ctB] = v2 ? parts.slice(1) : parts
  if (parts.length !== (v2 ? 4 : 3) || !ivB || !tagB || ctB === undefined) {
    throw new Error('malformed encrypted secret')
  }
  const attempt = (k: SecretKey): string => {
    const decipher = createDecipheriv('aes-256-gcm', v2 ? k.current : k.legacy, Buffer.from(ivB, 'base64'))
    decipher.setAuthTag(Buffer.from(tagB, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(ctB, 'base64')), decipher.final()]).toString('utf8')
  }
  try {
    return attempt(key)
  } catch (e) {
    for (const fb of key.fallbacks ?? []) {
      try {
        return attempt(fb)
      } catch (error) {
        void error
      }
    }
    throw e
  }
}
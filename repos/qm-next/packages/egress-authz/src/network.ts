/**
 * Private-network classification (qm `src/util/network.ts`): is the
 * address a loopback, link-local, ULA, multicast, or any other range
 * that should be blocked when the policy denies private networks?
 */
import { isIP } from 'node:net'

function normalize(address: string): string {
  return address.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1').replace(/%.*$/, '')
}

export function isPrivateNetworkIp(address: string): boolean {
  const s = normalize(address)
  const fam = isIP(s)
  if (fam === 4) {
    const octets = s.split('.').map((p) => Number.parseInt(p, 10))
    if (octets.length !== 4 || octets.some((n) => Number.isNaN(n))) return false
    const [a, b] = octets
    if (a === undefined || b === undefined) return false
    if (a === 127) return true
    if (a === 10) return true
    if (a === 0) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 100 && b >= 64 && b <= 127) return true
    if (a === 192 && b === 0) return true
    if (a === 198 && (b === 18 || b === 19)) return true
    if (a >= 224) return true
    return false
  }
  if (fam === 6) {
    if (s === '::1' || s === '::') return true
    if (s.startsWith('fe8') || s.startsWith('fe9') || s.startsWith('fea') || s.startsWith('feb')) return true
    if (s.startsWith('fc') || s.startsWith('fd')) return true
    if (s.startsWith('ff')) return true
    if (s.startsWith('::ffff:')) {
      const v4 = s.slice(7)
      return isPrivateNetworkIp(v4)
    }
    return false
  }
  return false
}
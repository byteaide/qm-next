/**
 * Phase 3J — built-in default denylist for sandbox command-policy.
 * Patterns here are deliberately conservative: each one matches a
 * primitive that's destructive to a host (not just to the container) so
 * the policy refuses it even if the container's filesystem would let it
 * succeed. False negatives are acceptable; false positives are not.
 *
 * The list is intentionally small. Coverage:
 *   - disk-wipe: rm -[rRfF]* /<path>, mkfs, dd to /dev/sd?, dd to /dev/nvme
 *   - disk-fill: :(){ ...&... };: (fork bomb), dd from /dev/zero|/dev/urandom
 *   - ownership takeover: chown -R root /, chmod -R 777 /
 *   - SQL DDL: DROP DATABASE / TABLE / SCHEMA / INDEX, TRUNCATE TABLE
 *
 * Path-boundary semantics:
 *   For `rm`/`chown`/`chmod`, the `/` after the flag set must be a
 *   *root-level* path — i.e. `/` followed by either end-of-command,
 *   whitespace, OR a single path segment with no further `/`. This avoids
 *   false positives on `rm -rf /tmp/foo` (a normal cleanup) while still
 *   catching `rm -rf /etc` (a system wipe).
 */
import type { CommandPolicy } from '@qm/types'

export const DEFAULT_DENYLIST_PATTERNS: ReadonlyArray<{ pattern: string; reason: string }> = [
  // ─── disk-wipe ────────────────────────────────────────────────────────
  // rm -[flags] /<root-segment-or-end>. The flag set may appear in any
  // order (rf/fr/rfR-fr etc.) — we only require at least one of r, R, f
  // or F and that the path argument is at filesystem root.
  {
    pattern: '\\brm\\b[^|;&]*\\s+-[^|;&]*\\s+/(?:\\s|$|[a-zA-Z0-9._][^/\\s|;&]*(?:\\s|$))',
    reason: 'catastrophic: rm targeting root-level path',
  },
  // mkfs.* / mkswap / mkntfs — wipe disk partitions. Two spellings
  // because the safe-regex analyzer rejects quantified non-capturing
  // groups (`(?:\.[a-z0-9]+)?`), qm's analyzer semantics preserved.
  {
    pattern: '\\bmkfs\\.[a-z0-9]+\\s+/dev/',
    reason: 'catastrophic: filesystem creation command (mkfs / mkswap / mkntfs)',
  },
  {
    pattern: '\\bmkfs\\s+/dev/',
    reason: 'catastrophic: filesystem creation command (mkfs / mkswap / mkntfs)',
  },
  // dd to /dev/sdX or /dev/nvmeXnY — direct disk write.
  {
    pattern: '\\bdd\\b[^|;&]*\\bif=\\s*/dev/(?:sd|vd|nvme|hd|xvd)',
    reason: 'catastrophic: dd reading from raw block device',
  },
  {
    pattern: '\\bdd\\b[^|;&]*\\bof=\\s*/dev/(?:sd|vd|nvme|hd|xvd)',
    reason: 'catastrophic: dd writing to raw block device',
  },
  // ─── fork bomb + resource exhaustion ─────────────────────────────────
  // Classic bash fork bomb shape: `:(){ ... & ... };:`. We require an
  // `&` inside the braces (background recursion); matches `:(){ :|:& };:`
  // and `bash$'\x63'(){...};:`-style obfuscated variants whose `{`/`}`/`;`
  // are still literal.
  {
    pattern: ':\\(\\)\\s*\\{[^}]*&[^}]*\\}\\s*;\\s*:',
    reason: 'catastrophic: fork bomb pattern',
  },
  // dd from /dev/urandom or /dev/zero filling a path — disk-fill DoS.
  {
    pattern: '\\bdd\\b[^|;&]*\\bif=\\s*/dev/(?:zero|urandom)\\b[^|;&]*\\bof=\\s*/',
    reason: 'catastrophic: dd filling filesystem from /dev/zero|urandom',
  },
  // ─── ownership / permission takeover ─────────────────────────────────
  {
    pattern: '\\bchown\\b[^|;&]*-[^|;&]*[rR]\\b[^|;&]*\\s+/(?:\\s|$|[a-zA-Z0-9._][^/\\s|;&]*(?:\\s|$))',
    reason: 'catastrophic: recursive chown at filesystem root',
  },
  {
    pattern: '\\bchmod\\b[^|;&]*-[^|;&]*[rR]\\b[^|;&]*\\s+/(?:\\s|$|[a-zA-Z0-9._][^/\\s|;&]*(?:\\s|$))',
    reason: 'catastrophic: recursive chmod at filesystem root',
  },
  // ─── SQL DDL (defence in depth alongside screener) ────────────────────
  {
    pattern: '\\bDROP\\s+(?:DATABASE|TABLE\\b|SCHEMA|INDEX)',
    reason: 'catastrophic: SQL DROP primitive (see also screener layer)',
  },
  {
    pattern: '\\bTRUNCATE\\s+TABLE\\b',
    reason: 'catastrophic: SQL TRUNCATE primitive',
  },
]

export function defaultDenylistPolicy(): CommandPolicy {
  return {
    mode: 'denylist',
    rules: DEFAULT_DENYLIST_PATTERNS.map(({ pattern, reason }) => ({
      pattern,
      decision: 'deny' as const,
      reason,
    })),
  }
}
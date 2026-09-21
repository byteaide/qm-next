export type { LedgerBegin, ToolLedger } from '@qm/types'

import type { ToolLedger } from '@qm/types'

export function createNullLedger(): ToolLedger {
  return {
    async begin() {
      return { cached: false }
    },
    async record() {},
  }
}

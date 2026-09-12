/**
 * HarnessRegistry implementation: named harnesses registered explicitly; an
 * optional deployment-configured default id resolves bare requests. No
 * platform-derived default exists anywhere.
 */
import type { Harness, HarnessRegistry } from '@qm/types'

export interface HarnessRouterOptions {
  defaultId?: string
}

export function createHarnessRouter(opts: HarnessRouterOptions = {}): HarnessRegistry {
  const byId = new Map<string, Harness>()
  return {
    register(harness) {
      byId.set(harness.profile.id, harness)
    },
    get(id) {
      return byId.get(id)
    },
    ids() {
      return [...byId.keys()]
    },
    resolve(id) {
      const effective = id ?? opts.defaultId
      if (!effective) throw new Error('no harness id requested and no default harness configured')
      const harness = byId.get(effective)
      if (!harness) throw new Error(`unknown harness: ${effective}`)
      return harness
    },
  }
}

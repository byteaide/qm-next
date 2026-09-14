/**
 * Lane-A runtime-config store: per-scope model/harness selections with
 * revisions, channel-header-pin overrides, and the small durable-config
 * surface the runtime-config / surface-config / channel-header-pin routes
 * read. Selections follow qm's revision semantics (scope override carries
 * the org revision it was based on; inherit clears the override).
 */
export interface RuntimeSelection {
  harnessId: string
  modelId: string
  effortLevel?: string
  fastMode?: boolean
  revision: number
  orgRevision?: number
}

export interface RuntimeConfigStore {
  getRuntimeSelection(scope: string): Promise<RuntimeSelection | null>
  setRuntimeSelection(scope: string, selection: Omit<RuntimeSelection, 'revision' | 'orgRevision'> | null): Promise<void>
  acknowledgeRuntimeSelection(scope: string): Promise<void>
  getApprovedHarnesses(): Promise<string[] | null>
  getWebuiModels(scope: string): Promise<string[] | null>
  getChannelHeaderPin(scope: string): Promise<boolean>
  getChannelHeaderPinOverride(scope: string): Promise<boolean | null>
  getChannelHeaderPinDefault(): Promise<boolean>
  setChannelHeaderPin(scope: string, on: boolean | null): Promise<void>
  getInteractiveFastMode(): Promise<boolean>
}

interface PinState {
  on: boolean
  override: boolean | null
  orgDefault: boolean
}

export function createMemoryRuntimeConfigStore(): RuntimeConfigStore {
  const selections = new Map<string, RuntimeSelection>()
  const revisions = new Map<string, number>()
  const pins = new Map<string, PinState>()
  let orgPinDefault = false

  const revisionOf = (scope: string): number => revisions.get(scope) ?? 0

  return {
    async getRuntimeSelection(scope) {
      const sel = selections.get(scope)
      return sel ? { ...sel } : null
    },
    async setRuntimeSelection(scope, selection) {
      if (selection === null) {
        selections.delete(scope)
        return
      }
      const orgRevision = revisionOf('org:default')
      const previous = selections.get(scope)
      const effectiveFastMode = selection.fastMode === true
      selections.set(scope, {
        ...selection,
        ...(selection.effortLevel !== undefined ? { effortLevel: selection.effortLevel } : {}),
        ...(effectiveFastMode ? { fastMode: true } : {}),
        revision: revisionOf(scope) + 1,
        orgRevision: previous?.orgRevision ?? orgRevision,
      })
    },
    async acknowledgeRuntimeSelection(scope) {
      const sel = selections.get(scope)
      if (sel) sel.orgRevision = revisionOf('org:default')
    },
    async getApprovedHarnesses() {
      return null
    },
    async getWebuiModels() {
      return null
    },
    async getChannelHeaderPin(scope) {
      return pins.get(scope)?.on ?? orgPinDefault
    },
    async getChannelHeaderPinOverride(scope) {
      return pins.get(scope)?.override ?? null
    },
    async getChannelHeaderPinDefault() {
      return orgPinDefault
    },
    async setChannelHeaderPin(scope, on) {
      const current = pins.get(scope) ?? { on: orgPinDefault, override: null, orgDefault: orgPinDefault }
      if (on === null) {
        pins.set(scope, { ...current, on: orgPinDefault, override: null })
        return
      }
      pins.set(scope, { ...current, on, override: on })
    },
    async getInteractiveFastMode() {
      return false
    },
  }
}

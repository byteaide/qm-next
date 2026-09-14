/**
 * Lane-A model catalog: trimmed static port of qm's pi-models registry
 * (webui+base selectable entries only) plus the harness/thinking constants
 * the runtime-config and surface-config routes validate against.
 */
export const HARNESS_IDS = ['pi', 'opencode', 'codex', 'claude', 'mock'] as const
export type HarnessId = (typeof HARNESS_IDS)[number]

export const THINKING_LEVELS = ['auto', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode'] as const

export const DEFAULT_AGENT_MODEL_ID = 'claude-opus-5'
export const DEFAULT_CODEX_MODEL_ID = 'gpt-5.6-sol'

export interface ModelCatalogEntry {
  id: string
  name: string
  provider: string
}

interface RegistryEntry {
  id: string
  name: string
  fastMode: boolean
  provider: string
}

const MODEL_REGISTRY: readonly RegistryEntry[] = [
  { id: 'claude-fable-5', name: 'Claude Fable 5', fastMode: false, provider: 'anthropic' },
  { id: 'claude-opus-5', name: 'Claude Opus 5', fastMode: true, provider: 'anthropic' },
  { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', fastMode: true, provider: 'anthropic' },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', fastMode: false, provider: 'anthropic' },
  { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', fastMode: false, provider: 'anthropic' },
  { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', fastMode: false, provider: 'openai' },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', fastMode: false, provider: 'openai' },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', fastMode: false, provider: 'openai' },
  { id: 'gpt-6-astra', name: 'GPT-6 Astra', fastMode: false, provider: 'openai' },
  { id: 'openrouter/auto', name: 'OpenRouter Auto', fastMode: false, provider: 'openrouter' },
]

const REGISTRY_BY_ID = new Map(MODEL_REGISTRY.map((m) => [m.id, m]))

export function isHarnessId(value: unknown): value is HarnessId {
  return typeof value === 'string' && (HARNESS_IDS as readonly string[]).includes(value)
}

export function modelProviderOf(id: string): string | undefined {
  return REGISTRY_BY_ID.get(id)?.provider
}

export function resolveModelName(id: string): string {
  return REGISTRY_BY_ID.get(id)?.name ?? id
}

export function modelSupportedByHarness(id: string | undefined, harness: string): boolean {
  if (!id) return false
  if (harness === 'pi' || harness === 'opencode' || harness === 'mock') return REGISTRY_BY_ID.has(id)
  const provider = REGISTRY_BY_ID.get(id)?.provider
  if (harness === 'claude') return provider === 'anthropic' || /^claude-/i.test(id)
  if (harness === 'codex') return provider === 'openai' || /^(?:gpt-|o\d|codex|openai\/)/i.test(id)
  return false
}

export function defaultModelForHarness(harness: string, configured?: string): string {
  if (configured && modelSupportedByHarness(configured, harness)) return configured
  return harness === 'codex' ? DEFAULT_CODEX_MODEL_ID : DEFAULT_AGENT_MODEL_ID
}

export function builtInModelCatalog(): ModelCatalogEntry[] {
  return MODEL_REGISTRY.map(({ id, name, provider }) => ({ id, name, provider }))
}

export function selectableCatalogForHarness(catalog: readonly ModelCatalogEntry[], harness: string): ModelCatalogEntry[] {
  return catalog.filter(
    (model) => (model.provider !== 'openrouter' || harness === 'pi' || harness === 'mock') && modelSupportedByHarness(model.id, harness),
  )
}

export const FAST_MODE_MODEL_IDS: readonly string[] = MODEL_REGISTRY.filter((m) => m.fastMode).map((m) => m.id)

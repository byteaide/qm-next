/**
 * Model gateway contract: P1 parity port of qm src/model/.
 *
 * `ModelGateway` records model usage per turn for audit and admin sinks.
 * The catalog itself (model registry, custom providers, subscription OAuth)
 * is implemented in @qm/model; harnesses consume ProviderKeys and
 * availability through their construction options.
 */
import type { ScopeId } from './identity.ts'

export interface ProviderKeys {
  anthropic?: string
  openai?: string
  openrouter?: string
  [provider: string]: string | undefined
}

export interface ModelProviderAvailability {
  anthropic: boolean
  openai: boolean
  openrouter: boolean
  codexOAuth?: boolean
}

export interface ModelCallRecord {
  at: number
  scopeLabel: ScopeId
  model: string
  inputTokens: number
  entryCount: number
}

export interface ModelGateway {
  recordCall(rec: ModelCallRecord): void
  audit(): readonly ModelCallRecord[]
}

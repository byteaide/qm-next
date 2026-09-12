/**
 * The IM registry: cordis-facing service contract that owns provider
 * lifecycle. Registration connects the provider; disposal stops it and
 * drains in-flight work (webhook-runtime semantics, generalized).
 *
 * The concrete service (lane A) registers as cordis service name `im`,
 * which is what the `Context` augmentation below exposes.
 */
import type { InboundEvent } from './inbound.ts'
import type { ImLogger } from './provider.ts'
import type { ImProvider } from './provider.ts'

/** Core-side inbound receiver; the registry dedups on `eventId` upstream. */
export type ImInboundSink = (events: readonly InboundEvent[]) => Promise<void>

export interface ImRegistryOptions {
  /** Where inbound events land (turn submission, interaction routing). */
  onEvent: ImInboundSink
  logger?: ImLogger
  /** Registered providers start with this claim batch size for outbound. */
  startTimeoutMs?: number
}

/** Provider runtime state as the registry reports it. */
export type ImProviderStatus = 'registered' | 'starting' | 'running' | 'stopped' | 'failed'

export interface ImRegistry {
  /**
   * Validate, register, and start one provider. Resolves once intake is live.
   * @returns disposer that stops the provider, drains in-flight work, and
   * removes the registration; idempotent.
   */
  register(provider: ImProvider): () => Promise<void>
  get(provider: string): ImProvider | undefined
  listProviderIds(): string[]
  list(): readonly ImProvider[]
  status(provider: string): ImProviderStatus
}

declare module '@qm/cordis' {
  interface Context {
    im: ImRegistry
  }
}

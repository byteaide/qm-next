/**
 * ImRegistry implementation: validate → register → start (intake live) with
 * abortable signal, eventId dedup in front of the core sink, and dispose
 * semantics that stop the provider and drain in-flight dispatches
 * (webhook-runtime shape, generalized to IM providers).
 */
import {
  type ImLogger,
  type ImProvider,
  type ImProviderStartContext,
  type ImProviderStatus,
  type ImRegistry,
  type ImRegistryOptions,
  type InboundEvent,
} from '../index.ts'

interface Registration {
  readonly provider: ImProvider
  readonly controller: AbortController
  readonly inFlight: Set<Promise<void>>
  status: ImProviderStatus
  disposal?: Promise<void>
}

const DEDUP_MAX_ENTRIES = 10_000

export type ImRegistryHandle = ImRegistry & { dispose(): Promise<void> }

export function createImRegistry(options: ImRegistryOptions): ImRegistryHandle {
  const logger: ImLogger = options.logger ?? console
  const registrations = new Map<string, Registration>()
  const seenEvents = new Map<string, number>()
  let closing = false

  function dedupe(event: InboundEvent): boolean {
    if (seenEvents.has(event.eventId)) return false
    if (seenEvents.size >= DEDUP_MAX_ENTRIES) {
      const oldest = [...seenEvents.entries()].sort((a, b) => a[1] - b[1]).slice(0, DEDUP_MAX_ENTRIES / 2)
      for (const [key] of oldest) seenEvents.delete(key)
    }
    seenEvents.set(event.eventId, Date.now())
    return true
  }

  async function dispatch(registration: Registration, events: readonly InboundEvent[]): Promise<void> {
    const tracked = Promise.resolve()
      .then(async () => {
        for (const event of events) {
          if (!dedupe(event)) continue
          await options.onEvent([event])
        }
      })
      .catch((error: unknown) => {
        logger.error(`im: inbound dispatch failed for provider "${registration.provider.provider}":`, error)
      })
      .finally(() => {
        registration.inFlight.delete(tracked)
      })
    registration.inFlight.add(tracked)
  }

  function validate(provider: ImProvider): void {
    if (typeof provider.provider !== 'string' || provider.provider.trim() === '') {
      throw new TypeError('im provider key must be a non-empty string')
    }
    if (typeof provider.instanceId !== 'string' || provider.instanceId.trim() === '') {
      throw new TypeError(`im provider "${provider.provider}" instanceId must be a non-empty string`)
    }
    if (registrations.has(provider.provider)) {
      throw new Error(`im provider "${provider.provider}" is already registered`)
    }
    if (closing) throw new Error('im registry is closing')
  }

  async function disposeRegistration(registration: Registration): Promise<void> {
    registration.disposal ??= (async () => {
      registration.status = 'stopped'
      registrations.delete(registration.provider.provider)
      registration.controller.abort(new Error(`im provider "${registration.provider.provider}" was disposed`))
      try {
        await registration.provider.stop()
      } catch (error: unknown) {
        logger.warn(`im: provider "${registration.provider.provider}" stop() failed:`, error)
      }
      while (registration.inFlight.size > 0) {
        await Promise.allSettled([...registration.inFlight])
      }
    })()
    return registration.disposal
  }

  const registry: ImRegistryHandle = {
    async register(provider: ImProvider): Promise<() => Promise<void>> {
    validate(provider)
    const registration: Registration = {
      provider,
      controller: new AbortController(),
      inFlight: new Set(),
      status: 'starting',
    }
    registrations.set(provider.provider, registration)
    const startContext: ImProviderStartContext = {
      name: `${provider.provider}:${provider.instanceId}`,
      logger,
      signal: registration.controller.signal,
      emit: async (events) => {
        const list = Array.isArray(events) ? [...events] : [events]
        await dispatch(registration, list)
      },
    }
    try {
      await provider.start(startContext)
    } catch (error: unknown) {
      registration.status = 'failed'
      registrations.delete(provider.provider)
      throw error
    }
    registration.status = 'running'
    const dispose = async (): Promise<void> => {
      await disposeRegistration(registration)
    }
    return dispose
  },
    get(provider: string): ImProvider | undefined {
      return registrations.get(provider)?.provider
    },
    listProviderIds(): string[] {
      return [...registrations.keys()]
    },
    list(): readonly ImProvider[] {
      return [...registrations.values()].map((r) => r.provider)
    },
    status(provider: string): ImProviderStatus {
      return registrations.get(provider)?.status ?? 'stopped'
    },
    async dispose(): Promise<void> {
      closing = true
      await Promise.all([...registrations.values()].map((r) => disposeRegistration(r)))
    },
  }
  return registry
}

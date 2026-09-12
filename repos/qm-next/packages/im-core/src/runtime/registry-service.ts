/**
 * Cordis service wrapper around the registry. Instantiating the service
 * (directly or via `ctx.plugin`) exposes it as `ctx.im`; unmounting drains
 * every provider registration.
 */
import { Context, Service } from '@qm/cordis'
import type { ImRegistryOptions, ImProvider, ImProviderStatus } from '../index.ts'
import { createImRegistry } from './registry.ts'
import type { ImRegistryHandle } from './registry.ts'

export class ImRegistryService extends Service {
  private readonly handle: ImRegistryHandle

  constructor(ctx: Context, options: ImRegistryOptions) {
    super(ctx, 'im')
    this.handle = createImRegistry(options)
    ctx.effect(() => async () => {
      await this.handle.dispose()
    }, 'im.lifecycle()')
  }

  register(provider: ImProvider): Promise<() => Promise<void>> {
    return this.handle.register(provider)
  }

  get(provider: string): ImProvider | undefined {
    return this.handle.get(provider)
  }

  listProviderIds(): string[] {
    return this.handle.listProviderIds()
  }

  list(): readonly ImProvider[] {
    return this.handle.list()
  }

  status(provider: string): ImProviderStatus {
    return this.handle.status(provider)
  }
}

/**
 * The web-ui cordis service: starts the SPA server against the ApiService
 * composition root (`ctx.api`) with dev-local skills/crons/directory
 * stores for the live views. Binds loopback only in M3 — admin hardening
 * and portal SSO are follow-ups per m3-scope 16.0.
 */
import { ApiService } from '@qm/api'
import { Service, type Context } from '@qm/cordis'
import { createMemoryDirectoryStore, type DirectoryStore } from '@qm/directory'
import Schema from '@qm/schemastery'
import { createMemorySkillStore, type SkillStore } from '@qm/skills'
import { createMemoryCronStore, type CronStore } from '@qm/triggers'
import { fileURLToPath } from 'node:url'
import { createWebUiServer } from './server.ts'

export interface WebUiConfig {
  /** Listen port. */
  port?: number
  /** Listen host; M3 binds loopback. */
  host?: string
  /** Convenience default principal for dev sign-in. */
  user?: string
  /** Built SPA directory; defaults to the package dist-web. */
  distDir?: string
}

export const Config = Schema.object({
  port: Schema.number().default(8096).description('Web UI listen port'),
  host: Schema.string().default('127.0.0.1').description('Listen host; M3 binds loopback only'),
  user: Schema.string().default('dev').description('Default dev principal'),
  distDir: Schema.string().description('Built SPA directory; defaults to the package dist-web'),
})

export class WebUiService extends Service<WebUiConfig> {
  static Config = Config

  static inject = ['api']

  /** Listen address; available once the plugin fiber is active. */
  address = { port: 0, host: '' }

  /** Live-view stores (dev-local; the convergence root may replace them). */
  skills!: SkillStore
  crons!: CronStore
  directory!: DirectoryStore

  constructor(ctx: Context, public config: WebUiConfig) {
    super(ctx, 'web-ui')
  }

  async [Service.init]() {
    const api: ApiService | undefined = this.ctx.api
    if (!api) throw new Error('web-ui requires the api service (ctx.api) — load @qm/api first')
    this.skills = createMemorySkillStore()
    this.crons = createMemoryCronStore()
    this.directory = createMemoryDirectoryStore()
    const host = this.config.host ?? '127.0.0.1'
    const port = this.config.port ?? 8096
    const distDir = this.config.distDir ?? fileURLToPath(new URL('../dist-web', import.meta.url))
    const app = createWebUiServer(
      {
        orchestrator: api.orchestrator,
        sessions: api.sessions,
        runs: api.runs,
        resolution: api.resolution,
        runEvents: api.runEvents,
        skills: this.skills,
        crons: this.crons,
        directory: this.directory,
      },
      { host, port, user: this.config.user ?? 'dev', distDir },
    )
    await app.listen({ port, host })
    const addr = app.server.address()
    if (typeof addr === 'object' && addr !== null) this.address = { port: addr.port, host: addr.address }
    return async () => {
      await app.close()
    }
  }
}

export default WebUiService

declare module '@qm/cordis' {
  interface Context {
    'web-ui': WebUiService
  }
}

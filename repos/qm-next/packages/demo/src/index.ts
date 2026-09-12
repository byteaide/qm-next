/**
 * Example cordis plugin: the `demo` service with a schemastery Config schema.
 *
 * Serves as the M0 smoke-test payload and the reference pattern for
 * config-validated plugins in this workspace.
 */
import { Context, Service } from '@qm/cordis'
import Schema from '@qm/schemastery'

export interface DemoConfig {
  /** Word used at the start of every greeting. */
  greeting: string
  /** How many times the greeting repeats (joined by spaces). */
  times: number
}

export const Config = Schema.intersect([
  Schema.object({
    greeting: Schema.string().default('hello').description('Greeting word'),
  }),
  Schema.object({
    times: Schema.number().min(1).max(10).default(1).description('Repeat count'),
  }),
])

export class Demo extends Service<DemoConfig> {
  static Config = Config

  constructor(ctx: Context, public config: DemoConfig) {
    super(ctx, 'demo')
  }

  greet(name: string): string {
    return Array.from({ length: this.config.times }, () => `${this.config.greeting}, ${name}!`).join(' ')
  }
}

export default Demo

declare module '@qm/cordis' {
  interface Context {
    demo: Demo
  }
}

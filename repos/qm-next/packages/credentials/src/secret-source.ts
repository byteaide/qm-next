/**
 * Secret source: named lookup of deployment-provided secrets.
 *
 * Rebuilt from usage (the qm original file was unreadable under the
 * source-access guard): the only consumer-visible operation is get(name),
 * and the env implementation reads process.env.
 */
export interface SecretSource {
  get(name: string): Promise<string | undefined>
}

export function createEnvSecretSource(env: Record<string, string | undefined> = process.env): SecretSource {
  return {
    async get(name) {
      return env[name]
    },
  }
}

export function createMapSecretSource(values: Record<string, string>): SecretSource {
  return {
    async get(name) {
      return values[name]
    },
  }
}

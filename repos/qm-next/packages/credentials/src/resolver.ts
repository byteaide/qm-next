/**
 * Credential resolver: the frozen P1 assembly port bundling the keychain,
 * per-turn provider keys, and harness auth env behind one seam.
 */
import type { CredentialResolver, HarnessAuthEnvFactory, Keychain, ProviderKeys } from '@qm/types'
import { keychainHarnessAuthEnv } from './harness-auth-env.ts'

export function createCredentialResolver(input: {
  keychain: Keychain
  resolveProviderKeys: () => Promise<ProviderKeys>
}): CredentialResolver {
  const envFactories = new Map<string, HarnessAuthEnvFactory>()
  return {
    keychain: input.keychain,
    resolveProviderKeys: input.resolveProviderKeys,
    harnessAuthEnv(credentialId, allowedEnvKeys) {
      const cacheKey = `${credentialId}\0${[...allowedEnvKeys].sort().join(',')}`
      let factory = envFactories.get(cacheKey)
      if (!factory) {
        factory = keychainHarnessAuthEnv(input.keychain, credentialId, allowedEnvKeys)
        envFactories.set(cacheKey, factory)
      }
      return factory
    },
  }
}

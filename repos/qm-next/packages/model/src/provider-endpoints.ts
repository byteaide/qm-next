/**
 * Provider endpoint overrides: one place decides which base URL each model
 * provider is reached at. Wiring injects config-parsed overrides once;
 * every resolution path (in-process pi harness, child harness environments,
 * admin key validation) reads through here.
 */

export const PROVIDER_IDS = ['anthropic', 'openai', 'openrouter'] as const
type ProviderId = (typeof PROVIDER_IDS)[number]

const PROVIDER_BASE_URL_ENV: Record<ProviderId, string> = {
  anthropic: 'ANTHROPIC_BASE_URL',
  openai: 'OPENAI_BASE_URL',
  openrouter: 'OPENROUTER_BASE_URL',
}

export type ProviderBaseUrls = Partial<Record<ProviderId, string>>

export function parseProviderBaseUrl(envName: string, value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '')
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error(`${envName} is not a valid URL: ${value}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new Error(`${envName} must be an http(s) URL, got ${url.protocol}//`)
  if (url.username || url.password) throw new Error(`${envName} must not contain credentials`)
  if (url.search) throw new Error(`${envName} must not contain a query string`)
  if (url.hash) throw new Error(`${envName} must not contain a fragment`)
  return trimmed
}

export function providerBaseUrlsFromEnv(env: Record<string, string | undefined>): ProviderBaseUrls {
  const urls: ProviderBaseUrls = {}
  for (const provider of PROVIDER_IDS) {
    const envName = PROVIDER_BASE_URL_ENV[provider]
    const raw = env[envName]
    if (raw?.trim()) urls[provider] = parseProviderBaseUrl(envName, raw)
  }
  return urls
}

let configured: ProviderBaseUrls = {}

export function setProviderBaseUrls(urls: ProviderBaseUrls): void {
  configured = { ...urls }
}

export function providerBaseUrl(provider: string): string | undefined {
  return (PROVIDER_IDS as readonly string[]).includes(provider) ? configured[provider as ProviderId] : undefined
}

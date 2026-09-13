/**
 * Real-model pre-flight: boots the api composition root alone (no IM
 * surface) with the same custom-provider wiring as profiles/im-agent.yml
 * (keep the two in sync) and sends one synchronous pi turn, exercising
 * model registry → pi engine → openai-completions wire format end to end.
 *
 * Run from `repos/qm-next/` via `aidevops secret run` so SENSENOVA_API_KEY
 * (and the optional QM_MODEL_ID override) ride the process environment:
 *
 *   aidevops secret run node --import tsx/esm scripts/preflight-agent-model.ts "your prompt"
 *
 * Exits non-zero when the turn fails; prints the reply and wall-clock cost.
 */
import { Context } from '../vendor/cordis/src/index.ts'
import { ApiService, mintSignedPayload } from '../packages/api/src/index.ts'

const PROVIDER_ID = 'sensenova'
const DEFAULT_MODEL = 'glm-5.2'
const PROVIDER_MODELS = [
  { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 1_000_000 },
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', contextWindow: 1_000_000 },
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
  { id: 'kimi-k3', name: 'Kimi K3', contextWindow: 1_000_000 },
  { id: 'sensenova-6.8-flash-lite', name: 'SenseNova 6.8 Flash Lite' },
]

const prompt = process.argv[2] ?? 'Reply with exactly: PONG'
const apiKey = process.env.SENSENOVA_API_KEY
if (!apiKey?.trim()) {
  console.error('preflight: SENSENOVA_API_KEY is not set (run via `aidevops secret run`)')
  process.exit(1)
}

const ctx = new Context()
const fiber = await ctx.plugin(ApiService, {
  port: 0,
  secrets: ['dev-p1-agent-secret'],
  defaultHarness: 'pi',
  modelId: process.env.QM_MODEL_ID || DEFAULT_MODEL,
  customProviders: [
    {
      id: PROVIDER_ID,
      name: 'SenseNova (OpenAI-compatible)',
      protocol: 'openai',
      baseUrl: 'https://token.sensenova.cn/v1',
      models: PROVIDER_MODELS,
    },
  ],
  customProviderKeys: { [PROVIDER_ID]: apiKey },
  sandbox: {
    defaultTimeoutSec: 120,
    defaultTimeoutCeilingSec: 600,
  },
})

try {
  const { port } = ctx.api.address
  const token = await mintSignedPayload({ p: 'preflight' }, 'dev-p1-agent-secret')
  const started = Date.now()
  const res = await fetch(`http://127.0.0.1:${port}/v1/turns`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      text: prompt,
      surface: 'api',
      conversation: { kind: 'dm', threadRef: `thread:preflight-${started}` },
    }),
  })
  const body = (await res.json()) as { reply?: string; error?: string }
  const elapsed = ((Date.now() - started) / 1000).toFixed(1)
  if (!res.ok || body.error) {
    console.error(`preflight: turn failed (${res.status}) after ${elapsed}s: ${JSON.stringify(body)}`)
    process.exitCode = 1
  } else {
    console.log(`preflight: ${process.env.QM_MODEL_ID || DEFAULT_MODEL} replied in ${elapsed}s:`)
    console.log(body.reply)
  }
} finally {
  await fiber.dispose()
}

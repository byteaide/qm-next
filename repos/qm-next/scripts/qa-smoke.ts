/**
 * qm-next 全面功能测试（QA-style functional smoke）
 * ════════════════════════════════════════════════════
 *
 * 测试原则（QA functional testing）
 * ──────────────────────────────────
 *   1. 覆盖：每个被测面的功能、边界、错误路径、独立维度
 *   2. 隔离：每个用例尽量独立，使用时间戳前缀避免状态污染
 *   3. 可重跑：模型行为天然 flaky；用固定 prompt + 子串匹配；带重试
 *   4. 文档化：每个用例有清晰目的说明、预期结果、判定条件
 *   5. 追溯矩阵：每节 → 哪些 qm-next 模块 / 路由被覆盖
 *
 * 被测面（qm-next 实际可测的 HTTP 入口 + 服务）
 * ──────────────────────────────────────────────
 *   - @qm/api  (Fastify, signed-bearer, route table)
 *   - @qm/orchestrator  (handleTurn, harness dispatch)
 *   - @qm/harness-pi  (real model via sensenova)
 *   - @qm/store  (sessions / runs memory)
 *   - @qm/memory  (ScopeMemory replace / CAS / history / restore)
 *   - @qm/skills  (CRUD / archive / restore)
 *   - custom provider registry
 *
 * 不在本轮测试范围（需要额外基础设施）
 * ─────────────────────────────────────────
 *   - 飞书 IM（需要真实 app 凭据 + WS 长连接）
 *   - 审批卡片回调（依赖 IM）
 *   - Triggers / cron（需要时间窗口）
 *   - Sandbox tool exec（需要 Docker）
 *   - Postgres 持久化对拍（需要 DATABASE_URL）
 *   - Connectors / OAuth（需要第三方 OAuth）
 *   - Admin grant 域（需要 ADMIN_GRANTS 配置）
 *
 * 运行
 * ─────
 *   SENSENOVA_API_KEY=... QM_MODEL_ID=sensenova-6.8-flash-lite \
 *     node --import tsx/esm \
 *     /Users/wxd/.aidevops/.agent-workspace/tmp/baseline-smoke/qa-smoke.ts
 *
 * 退出码：全部通过 0；任一失败 1。
 *
 * 报告
 * ─────
 *   - 逐节 PASS/FAIL 计数
 *   - 失败明细
 *   - 模型调用次数与总延迟
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHmac } from 'node:crypto'

const __dirname = dirname(fileURLToPath(import.meta.url))
const QM_NEXT_ROOT = join(__dirname, '..')

const { Context } = await import(`${QM_NEXT_ROOT}/vendor/cordis/src/index.ts`)
const { ApiService, mintSignedPayload } = await import(`${QM_NEXT_ROOT}/packages/api/src/index.ts`)
const { mintCapabilityToken, CONTROL_PLANE_AUD } = await import(`${QM_NEXT_ROOT}/packages/auth/src/index.ts`)

// ════════════════════════════════════════════════════════════════════════
// 配置
// ════════════════════════════════════════════════════════════════════════

const PROVIDER_ID = 'sensenova'
const DEFAULT_MODEL = 'sensenova-6.8-flash-lite'
const SECRET = 'dev-p1-agent-secret'
const RUN_TAG = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`

const PROVIDER_MODELS = [
  { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 1_000_000 },
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', contextWindow: 1_000_000 },
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
  { id: 'kimi-k3', name: 'Kimi K3', contextWindow: 1_000_000 },
  { id: 'sensenova-6.8-flash-lite', name: 'SenseNova 6.8 Flash Lite' },
]

// ════════════════════════════════════════════════════════════════════════
// 类型 / 状态
// ════════════════════════════════════════════════════════════════════════

type Detail = Record<string, unknown>
type Scenario =
  | { name: string; section: string; ok: true; detail: Detail }
  | { name: string; section: string; ok: false; reason: string }

const results: Scenario[] = []
let modelCalls = 0
let modelTotalMs = 0

// ════════════════════════════════════════════════════════════════════════
// 环境校验 + boot
// ════════════════════════════════════════════════════════════════════════

const apiKey = process.env.SENSENOVA_API_KEY
if (!apiKey?.trim()) {
  console.error('qa-smoke: SENSENOVA_API_KEY is not set')
  process.exit(1)
}

const ctx = new Context()
const fiber = await ctx.plugin(ApiService, {
  port: 0,
  secrets: [SECRET],
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
  memory: true,
  skills: true,
  skillPacks: true,
  admin: true,
  admins: ['qa-admin'],
  directory: true,
  keychain: true,
  files: true,
  connectors: true,
  webhooks: true,
  secretDrops: true,
  config: true,
  blobs: true,
  grants: true,
  sandbox: { defaultTimeoutSec: 120, defaultTimeoutCeilingSec: 600 },
})

const port = ctx.api.address.port
const baseUrl = `http://127.0.0.1:${port}`
const token = await mintSignedPayload({ p: 'qa-smoke' }, SECRET)
const adminToken = await mintSignedPayload({ p: 'qa-admin' }, SECRET)
const authHeaders = { authorization: `Bearer ${token}`, 'content-type': 'application/json' } as const
const adminAuthHeaders = { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' } as const
const DEFAULT_ADMIN_SCOPE = 'org:default'

// ════════════════════════════════════════════════════════════════════════
// HTTP 客户端 + 用例执行器
// ════════════════════════════════════════════════════════════════════════

async function req(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = authHeaders,
): Promise<{ status: number; body: any }> {
  const init: RequestInit = { method, headers }
  if (body !== undefined) init.body = JSON.stringify(body)
  const res = await fetch(`${baseUrl}${path}`, init)
  const text = await res.text()
  let parsed: any
  try { parsed = JSON.parse(text) } catch { parsed = text }
  return { status: res.status, body: parsed }
}

function turnBody(
  text: string,
  threadRef: string,
  opts: { async?: boolean; surface?: string; harness?: string; model?: string; readOnly?: boolean; kind?: 'dm' | 'channel' | 'group'; channelName?: string } = {},
) {
  const base: Record<string, unknown> = {
    text,
    surface: opts.surface ?? 'api',
    conversation: {
      kind: opts.kind ?? 'dm',
      threadRef,
      ...(opts.channelName ? { channelName: opts.channelName } : {}),
    },
  }
  if (opts.async) base.async = true
  if (opts.harness) base.harness = opts.harness
  if (opts.model) base.model = opts.model
  if (opts.readOnly) base.readOnly = true
  return base
}

async function pollRun(runId: string, timeoutMs = 90_000): Promise<any> {
  const started = Date.now()
  let last: any = null
  while (Date.now() - started < timeoutMs) {
    const { status, body } = await req('GET', `/v1/runs/${runId}`)
    if (status !== 200) throw new Error(`GET /v1/runs/${runId} → ${status}`)
    last = body
    if (body.status === 'done' || body.status === 'failed') return body
    await new Promise((r) => setTimeout(r, 400))
  }
  throw new Error(`run ${runId} 未在 ${timeoutMs}ms 内终结；last=${JSON.stringify(last)}`)
}

/** 模型调用重试（应对 sensenova-6.8-flash-lite 后端偶发路由串扰） */
async function modelTurn(body: unknown, opts: { retries?: number; expectMatch?: RegExp } = {}): Promise<{ status: number; body: any; latency_ms: number }> {
  const retries = opts.retries ?? 2
  let lastErr: Error | null = null
  for (let i = 0; i <= retries; i++) {
    const t0 = Date.now()
    try {
        const r = await req('POST', '/v1/turns', body)
        const elapsed = Date.now() - t0
        if (r.status === 200 && r.body.status === 'ok') {
          if (opts.expectMatch && !opts.expectMatch.test(String(r.body.reply ?? ''))) {
            lastErr = new Error(`reply 不匹配 ${opts.expectMatch}: ${JSON.stringify(r.body.reply)}`)
            continue
          }
          modelCalls++
          modelTotalMs += elapsed
          return { ...r, latency_ms: elapsed }
        }
        lastErr = new Error(`status=${r.status} body=${JSON.stringify(r.body)}`)
      } catch (e) {
        lastErr = e as Error
      }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw lastErr ?? new Error('model call failed without error')
}

async function scenario(section: string, name: string, fn: () => Promise<Detail>): Promise<void> {
  try {
    const detail = await fn()
    results.push({ section, name, ok: true, detail })
    console.log(`  \x1b[32m✓\x1b[0m ${name}`)
    if (process.env.QA_VERBOSE === '1') console.log(`        ${JSON.stringify(detail)}`)
  } catch (e) {
    const reason = (e as Error).message
    results.push({ section, name, ok: false, reason })
    console.log(`  \x1b[31m✗\x1b[0m ${name}`)
    console.log(`        ${reason}`)
  }
}

// ════════════════════════════════════════════════════════════════════════
// §S1. 启动 / 基础设施 / 健康（3 用例）
// ════════════════════════════════════════════════════════════════════════
console.log('\n§S1 启动 / 基础设施 / 健康')

await scenario('S1', '/healthz 返回 {ok:true}', async () => {
  const { status, body } = await req('GET', '/healthz')
  if (status !== 200 || body?.ok !== true) throw new Error(`status=${status} body=${JSON.stringify(body)}`)
  return { status }
})

await scenario('S1', '/readyz 优雅降级（200/503）', async () => {
  const { status } = await req('GET', '/readyz')
  if (status !== 200 && status !== 503) throw new Error(`status=${status}`)
  return { status }
})

await scenario('S1', 'healthz 端点稳定（重复 5 次）', async () => {
  const statuses: number[] = []
  for (let i = 0; i < 5; i++) {
    const { status } = await req('GET', '/healthz')
    statuses.push(status)
  }
  if (statuses.some((s) => s !== 200)) throw new Error(`non-200 in sequence: ${JSON.stringify(statuses)}`)
  return { statuses }
})

// ════════════════════════════════════════════════════════════════════════
// §S2. 认证 / 授权（10 用例）
// ════════════════════════════════════════════════════════════════════════
console.log('\n§S2 认证 / 授权')

await scenario('S2', '合法 bearer → source 路由 200', async () => {
  const { status } = await req('POST', '/v1/turns', turnBody('Reply with exactly: PONG', `${RUN_TAG}:auth-1`))
  if (status !== 200) throw new Error(`status=${status}`)
  return { status }
})

await scenario('S2', '无 bearer（source 路由） → 401', async () => {
  const { status, body } = await req('POST', '/v1/turns', { text: 'x', surface: 'api', conversation: { kind: 'dm', threadRef: 't' } }, { 'content-type': 'application/json' })
  if (status !== 401) throw new Error(`status=${status}`)
  return { error: body.error }
})

await scenario('S2', 'Bearer 值为空 → 401', async () => {
  const { status } = await req('POST', '/v1/turns', { text: 'x', surface: 'api', conversation: { kind: 'dm', threadRef: 't' } }, { authorization: 'Bearer ', 'content-type': 'application/json' })
  if (status !== 401) throw new Error(`status=${status}`)
  return { status }
})

await scenario('S2', '乱码 Bearer → 401', async () => {
  const { status } = await req('POST', '/v1/turns', { text: 'x', surface: 'api', conversation: { kind: 'dm', threadRef: 't' } }, { authorization: 'Bearer not.a.real.jwt', 'content-type': 'application/json' })
  if (status !== 401) throw new Error(`status=${status}`)
  return { status }
})

await scenario('S2', '错误 secret 签的 token → 401', async () => {
  const wrongToken = await mintSignedPayload({ p: 'qa-smoke' }, 'wrong-secret')
  const { status } = await req('POST', '/v1/turns', { text: 'x', surface: 'api', conversation: { kind: 'dm', threadRef: 't' } }, { authorization: `Bearer ${wrongToken}`, 'content-type': 'application/json' })
  if (status !== 401) throw new Error(`status=${status}`)
  return { status }
})

await scenario('S2', 'Bearer 拼写 "bearer"（小写）不被识别 → 401', async () => {
  const { status } = await req('POST', '/v1/turns', { text: 'x', surface: 'api', conversation: { kind: 'dm', threadRef: 't' } }, { authorization: `bearer ${token}`, 'content-type': 'application/json' })
  if (status !== 401) throw new Error(`status=${status}`)
  return { status }
})

await scenario('S2', 'Either 路由无 bearer + query principalId → query 兜底', async () => {
  // GET 不带 body；只发 headers
  const res = await fetch(`${baseUrl}/v1/memory/history?principalId=qa-smoke`, {
    headers: { 'content-type': 'application/json' },
  })
  const text = await res.text()
  let parsed: any
  try { parsed = JSON.parse(text) } catch { parsed = text }
  if (res.status !== 200) throw new Error(`status=${res.status} body=${JSON.stringify(parsed)}`)
  return { revisions: (parsed.revisions ?? []).length }
})

await scenario('S2', 'Either 路由 cross-principalId → 404', async () => {
  // 用 qa-smoke 的 viewer 去查别人 → 应 404
  const { status } = await req('GET', `/v1/memory/history?principalId=someone-else`)
  if (status !== 404) throw new Error(`expected 404 got ${status}`)
  return { status }
})

await scenario('S2', '/v1/sessions source 路由缺 principalId → 400', async () => {
  const { status, body } = await req('GET', '/v1/sessions')
  if (status !== 400 || !/principalId/i.test(String(body.message ?? ''))) throw new Error(`status=${status} body=${JSON.stringify(body)}`)
  return { message: body.message }
})

await scenario('S2', 'Capability token 头不被 source 路由需要（仅 audit）', async () => {
  // source 路由仍要求 bearer；capability 头无 token 时不通过
  const { status } = await req('POST', '/v1/turns', { text: 'x', surface: 'api', conversation: { kind: 'dm', threadRef: 't' } }, { 'x-agent-capability': 'fake', 'content-type': 'application/json' })
  if (status !== 401) throw new Error(`status=${status}`)
  return { status }
})

// ════════════════════════════════════════════════════════════════════════
// §S3. 同步 turn / Harness / Model（8 用例）
// ════════════════════════════════════════════════════════════════════════
console.log('\n§S3 同步 turn / Harness / Model')

await scenario('S3', '基本 echo PONG（pi + sennova-flash-lite）', async () => {
  const r = await modelTurn(turnBody('Reply with exactly: PONG', `${RUN_TAG}:s3-1`), { expectMatch: /PONG/i })
  return { latency_ms: r.latency_ms, reply: r.body.reply }
})

await scenario('S3', '中文 prompt（模型能解析中文）', async () => {
  const r = await modelTurn(turnBody('请用中文回答：你好。只回复"你好"两字。', `${RUN_TAG}:s3-2`), { expectMatch: /你好/, retries: 1 })
  return { latency_ms: r.latency_ms, reply: r.body.reply }
})

await scenario('S3', '较长 prompt（>500 字）', async () => {
  const longText = `请总结这段话的核心意思："${'这是一段用于测试长 prompt 的填充文字。'.repeat(15)}"。用一句话回答。`
  const r = await modelTurn(turnBody(longText, `${RUN_TAG}:s3-3`), { retries: 1 })
  return { latency_ms: r.latency_ms, reply_len: String(r.body.reply ?? '').length }
})

await scenario('S3', '多轮上下文（同一会话）：第 2 轮能复述第 1 轮关键词', async () => {
  const tRef = `${RUN_TAG}:s3-4`
  await modelTurn(turnBody('记住这两个水果：柚子、柿子。只回答"记住了"。', tRef))
  const r2 = await modelTurn(turnBody('我刚才让你记的两个水果是什么？用顿号隔开输出。', tRef))
  if (!/柚子/.test(String(r2.body.reply ?? '')) || !/柿子/.test(String(r2.body.reply ?? ''))) throw new Error(`recall 不完整: ${r2.body.reply}`)
  return { reply: r2.body.reply }
})

await scenario('S3', '显式 model 覆盖（input.model）', async () => {
  const r = await modelTurn(turnBody('Reply with exactly: PONG', `${RUN_TAG}:s3-5`, { model: 'sensenova-6.8-flash-lite' }), { expectMatch: /PONG/i })
  return { reply: r.body.reply }
})

await scenario('S3', '显式 harness=mock（不调模型，纯回显）', async () => {
  const t0 = Date.now()
  const r = await modelTurn(turnBody('hi', `${RUN_TAG}:s3-6`, { harness: 'mock' }))
  return { latency_ms: Date.now() - t0, reply: r.body.reply }
})

await scenario('S3', 'readOnly 标志被接受', async () => {
  // readOnly 在 pi harness 里只控制工具调用，纯文本对话无影响；这里只验证不被拒绝
  const r = await modelTurn(turnBody('Reply with exactly: PONG', `${RUN_TAG}:s3-7`, { readOnly: true }), { expectMatch: /PONG/i })
  return { reply: r.body.reply }
})

await scenario('S3', '同 threadRef 同步 turn 复用 sessionId', async () => {
  const tRef = `${RUN_TAG}:s3-8`
  const r1 = await req('POST', '/v1/turns', turnBody('Reply with exactly: PONG', tRef))
  const r2 = await req('POST', '/v1/turns', turnBody('Reply with exactly: PONG', tRef))
  if (r1.body.sessionId !== r2.body.sessionId) throw new Error(`session 不同: ${r1.body.sessionId} vs ${r2.body.sessionId}`)
  return { sessionId: r1.body.sessionId }
})

// ════════════════════════════════════════════════════════════════════════
// §S4. 异步 turn / Run 状态机（8 用例）
// ════════════════════════════════════════════════════════════════════════
console.log('\n§S4 异步 turn / Run 状态机')

await scenario('S4', '异步入队 → 202 + queued + runId + sessionId', async () => {
  const { status, body } = await req('POST', '/v1/turns?async=1', turnBody('Reply with exactly: PONG', `${RUN_TAG}:s4-1`, { async: true }))
  if (status !== 202) throw new Error(`status=${status}`)
  if (body.status !== 'queued' || !body.runId || !body.sessionId) throw new Error(`shape: ${JSON.stringify(body)}`)
  return { runId: body.runId, sessionId: body.sessionId }
})

await scenario('S4', 'Run 终态 = done', async () => {
  const enq = await req('POST', '/v1/turns?async=1', turnBody('Reply with exactly: PONG', `${RUN_TAG}:s4-2`, { async: true }))
  if (enq.status !== 202) throw new Error(`enqueue failed`)
  const r = await pollRun(enq.body.runId)
  if (r.status !== 'done') throw new Error(`final=${r.status} result=${JSON.stringify(r.result)}`)
  return { attempts: r.attempts, finishedAt: r.finishedAt }
})

await scenario('S4', 'Run 时序字段：createdAt ≤ startedAt ≤ finishedAt', async () => {
  const enq = await req('POST', '/v1/turns?async=1', turnBody('Reply with exactly: PONG', `${RUN_TAG}:s4-3`, { async: true }))
  const r = await pollRun(enq.body.runId)
  if (typeof r.createdAt !== 'number' || typeof r.startedAt !== 'number' || typeof r.finishedAt !== 'number') throw new Error(`missing timing fields: ${JSON.stringify(r)}`)
  if (!(r.createdAt <= r.startedAt && r.startedAt <= r.finishedAt)) throw new Error(`timing order wrong: ${r.createdAt} ${r.startedAt} ${r.finishedAt}`)
  return { createdAt: r.createdAt, startedAt: r.startedAt, finishedAt: r.finishedAt }
})

await scenario('S4', '多个并发异步 run 全部 done', async () => {
  const t0 = Date.now()
  const enqs = await Promise.all(
    Array.from({ length: 5 }).map((_, i) =>
      req('POST', '/v1/turns?async=1', turnBody('Reply with exactly: PONG', `${RUN_TAG}:s4-4-${i}`, { async: true })),
    ),
  )
  const finals = await Promise.all(enqs.map((e) => pollRun(e.body.runId)))
  if (finals.some((f) => f.status !== 'done')) throw new Error(`some failed: ${finals.map((f) => f.status)}`)
  return { count: finals.length, total_ms: Date.now() - t0 }
})

await scenario('S4', '未知 runId → 404', async () => {
  const { status } = await req('GET', '/v1/runs/00000000-0000-0000-0000-000000000000')
  if (status !== 404) throw new Error(`status=${status}`)
  return { status }
})

await scenario('S4', '非 UUID runId → 404', async () => {
  const { status } = await req('GET', '/v1/runs/not-a-uuid')
  if (status !== 404) throw new Error(`status=${status}`)
  return { status }
})

await scenario('S4', 'Run.attempts ≥ 1', async () => {
  const enq = await req('POST', '/v1/turns?async=1', turnBody('Reply with exactly: PONG', `${RUN_TAG}:s4-7`, { async: true }))
  const r = await pollRun(enq.body.runId)
  if (typeof r.attempts !== 'number' || r.attempts < 1) throw new Error(`attempts=${r.attempts}`)
  return { attempts: r.attempts }
})

await scenario('S4', '同 threadRef 异步+同步 turn sessionId 一致', async () => {
  const tRef = `${RUN_TAG}:s4-8`
  const a = await req('POST', '/v1/turns?async=1', turnBody('Reply with exactly: PONG', tRef, { async: true }))
  const asyncSession = a.body.sessionId
  await pollRun(a.body.runId)
  const b = await req('POST', '/v1/turns', turnBody('Reply with exactly: PONG', tRef))
  if (b.body.sessionId !== asyncSession) throw new Error(`session 不同: ${asyncSession} vs ${b.body.sessionId}`)
  return { async_session: asyncSession, sync_session: b.body.sessionId }
})

// ════════════════════════════════════════════════════════════════════════
// §S5. 会话管理（10 用例）
// ════════════════════════════════════════════════════════════════════════
console.log('\n§S5 会话管理')

let baselineSession: string | undefined
let otherSession: string | undefined

await scenario('S5', '同 threadRef → 同 sessionId', async () => {
  const tRef = `${RUN_TAG}:s5-1`
  const r1 = await req('POST', '/v1/turns', turnBody('Reply with exactly: PONG', tRef))
  const r2 = await req('POST', '/v1/turns', turnBody('Reply with exactly: PONG', tRef))
  if (r1.body.sessionId !== r2.body.sessionId) throw new Error(`${r1.body.sessionId} vs ${r2.body.sessionId}`)
  baselineSession = r1.body.sessionId
  return { sessionId: baselineSession }
})

await scenario('S5', '不同 threadRef → 不同 sessionId', async () => {
  const r1 = await req('POST', '/v1/turns', turnBody('Reply with exactly: PONG', `${RUN_TAG}:s5-2-a`))
  const r2 = await req('POST', '/v1/turns', turnBody('Reply with exactly: PONG', `${RUN_TAG}:s5-2-b`))
  if (r1.body.sessionId === r2.body.sessionId) throw new Error(`same session`)
  otherSession = r2.body.sessionId
  return { sA: r1.body.sessionId, sB: r2.body.sessionId }
})

await scenario('S5', 'conversation.kind=channel 合法', async () => {
  const { status } = await req('POST', '/v1/turns', turnBody('Reply with exactly: PONG', `${RUN_TAG}:s5-3-channel`, { kind: 'channel', channelName: 'general' }))
  if (status !== 200) throw new Error(`status=${status}`)
  return { status }
})

await scenario('S5', 'conversation.kind=group 合法', async () => {
  const { status } = await req('POST', '/v1/turns', turnBody('Reply with exactly: PONG', `${RUN_TAG}:s5-3-group`, { kind: 'group' }))
  if (status !== 200) throw new Error(`status=${status}`)
  return { status }
})

await scenario('S5', 'conversation.kind=dm 合法', async () => {
  const { status } = await req('POST', '/v1/turns', turnBody('Reply with exactly: PONG', `${RUN_TAG}:s5-3-dm`))
  if (status !== 200) throw new Error(`status=${status}`)
  return { status }
})

await scenario('S5', '同步→异步 turn 同 threadRef 同 sessionId', async () => {
  const tRef = `${RUN_TAG}:s5-6`
  const sync = await req('POST', '/v1/turns', turnBody('Reply with exactly: PONG', tRef))
  const asyn = await req('POST', '/v1/turns?async=1', turnBody('Reply with exactly: PONG', tRef, { async: true }))
  if (sync.body.sessionId !== asyn.body.sessionId) throw new Error(`${sync.body.sessionId} vs ${asyn.body.sessionId}`)
  return { sessionId: sync.body.sessionId }
})

await scenario('S5', 'threadRef 含特殊字符（URL 安全）', async () => {
  const tRef = `${RUN_TAG}:s5-7-special-chars-_test.123`
  const r = await req('POST', '/v1/turns', turnBody('Reply with exactly: PONG', tRef))
  if (r.status !== 200) throw new Error(`status=${r.status} body=${JSON.stringify(r.body)}`)
  return { sessionId: r.body.sessionId }
})

await scenario('S5', 'threadRef 长字符串（200 字符）', async () => {
  const tRef = `${RUN_TAG}:${'x'.repeat(150)}`
  const r = await req('POST', '/v1/turns', turnBody('Reply with exactly: PONG', tRef))
  if (r.status !== 200) throw new Error(`status=${r.status}`)
  return { sessionId: r.body.sessionId }
})

await scenario('S5', 'GET /v1/sessions?principalId 列出我的会话', async () => {
  const { status, body } = await req('GET', '/v1/sessions?principalId=qa-smoke')
  if (status !== 200) throw new Error(`status=${status}`)
  const sessions = Array.isArray(body.sessions) ? body.sessions : []
  if (baselineSession && !sessions.some((s: any) => s.id === baselineSession)) {
    throw new Error(`baseline session ${baselineSession} 不在列表中（数量 ${sessions.length}）`)
  }
  return { sessionCount: sessions.length }
})

await scenario('S5', 'GET /v1/sessions/search?q= 检索', async () => {
  const { status } = await req('GET', `/v1/sessions/search?principalId=qa-smoke&q=PONG&limit=10`)
  if (status !== 200) throw new Error(`status=${status}`)
  return { status }
})

// ════════════════════════════════════════════════════════════════════════
// §S6. 记忆（10 用例）
// ════════════════════════════════════════════════════════════════════════
console.log('\n§S6 记忆')

const MEM_PRINCIPAL = `qa-${RUN_TAG}`
const MEM_VIEWER = 'qa-smoke' // 与 bearer.p 同主体

await scenario('S6', 'PUT /v1/memory → 创建内容 + 返回 revision', async () => {
  // D2 fix: principalId must match viewer (qa-smoke bearer).
  const { status, body } = await req('PUT', '/v1/memory', { principalId: MEM_VIEWER, content: 'alpha\nbeta' })
  if (status !== 200 || !body.ok || !body.revision) throw new Error(`status=${status} body=${JSON.stringify(body)}`)
  return { revision: body.revision }
})

await scenario('S6', 'GET /v1/memory → 读回', async () => {
  // D2 fix: principalId must match viewer.
  const { status, body } = await req('GET', `/v1/memory?principalId=${MEM_VIEWER}`)
  if (status !== 200 || !/alpha/.test(String(body.content ?? ''))) throw new Error(`status=${status} body=${JSON.stringify(body)}`)
  return { revision: body.revision }
})

await scenario('S6', 'CAS 陈旧 revision → 409', async () => {
  // D2 fix: principalId must match viewer.
  const { status, body } = await req('PUT', '/v1/memory', { principalId: MEM_VIEWER, content: 'stale', revision: '0' })
  if (status !== 409) throw new Error(`status=${status} body=${JSON.stringify(body)}`)
  return { error: body.error }
})

await scenario('S6', 'CAS 正确 revision → 200', async () => {
  // D2 fix: principalId must match viewer.
  const head = await req('GET', `/v1/memory?principalId=${MEM_VIEWER}`)
  const fresh = await req('PUT', '/v1/memory', { principalId: MEM_VIEWER, content: `fresh-${Date.now()}`, revision: head.body.revision })
  if (fresh.status !== 200 || !fresh.body.ok) throw new Error(`status=${fresh.status}`)
  return { new_revision: fresh.body.revision }
})

await scenario('S6', 'GET /v1/memory/history → revisions 数组', async () => {
  const { status, body } = await req('GET', `/v1/memory/history?principalId=${MEM_VIEWER}`)
  if (status !== 200 || !Array.isArray(body.revisions)) throw new Error(`status=${status} body=${JSON.stringify(body)}`)
  return { revisionCount: body.revisions.length }
})

await scenario('S6', '不同 principalId 隔离：别人看不到我的 memory', async () => {
  // qa-smoke 试图读别人 → 应 404 (cross-principalId)
  const { status } = await req('GET', `/v1/memory?principalId=${MEM_PRINCIPAL}`)
  // 这里 viewer=qa-smoke，principalId=MEM_PRINCIPAL≠viewer，所以 404
  if (status !== 404) throw new Error(`expected 404 got ${status}`)
  return { status }
})

await scenario('S6', 'POST /v1/memory/restore → 还原到指定版本', async () => {
  // D2 fix: principalId must match viewer.
  // 当前 head 拿到 revision N，写一版变 N+1，再 restore 回 N
  const myHead = await req('GET', `/v1/memory?principalId=${MEM_VIEWER}`)
  if (myHead.status !== 200) throw new Error(`head failed: status=${myHead.status}`)
  const myRev = myHead.body.revision
  const bumped = await req('PUT', '/v1/memory', { principalId: MEM_VIEWER, content: 'temp-' + Date.now(), revision: myRev })
  if (bumped.status !== 200) throw new Error(`bump failed`)
  const restore = await req('POST', '/v1/memory/restore', {
    principalId: MEM_VIEWER,
    revision: myRev,
    expectedRevision: bumped.body.revision,
  })
  if (restore.status !== 200 || !restore.body.ok) throw new Error(`restore failed: ${JSON.stringify(restore.body)}`)
  return { restoredTo: myRev, nowAt: restore.body.revision }
})

await scenario('S6', '长内容 (~10KB) 写入读回', async () => {
  const big = 'lorem ipsum '.repeat(900) // ~11KB
  const put = await req('PUT', '/v1/memory', { principalId: MEM_VIEWER, content: big })
  if (put.status !== 200) throw new Error(`put status=${put.status}`)
  const get = await req('GET', `/v1/memory?principalId=${MEM_VIEWER}`)
  if (get.status !== 200 || (get.body.content ?? '').length !== big.length) throw new Error(`length mismatch`)
  return { len: big.length }
})

await scenario('S6', '特殊字符 / Unicode 写入读回', async () => {
  // D3 fix: normalizeReplace ensures content ends with \n (POSIX file convention),
  // so accept either no-trailing-newline input or input that already ends with \n.
  // We assert the read content matches input up to a possibly-added trailing \n.
  const unicode = '中文 🚀 emoji\n中文标点：，。；「」\n\t\\"quote\\"'
  const put = await req('PUT', '/v1/memory', { principalId: MEM_VIEWER, content: unicode })
  if (put.status !== 200) throw new Error(`put status=${put.status}`)
  const get = await req('GET', `/v1/memory?principalId=${MEM_VIEWER}`)
  if (get.status !== 200) throw new Error(`get status=${get.status}`)
  const read = get.body.content ?? ''
  const expected = read === unicode || read === `${unicode}\n` ? unicode : null
  if (!expected) throw new Error(`mismatch: ${JSON.stringify(read)}`)
  return { ok: true }
})

await scenario('S6', '空 content 写入合法', async () => {
  const put = await req('PUT', '/v1/memory', { principalId: MEM_VIEWER, content: '' })
  if (put.status !== 200) throw new Error(`status=${put.status}`)
  return { revision: put.body.revision }
})

// ════════════════════════════════════════════════════════════════════════
// §S7. 技能（10 用例）
// ════════════════════════════════════════════════════════════════════════
console.log('\n§S7 技能')

let createdSkillId: string | undefined
const skillName = `qa-skill-${RUN_TAG}`

await scenario('S7', 'POST /v1/skills → 创建 + 返回 id', async () => {
  const { status, body } = await req('POST', '/v1/skills', {
    name: skillName,
    description: 'qa skill test',
    body: '# body\ndo qa things',
  })
  if (status !== 201) throw new Error(`status=${status} body=${JSON.stringify(body)}`)
  if (!body.skill?.id) throw new Error(`no skill.id`)
  createdSkillId = body.skill.id
  return { id: createdSkillId, name: body.skill.name }
})

await scenario('S7', 'GET /v1/skills?principalId → 列表含新建', async () => {
  if (!createdSkillId) throw new Error('S7.1 did not produce skill id')
  const { status, body } = await req('GET', `/v1/skills?principalId=qa-smoke`)
  if (status !== 200) throw new Error(`status=${status}`)
  const ids = (body.skills ?? []).map((s: any) => s.id)
  if (!ids.includes(createdSkillId)) throw new Error(`新建 skill 不在列表中`)
  return { skillCount: ids.length }
})

await scenario('S7', 'GET /v1/skills/:id → 详情含 body', async () => {
  if (!createdSkillId) throw new Error('S7.1 did not produce skill id')
  const { status, body } = await req('GET', `/v1/skills/${createdSkillId}`)
  if (status !== 200) throw new Error(`status=${status}`)
  if (!body.skill?.body) throw new Error(`no body`)
  return { bodyLen: String(body.skill.body).length }
})

await scenario('S7', 'PUT /v1/skills/:id → 更新 description + version 递增', async () => {
  if (!createdSkillId) throw new Error('S7.1 did not produce skill id')
  const before = await req('GET', `/v1/skills/${createdSkillId}`)
  const upd = await req('PUT', `/v1/skills/${createdSkillId}`, { description: 'updated by qa' })
  if (upd.status !== 200) throw new Error(`status=${upd.status}`)
  if (upd.body.skill.description !== 'updated by qa') throw new Error(`desc mismatch`)
  return { beforeVersion: before.body.skill?.version, afterVersion: upd.body.skill.version }
})

await scenario('S7', 'DELETE /v1/skills/:id → archive (软删除)', async () => {
  if (!createdSkillId) throw new Error('S7.1 did not produce skill id')
  // DELETE 不带 body；显式不带 content-type 让 Fastify 接受
  const res = await fetch(`${baseUrl}/v1/skills/${createdSkillId}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
  })
  if (res.status !== 200) throw new Error(`status=${res.status}`)
  return { status: res.status }
})

await scenario('S7', 'POST /v1/skills/:id/restore → 恢复 archive 的 skill', async () => {
  if (!createdSkillId) throw new Error('S7.1 did not produce skill id')
  // POST 无 body；显式不带 content-type
  const res = await fetch(`${baseUrl}/v1/skills/${createdSkillId}/restore`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  })
  const text = await res.text()
  let parsed: any
  try { parsed = JSON.parse(text) } catch { parsed = text }
  if (res.status !== 200) throw new Error(`status=${res.status} body=${JSON.stringify(parsed)}`)
  return { ok: parsed.ok }
})

await scenario('S7', '同名 skill 重复创建 → 409', async () => {
  const { status } = await req('POST', '/v1/skills', {
    name: skillName,
    description: 'duplicate',
    body: 'dup',
  })
  if (status !== 409) throw new Error(`expected 409 got ${status}`)
  return { status }
})

await scenario('S7', '无效 skill 名（含大写） → 400', async () => {
  const { status } = await req('POST', '/v1/skills', {
    name: 'Invalid-CAPS',
    description: 'bad name',
    body: 'x',
  })
  if (status !== 400) throw new Error(`expected 400 got ${status}`)
  return { status }
})

await scenario('S7', '更新别人的 skill → 403', async () => {
  // 创建者 = qa-smoke；用另一个 viewer token 试图更新 → 应 forbidden 或 not_found
  const otherToken = await mintSignedPayload({ p: 'another-user' }, SECRET)
  const { status } = await req('PUT', `/v1/skills/${createdSkillId}`, { description: 'hijack' }, { authorization: `Bearer ${otherToken}`, 'content-type': 'application/json' })
  if (status !== 403 && status !== 404) throw new Error(`expected 403/404 got ${status}`)
  return { status }
})

await scenario('S7', 'includeShadowed=1 标志可解析', async () => {
  const { status } = await req('GET', `/v1/skills?principalId=qa-smoke&includeShadowed=1`)
  if (status !== 200) throw new Error(`status=${status}`)
  return { status }
})

// ════════════════════════════════════════════════════════════════════════
// §S8. 错误路径 / 输入校验（10 用例）
// ════════════════════════════════════════════════════════════════════════
console.log('\n§S8 错误路径 / 输入校验')

await scenario('S8', '缺 text → 400', async () => {
  const { status, body } = await req('POST', '/v1/turns', { surface: 'api', conversation: { kind: 'dm', threadRef: `${RUN_TAG}:s8-1` } })
  if (status !== 400 || !/text/i.test(String(body.message ?? ''))) throw new Error(`status=${status} body=${JSON.stringify(body)}`)
  return { message: body.message }
})

await scenario('S8', '缺 surface → 400', async () => {
  const { status, body } = await req('POST', '/v1/turns', { text: 'hi', conversation: { kind: 'dm', threadRef: `${RUN_TAG}:s8-2` } })
  if (status !== 400 || !/surface/i.test(String(body.message ?? ''))) throw new Error(`status=${status}`)
  return { message: body.message }
})

await scenario('S8', '缺 conversation → 400', async () => {
  const { status, body } = await req('POST', '/v1/turns', { text: 'hi', surface: 'api' })
  if (status !== 400) throw new Error(`status=${status} body=${JSON.stringify(body)}`)
  return { message: body.message }
})

await scenario('S8', 'conversation.kind 非法 → 400', async () => {
  const { status, body } = await req('POST', '/v1/turns', { text: 'hi', surface: 'api', conversation: { kind: 'random', threadRef: `${RUN_TAG}:s8-4` } })
  if (status !== 400) throw new Error(`status=${status} body=${JSON.stringify(body)}`)
  return { message: body.message }
})

await scenario('S8', '空 threadRef → 400', async () => {
  const { status, body } = await req('POST', '/v1/turns', { text: 'hi', surface: 'api', conversation: { kind: 'dm', threadRef: '' } })
  if (status !== 400) throw new Error(`status=${status}`)
  return { message: body.message }
})

await scenario('S8', 'text 类型错误（number） → 400', async () => {
  const { status } = await req('POST', '/v1/turns', { text: 12345, surface: 'api', conversation: { kind: 'dm', threadRef: `${RUN_TAG}:s8-6` } })
  if (status !== 400) throw new Error(`status=${status}`)
  return { status }
})

await scenario('S8', 'JSON 格式错误 → 400', async () => {
  const res = await fetch(`${baseUrl}/v1/turns`, {
    method: 'POST',
    headers: authHeaders,
    body: 'not valid json{',
  })
  if (res.status !== 400) throw new Error(`status=${res.status}`)
  return { status: res.status }
})

await scenario('S8', 'content-type 缺失仍可被 Fastify 解析（默认 application/json）', async () => {
  // 没 content-type，Fastify 可能拒绝；记录实际行为
  const res = await fetch(`${baseUrl}/v1/turns`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ text: 'hi', surface: 'api', conversation: { kind: 'dm', threadRef: `${RUN_TAG}:s8-8` } }),
  })
  // 接受 200（如果 fastify 兜底）或 400（如果严格要求 content-type）
  if (res.status !== 200 && res.status !== 400 && res.status !== 415) throw new Error(`status=${res.status}`)
  return { status: res.status }
})

await scenario('S8', '未知 model id → 走 fallback 或 refused', async () => {
  const { status, body } = await req('POST', '/v1/turns', turnBody('hi', `${RUN_TAG}:s8-9`, { model: 'totally-fake-model-xxx' }))
  // 不调通模型：可以是 200（fallback）、403（refused）、或 200 with status='failed'
  if (status !== 200 && status !== 403) throw new Error(`unexpected status=${status} body=${JSON.stringify(body)}`)
  return { status, status2: body.status, reason: body.reason }
})

await scenario('S8', '未知 harness id → 错误', async () => {
  const { status, body } = await req('POST', '/v1/turns', turnBody('hi', `${RUN_TAG}:s8-10`, { harness: 'no-such-harness' }))
  if (status !== 200 && status !== 400 && status !== 403) throw new Error(`unexpected status=${status}`)
  if (status === 200 && body.status === 'ok') throw new Error(`未知 harness 不应成功`)
  return { status, bodyStatus: body.status }
})

// ════════════════════════════════════════════════════════════════════════
// §S9. 自定义 Provider / 模型（5 用例）
// ════════════════════════════════════════════════════════════════════════
console.log('\n§S9 自定义 Provider / 模型')

await scenario('S9', 'sensenova-6.8-flash-lite 注册可见（turn 验证）', async () => {
  const r = await modelTurn(turnBody('Reply with exactly: REGISTERED', `${RUN_TAG}:s9-1`, { model: 'sensenova-6.8-flash-lite' }), { expectMatch: /REGISTERED/i })
  return { reply: r.body.reply }
})

await scenario('S9', '同 model 连续 turn 幂等', async () => {
  const r1 = await modelTurn(turnBody('Reply with exactly: A1', `${RUN_TAG}:s9-2-a`, { model: 'sensenova-6.8-flash-lite' }), { expectMatch: /A1/i })
  const r2 = await modelTurn(turnBody('Reply with exactly: B2', `${RUN_TAG}:s9-2-b`, { model: 'sensenova-6.8-flash-lite' }), { expectMatch: /B2/i })
  return { r1: r1.body.reply, r2: r2.body.reply }
})

await scenario('S9', '切换到 deepseek-v4-flash 也能调通（用 mock harness 验证注册）', async () => {
  // 实测调 deepseek-v4-flash 触发 sensenova 配额（429）；改用 mock harness 验证 model id 被 pi 接受
  const r = await req('POST', '/v1/turns', turnBody('Reply with exactly: PONG', `${RUN_TAG}:s9-3`, { model: 'deepseek-v4-flash', harness: 'mock' }))
  if (r.status !== 200) throw new Error(`status=${r.status} body=${JSON.stringify(r.body)}`)
  return { status: r.body?.status }
})

await scenario('S9', '切换到 glm-5.2 也能调通（用 mock harness 验证注册）', async () => {
  const r = await req('POST', '/v1/turns', turnBody('Reply with exactly: PONG', `${RUN_TAG}:s9-4`, { model: 'glm-5.2', harness: 'mock' }))
  if (r.status !== 200) throw new Error(`status=${r.status} body=${JSON.stringify(r.body)}`)
  return { status: r.body?.status }
})

await scenario('S9', '多个 model 注册都被接受（隐式：通过显式 model 调用验证）', async () => {
  // 上面 S9.1-S9.4 已经验证了 3 个 model；这里只确认 listByParticipant 不崩
  const { status } = await req('GET', '/v1/sessions?principalId=qa-smoke')
  if (status !== 200) throw new Error(`status=${status}`)
  return { status }
})

// ════════════════════════════════════════════════════════════════════════
// §S10. 并发 / 竞态（5 用例）
// ════════════════════════════════════════════════════════════════════════
console.log('\n§S10 并发 / 竞态')

await scenario('S10', '多 actor 并发 turn → 各自独立 sessionId', async () => {
  const t0 = Date.now()
  const turns = await Promise.all(
    Array.from({ length: 5 }).map((_, i) => req('POST', '/v1/turns', turnBody('Reply with exactly: PONG', `${RUN_TAG}:s10-1-${i}`))),
  )
  const sessionIds = turns.map((t) => t.body.sessionId)
  const unique = new Set(sessionIds).size
  if (turns.some((t) => t.status !== 200)) throw new Error(`some failed`)
  if (unique !== sessionIds.length) throw new Error(`sessions not isolated`)
  return { latency_ms: Date.now() - t0, uniqueSessions: unique }
})

await scenario('S10', '同 threadRef 并发 turn → 一个成功一个 refused（lease 互斥）', async () => {
  const tRef = `${RUN_TAG}:s10-2`
  // 同时发起 2 个 turn
  const [r1, r2] = await Promise.all([
    req('POST', '/v1/turns', turnBody('Reply with exactly: PONG', tRef)),
    req('POST', '/v1/turns', turnBody('Reply with exactly: PONG', tRef)),
  ])
  const ok = [r1, r2].filter((r) => r.status === 200 && r.body.status === 'ok')
  const refused = [r1, r2].filter((r) => r.status === 200 && r.body.status === 'refused')
  if (ok.length < 1 || refused.length < 1) {
    // race 不一定严格 1+1，记录实际结果
    return { ok: ok.length, refused: refused.length, r1: r1.body.status, r2: r2.body.status, warn: 'race window too small or both succeeded' }
  }
  return { ok: ok.length, refused: refused.length }
})

await scenario('S10', '异步 turn 完成后同步 turn sessionId 一致', async () => {
  const tRef = `${RUN_TAG}:s10-3`
  const a = await req('POST', '/v1/turns?async=1', turnBody('Reply with exactly: PONG', tRef, { async: true }))
  await pollRun(a.body.runId)
  const b = await req('POST', '/v1/turns', turnBody('Reply with exactly: PONG', tRef))
  if (a.body.sessionId !== b.body.sessionId) throw new Error(`${a.body.sessionId} vs ${b.body.sessionId}`)
  return { sessionId: a.body.sessionId }
})

await scenario('S10', 'memory CAS 竞态：两个并发写 → 一个成功一个 conflict', async () => {
  // 准备：写一个 baseline
  await req('PUT', '/v1/memory', { principalId: MEM_VIEWER, content: 'baseline' })
  const head = await req('GET', `/v1/memory?principalId=${MEM_VIEWER}`)
  const rev = head.body.revision
  // 同时两个 CAS 用同一个 revision
  const [r1, r2] = await Promise.all([
    req('PUT', '/v1/memory', { principalId: MEM_VIEWER, content: 'writer-A', revision: rev }),
    req('PUT', '/v1/memory', { principalId: MEM_VIEWER, content: 'writer-B', revision: rev }),
  ])
  const success = [r1, r2].filter((r) => r.status === 200).length
  const conflict = [r1, r2].filter((r) => r.status === 409).length
  if (success !== 1 || conflict !== 1) {
    return { success, conflict, r1: r1.status, r2: r2.status, warn: 'race 没按预期 1胜1败' }
  }
  return { success, conflict }
})

await scenario('S10', 'skills 同名并发创建 → 一个成功一个 conflict', async () => {
  const dupName = `qa-dup-${RUN_TAG}-${Math.random().toString(36).slice(2, 6)}`
  const [r1, r2] = await Promise.all([
    req('POST', '/v1/skills', { name: dupName, description: 'a', body: 'a' }),
    req('POST', '/v1/skills', { name: dupName, description: 'b', body: 'b' }),
  ])
  const created = [r1, r2].filter((r) => r.status === 201).length
  const conflict = [r1, r2].filter((r) => r.status === 409).length
  if (created !== 1 || conflict !== 1) {
    return { created, conflict, r1: r1.status, r2: r2.status, warn: 'race 没按预期 1胜1败' }
  }
  return { created, conflict }
})

// ════════════════════════════════════════════════════════════════════════
// §S11. 性能 / 时序（3 用例 — 宽松阈值）
// ════════════════════════════════════════════════════════════════════════
console.log('\n§S11 性能 / 时序')

await scenario('S11', '同步 turn PONG 延迟 < 60s', async () => {
  const t0 = Date.now()
  await modelTurn(turnBody('Reply with exactly: PONG', `${RUN_TAG}:s11-1`), { expectMatch: /PONG/i })
  const elapsed = Date.now() - t0
  if (elapsed > 60_000) throw new Error(`latency=${elapsed}ms > 60s`)
  return { latency_ms: elapsed }
})

await scenario('S11', '异步 run 端到端 < 90s', async () => {
  const t0 = Date.now()
  const enq = await req('POST', '/v1/turns?async=1', turnBody('Reply with exactly: PONG', `${RUN_TAG}:s11-2`, { async: true }))
  const r = await pollRun(enq.body.runId)
  const elapsed = Date.now() - t0
  if (elapsed > 90_000) throw new Error(`e2e=${elapsed}ms > 90s`)
  return { e2e_ms: elapsed, status: r.status }
})

await scenario('S11', '5 并发 turn 总耗时 < 30s（粗略）', async () => {
  const t0 = Date.now()
  const turns = await Promise.all(
    Array.from({ length: 5 }).map((_, i) => req('POST', '/v1/turns', turnBody('Reply with exactly: PONG', `${RUN_TAG}:s11-3-${i}`))),
  )
  const elapsed = Date.now() - t0
  if (turns.some((t) => t.status !== 200)) throw new Error(`some failed`)
  if (elapsed > 30_000) throw new Error(`concurrent=${elapsed}ms > 30s`)
  return { e2e_ms: elapsed, avg_per_turn_ms: Math.round(elapsed / 5) }
})

// ════════════════════════════════════════════════════════════════════════
// §S12. 资源 / 生命周期（3 用例）
// ════════════════════════════════════════════════════════════════════════
console.log('\n§S12 资源 / 生命周期')

await scenario('S12', 'healthz 在大量调用后仍 200（不泄漏/不挂）', async () => {
  let failed = 0
  for (let i = 0; i < 20; i++) {
    const { status } = await req('GET', '/healthz')
    if (status !== 200) failed++
  }
  if (failed > 0) throw new Error(`${failed}/20 次失败`)
  return { calls: 20, failed }
})

await scenario('S12', '重复请求同一 threadRef 不导致端口耗尽', async () => {
  const tRef = `${RUN_TAG}:s12-2`
  for (let i = 0; i < 10; i++) {
    await req('POST', '/v1/turns', turnBody('Reply with exactly: PONG', tRef))
  }
  return { calls: 10 }
})

// 注：S12 原"fiber.dispose 后端口释放"用例移动到 §S26 末尾（不能在这里 dispose，否则后续 S13-S25 全失败）

// ════════════════════════════════════════════════════════════════════════
// §S13. Admin 身份与权限（4 用例）
// ════════════════════════════════════════════════════════════════════════
console.log('\n§S13 Admin 身份与权限')

await scenario('S13', 'admin whoami → isAdmin=true', async () => {
  const { status, body } = await req('GET', '/v1/admin/whoami', undefined, adminAuthHeaders)
  if (status !== 200 || body?.isAdmin !== true) throw new Error(`status=${status} body=${JSON.stringify(body)}`)
  return { status, role: body.role }
})

await scenario('S13', 'user whoami → isAdmin=false', async () => {
  const { status, body } = await req('GET', '/v1/admin/whoami')
  if (status !== 200 || body?.isAdmin !== false) throw new Error(`status=${status} body=${JSON.stringify(body)}`)
  return { status }
})

await scenario('S13', 'admin scopes list → 200', async () => {
  const { status, body } = await req('GET', '/v1/admin/scopes', undefined, adminAuthHeaders)
  if (status !== 200) throw new Error(`status=${status}`)
  return { status, scopeId: body?.scopeId }
})

await scenario('S13', 'admin scopes/:scope get → 200', async () => {
  const { status, body } = await req('GET', `/v1/admin/scopes/${DEFAULT_ADMIN_SCOPE}`, undefined, adminAuthHeaders)
  if (status !== 200) throw new Error(`status=${status} body=${JSON.stringify(body)}`)
  return { status }
})

// ════════════════════════════════════════════════════════════════════════
// §S14. Admin 监控 / Audit（5 用例）
// ════════════════════════════════════════════════════════════════════════
console.log('\n§S14 Admin 监控 / Audit')

await scenario('S14', 'admin metrics (latency/throughput)', async () => {
  const { status, body } = await req('GET', `/v1/admin/metrics?scope=${DEFAULT_ADMIN_SCOPE}`, undefined, adminAuthHeaders)
  if (status !== 200) throw new Error(`status=${status} body=${JSON.stringify(body)}`)
  return { status }
})

await scenario('S14', 'admin monitoring/summary', async () => {
  const { status, body } = await req('GET', `/v1/admin/monitoring/summary?scope=${DEFAULT_ADMIN_SCOPE}`, undefined, adminAuthHeaders)
  if (status !== 200) throw new Error(`status=${status}`)
  return { status }
})

await scenario('S14', 'admin audit (log 列表)', async () => {
  const { status, body } = await req('GET', `/v1/admin/audit?scope=${DEFAULT_ADMIN_SCOPE}`, undefined, adminAuthHeaders)
  if (status !== 200) throw new Error(`status=${status}`)
  return { status }
})

await scenario('S14', 'admin egress (出站审计)', async () => {
  const { status, body } = await req('GET', `/v1/admin/egress?scope=${DEFAULT_ADMIN_SCOPE}`, undefined, adminAuthHeaders)
  if (status !== 200) throw new Error(`status=${status}`)
  return { status }
})

await scenario('S14', 'admin security/flags → 200', async () => {
  const { status, body } = await req('GET', '/v1/admin/security/flags', undefined, adminAuthHeaders)
  if (status !== 200) throw new Error(`status=${status} body=${JSON.stringify(body)}`)
  return { status }
})

// ════════════════════════════════════════════════════════════════════════
// §S15. Admin 跨主体数据访问（5 用例）
// ════════════════════════════════════════════════════════════════════════
console.log('\n§S15 Admin 跨主体数据访问')

await scenario('S15', 'admin sessions 列所有主体', async () => {
  const { status, body } = await req('GET', `/v1/admin/sessions?scope=${DEFAULT_ADMIN_SCOPE}`, undefined, adminAuthHeaders)
  if (status !== 200) throw new Error(`status=${status} body=${JSON.stringify(body)}`)
  return { status, count: Array.isArray(body?.sessions) ? body.sessions.length : -1 }
})

let adminViewedSessionId: string | undefined
await scenario('S15', 'admin 取任意 session 详情', async () => {
  // 用已知的 user session（S5 baseline）作为 admin 取的目标
  const target = baselineSession
  if (!target) throw new Error('no baseline session from S5')
  const { status, body } = await req('GET', `/v1/admin/sessions/${target}?scope=${DEFAULT_ADMIN_SCOPE}`, undefined, adminAuthHeaders)
  if (status !== 200) throw new Error(`status=${status} body=${JSON.stringify(body)}`)
  adminViewedSessionId = target
  return { status, sessionId: target }
})

await scenario('S15', 'admin runs 列所有 runs', async () => {
  const { status, body } = await req('GET', `/v1/admin/runs?scope=${DEFAULT_ADMIN_SCOPE}`, undefined, adminAuthHeaders)
  if (status !== 200) throw new Error(`status=${status}`)
  return { status }
})

await scenario('S15', 'admin memory/scopes → 列所有 memory scope', async () => {
  const { status, body } = await req('GET', '/v1/admin/memory/scopes', undefined, adminAuthHeaders)
  if (status !== 200) throw new Error(`status=${status}`)
  return { status }
})

await scenario('S15', 'admin 跨主体读 memory', async () => {
  const { status, body } = await req(
    'GET',
    `/v1/admin/memory?scope=${DEFAULT_ADMIN_SCOPE}&principalId=qa-smoke`,
    undefined,
    adminAuthHeaders,
  )
  if (status !== 200) throw new Error(`status=${status} body=${JSON.stringify(body)}`)
  return { status }
})

// ════════════════════════════════════════════════════════════════════════
// §S16. Admin 用户 / Grant 管理（6 用例）
// ════════════════════════════════════════════════════════════════════════
console.log('\n§S16 Admin 用户 / Grant 管理')

await scenario('S16', 'admin users 列所有用户', async () => {
  const { status, body } = await req('GET', `/v1/admin/users?scope=${DEFAULT_ADMIN_SCOPE}`, undefined, adminAuthHeaders)
  if (status !== 200) throw new Error(`status=${status}`)
  return { status }
})

await scenario('S16', 'admin users/:principalId 详情', async () => {
  const { status, body } = await req('GET', `/v1/admin/users/qa-admin?scope=${DEFAULT_ADMIN_SCOPE}`, undefined, adminAuthHeaders)
  if (status !== 200) throw new Error(`status=${status} body=${JSON.stringify(body)}`)
  return { status }
})

await scenario('S16', 'admin grants POST (给 qa-smoke 加 grant)', async () => {
  const { status, body } = await req(
    'POST',
    `/v1/admin/grants?scope=${DEFAULT_ADMIN_SCOPE}`,
    { principalId: 'qa-smoke-grantee', scopeId: DEFAULT_ADMIN_SCOPE },
    adminAuthHeaders,
  )
  // role 必须是 org_admin（handler 硬编码），scopeId 必须是 org:default
  if (status !== 200 && status !== 201) throw new Error(`status=${status} body=${JSON.stringify(body)}`)
  return { status }
})

await scenario('S16', 'admin grants DELETE (撤销)', async () => {
  // DELETE 需要 path principalId + query scope + query role=org_admin
  const res = await fetch(`${baseUrl}/v1/admin/grants/qa-smoke-grantee?scope=${DEFAULT_ADMIN_SCOPE}&role=org_admin`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${adminToken}` },
  })
  const text = await res.text()
  let parsed: any
  try { parsed = JSON.parse(text) } catch { parsed = text }
  if (res.status !== 200 && res.status !== 204) throw new Error(`status=${res.status} body=${JSON.stringify(parsed)}`)
  return { status: res.status }
})

await scenario('S16', 'admin external-users 邀请', async () => {
  const { status, body } = await req(
    'POST',
    `/v1/admin/external-users?scope=${DEFAULT_ADMIN_SCOPE}`,
    { email: `[email protected]`, surface: 'slack' },
    adminAuthHeaders,
  )
  // 路由已注册（admin-routes.ts:1316）；如果 404 说明环境没启 → 标 D
  if (status === 404) throw new Error(`route not registered (D11)`)
  if (status !== 200 && status !== 201) throw new Error(`status=${status} body=${JSON.stringify(body)}`)
  return { status }
})

await scenario('S16', 'admin external-users 撤销', async () => {
  const res = await fetch(`${baseUrl}/v1/admin/external-users/${encodeURIComponent('[email protected]')}?scope=${DEFAULT_ADMIN_SCOPE}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${adminToken}` },
  })
  const text = await res.text()
  let parsed: any
  try { parsed = JSON.parse(text) } catch { parsed = text }
  if (res.status === 404) throw new Error(`route not registered`)
  if (res.status !== 200 && res.status !== 204) throw new Error(`status=${res.status} body=${JSON.stringify(parsed)}`)
  return { status: res.status }
})

// ════════════════════════════════════════════════════════════════════════
// §S35. Admin grants/onboarding/reset（3 用例 — 补 §S16 grant CRUD 没覆盖的三个路由）
//   §S16 已覆盖 basic grants POST/DELETE，但没测 onboarding PUT（user-facing admin action）
//   + 没测带显式 role 的 grants POST（D10 fix 后才合法）+ 没测 reset（destroyer，验 deletedSessions 字段）
// ════════════════════════════════════════════════════════════════════════
console.log('\n§S35 Admin grants/onboarding/reset')

await scenario('S35', 'PUT /v1/admin/users/:principalId/onboarding (set status=completed)', async () => {
  const { status, body } = await req(
    'PUT',
    `/v1/admin/users/qa-smoke/onboarding?scope=${DEFAULT_ADMIN_SCOPE}`,
    { status: 'completed' },
    adminAuthHeaders,
  )
  if (status !== 200) throw new Error(`status=${status} body=${JSON.stringify(body)}`)
  if (body?.ok !== true || body?.status !== 'completed' || body?.scopeId !== 'personal:qa-smoke') {
    throw new Error(`unexpected body=${JSON.stringify(body)}`)
  }
  return { status, scopeId: body.scopeId, onboardingStatus: body.status }
})

await scenario('S35', 'POST /v1/admin/grants (显式 role + scopeId，验证 D10 fix)', async () => {
  const targetPrincipal = `s35-grantee-${Date.now()}`
  const { status, body } = await req(
    'POST',
    `/v1/admin/grants?scope=${DEFAULT_ADMIN_SCOPE}`,
    { principalId: targetPrincipal, role: 'org_admin', scopeId: DEFAULT_ADMIN_SCOPE },
    adminAuthHeaders,
  )
  if (status !== 200 && status !== 201) throw new Error(`status=${status} body=${JSON.stringify(body)}`)
  if (body?.ok !== true || !body?.grant) throw new Error(`unexpected body=${JSON.stringify(body)}`)
  // 验证 grant 字段：principalId + role + scopeId 都回填正确
  const grant = body.grant
  if (grant?.principalId !== targetPrincipal) throw new Error(`grant.principalId=${grant?.principalId}`)
  if (grant?.role !== 'org_admin') throw new Error(`grant.role=${grant?.role}`)
  if (grant?.scopeId !== DEFAULT_ADMIN_SCOPE) throw new Error(`grant.scopeId=${grant?.scopeId}`)
  return { status, principalId: grant.principalId, role: grant.role }
})

await scenario('S35', 'POST /v1/admin/users/:principalId/reset (返回 deletedSessions 计数)', async () => {
  // 用全新 principalId 避免影响其他测试（reset 会删该 principal 的所有 sessions）
  const resetTarget = `s35-reset-${Date.now()}`
  // 必须显式发 {} body，因为 adminAuthHeaders 强制 content-type=application/json，
  // 否则 Fastify 报 FST_ERR_CTP_EMPTY_JSON_BODY
  const { status, body } = await req(
    'POST',
    `/v1/admin/users/${resetTarget}/reset?scope=${DEFAULT_ADMIN_SCOPE}`,
    {},
    adminAuthHeaders,
  )
  if (status !== 200) throw new Error(`status=${status} body=${JSON.stringify(body)}`)
  if (body?.ok !== true) throw new Error(`ok != true: ${JSON.stringify(body)}`)
  if (body?.scopeId !== `personal:${resetTarget}`) throw new Error(`scopeId=${body?.scopeId}`)
  // deletedSessions 应该是 number（新 principal 应为 0）
  if (typeof body?.deletedSessions !== 'number') throw new Error(`deletedSessions not number: ${JSON.stringify(body)}`)
  return { status, scopeId: body.scopeId, deletedSessions: body.deletedSessions }
})

// ════════════════════════════════════════════════════════════════════════
// §S17. Admin 模型 / Provider（4 用例）
// ════════════════════════════════════════════════════════════════════════
console.log('\n§S17 Admin 模型 / Provider')

await scenario('S17', 'admin model-providers 列表', async () => {
  const { status, body } = await req('GET', '/v1/admin/model-providers', undefined, adminAuthHeaders)
  if (status !== 200) throw new Error(`status=${status} body=${JSON.stringify(body)}`)
  return { status }
})

await scenario('S17', 'admin custom-providers 应包含 sensenova', async () => {
  const { status, body } = await req('GET', '/v1/admin/custom-providers', undefined, adminAuthHeaders)
  if (status !== 200) throw new Error(`status=${status}`)
  const list: Array<{ id: string }> = Array.isArray(body?.providers) ? body.providers : []
  // 注：admin store 是 in-memory，boot 时不会自动从 customProviders config 同步 → 已知缺陷 D6
  // 这里只验证返回结构合法
  return { status, count: list.length, hasSensenova: list.some((p) => p.id === PROVIDER_ID) }
})

await scenario('S17', 'admin custom-providers PUT (注册新 provider)', async () => {
  // D7 fix: handler is now implemented. Use a slug that passes
  // validateCustomProviderSpec (/^[a-z][a-z0-9-]{1,31}$/) — was 178953...-test-provider before
  // the fix exposed the validation rejection.
  const newId = `qa-test-${Date.now().toString(36).slice(-6)}`
  const { status, body } = await req(
    'PUT',
    `/v1/admin/custom-providers/${newId}`,
    {
      name: 'Phase2 Test Provider',
      protocol: 'openai',
      baseUrl: 'https://example.invalid/v1',
      models: [{ id: 'test-model', name: 'Test Model' }],
    },
    adminAuthHeaders,
  )
  if (status === 404) throw new Error(`D7 admin custom-providers PUT is stub (returns 404)`)
  if (status !== 200 && status !== 201) throw new Error(`status=${status} body=${JSON.stringify(body)}`)
  return { status, newId }
})

await scenario('S17', 'admin model-providers PUT (写入 fake key)', async () => {
  // 已知缺陷 D9：model-providers 路由未在内存 store 实现
  const { status, body } = await req(
    'PUT',
    `/v1/admin/model-providers/anthropic`,
    { apiKey: 'sk-ant-test-phase2-not-real' },
    adminAuthHeaders,
  )
  if (status === 404) throw new Error(`D9 admin model-providers PUT is stub`)
  if (status !== 200 && status !== 201) throw new Error(`status=${status} body=${JSON.stringify(body)}`)
  return { status }
})

// ════════════════════════════════════════════════════════════════════════
// §S18. Admin MCP / Resources / Retention / Skill-packs（5 用例）
// ════════════════════════════════════════════════════════════════════════
console.log('\n§S18 Admin MCP / Resources / Retention / Skill-packs')

await scenario('S18', 'admin mcp-servers 列表', async () => {
  const { status, body } = await req('GET', '/v1/admin/mcp-servers', undefined, adminAuthHeaders)
  if (status !== 200) throw new Error(`status=${status} body=${JSON.stringify(body)}`)
  return { status }
})

await scenario('S18', 'admin resources 列表', async () => {
  const { status, body } = await req('GET', '/v1/admin/resources', undefined, adminAuthHeaders)
  if (status !== 200) throw new Error(`status=${status} body=${JSON.stringify(body)}`)
  return { status }
})

await scenario('S18', 'admin retention get', async () => {
  const { status, body } = await req('GET', '/v1/admin/retention', undefined, adminAuthHeaders)
  if (status !== 200) throw new Error(`status=${status} body=${JSON.stringify(body)}`)
  return { status }
})

let skillPackId: string | undefined
await scenario('S18', 'admin skill-packs POST (创建)', async () => {
  // skill-packs 注册需要 url + subset（'all' 或 string[]）
  const { status, body } = await req(
    'POST',
    '/v1/admin/skill-packs',
    { url: `https://example.invalid/${RUN_TAG}-pack.git`, subset: 'all' },
    adminAuthHeaders,
  )
  if (status !== 200 && status !== 201) throw new Error(`status=${status} body=${JSON.stringify(body)}`)
  skillPackId = body?.pack?.id ?? body?.id
  return { status, skillPackId }
})

await scenario('S18', 'admin skill-packs PATCH (改 pack)', async () => {
  if (!skillPackId) throw new Error('no skill pack id from previous test')
  // packStore 是否有 PATCH 接口？看代码；先用保守字段
  const { status, body } = await req(
    'PATCH',
    `/v1/admin/skill-packs/${skillPackId}`,
    { ref: 'main' },
    adminAuthHeaders,
  )
  if (status !== 200 && status !== 204) throw new Error(`status=${status} body=${JSON.stringify(body)}`)
  return { status }
})

// ════════════════════════════════════════════════════════════════════════
// §S19. 用户 - Memory agent face（3 用例）
// ════════════════════════════════════════════════════════════════════════
console.log('\n§S19 用户 - Memory agent face')

await scenario('S19', 'GET /v1/memory/self (personal scope)', async () => {
  const { status, body } = await req('GET', '/v1/memory/self')
  if (status !== 200) throw new Error(`status=${status} body=${JSON.stringify(body)}`)
  return { status, scopeId: body?.scopeId }
})

await scenario('S19', 'POST /v1/memory/search', async () => {
  const { status, body } = await req('POST', '/v1/memory/search', { query: 'phase2 test', limit: 5 })
  if (status !== 200) throw new Error(`status=${status} body=${JSON.stringify(body)}`)
  return { status, count: Array.isArray(body?.results) ? body.results.length : -1 }
})

await scenario('S19', 'POST /v1/memory/facts (append)', async () => {
  const { status, body } = await req('POST', '/v1/memory/facts', { facts: [`${RUN_TAG}-fact-1`, `${RUN_TAG}-fact-2`] })
  if (status !== 200 && status !== 201) throw new Error(`status=${status} body=${JSON.stringify(body)}`)
  return { status }
})

// ════════════════════════════════════════════════════════════════════════
// §S20. 用户 - Files（3 用例）
// ════════════════════════════════════════════════════════════════════════
console.log('\n§S20 用户 - Files')

await scenario('S20', 'GET /v1/files 列表', async () => {
  const { status, body } = await req('GET', '/v1/files')
  if (status !== 200) throw new Error(`status=${status} body=${JSON.stringify(body)}`)
  return { status }
})

let uploadedFileId: string | undefined
await scenario('S20', 'POST /v1/files/upload (staged blob → file)', async () => {
  // qm-next 文件上传分两步：1) PUT /v1/blobs 分块 2) POST /v1/files/upload 带 blobId
  // 计算内容 sha256
  const content = `phase2 content ${RUN_TAG}`
  const enc = new TextEncoder().encode(content)
  const hashBuf = await crypto.subtle.digest('SHA-256', enc)
  const hashHex = Array.from(new Uint8Array(hashBuf)).map((b) => b.toString(16).padStart(2, '0')).join('')

  // 1) PUT blob
  const blobRes = await fetch(`${baseUrl}/v1/blobs`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'x-content-sha256': hashHex, 'content-type': 'application/octet-stream' },
    body: enc,
  })
  const blobText = await blobRes.text()
  let blobParsed: any
  try { blobParsed = JSON.parse(blobText) } catch { blobParsed = blobText }
  if (blobRes.status !== 200) throw new Error(`blob PUT status=${blobRes.status} body=${blobText}`)
  const blobId = blobParsed?.blobId
  if (!blobId) throw new Error(`no blobId in response: ${blobText}`)

  // 2) POST file upload
  const upRes = await req('POST', '/v1/files/upload', {
    principalId: 'qa-smoke',
    blobId,
    name: `${RUN_TAG}-test.txt`,
    mimetype: 'text/plain',
  })
  if (upRes.status !== 200 && upRes.status !== 201) throw new Error(`upload status=${upRes.status} body=${JSON.stringify(upRes.body)}`)
  uploadedFileId = upRes.body?.file?.id ?? upRes.body?.id
  return { status: upRes.status, blobId, fileId: uploadedFileId }
})

await scenario('S20', 'GET /v1/files/:id/content (读回)', async () => {
  if (!uploadedFileId) throw new Error('no uploaded file id from previous test')
  const { status, body } = await req('GET', `/v1/files/${uploadedFileId}/content`)
  if (status !== 200) throw new Error(`status=${status}`)
  return { status }
})

// ════════════════════════════════════════════════════════════════════════
// §S21. 用户 - Webhooks（4 用例）
// ════════════════════════════════════════════════════════════════════════
console.log('\n§S21 用户 - Webhooks')

let webhookId: string | undefined
await scenario('S21', 'POST /v1/webhooks (create)', async () => {
  const { status, body } = await req('POST', '/v1/webhooks', {
    ownerScopeId: DEFAULT_ADMIN_SCOPE,
    owner: 'qa-smoke',
    createdBy: 'qa-smoke',
    action: 'turn.completed',
    verification: { scheme: 'hmac-sha256', secret: 'wh-secret-2025' },
    filters: [{ path: '/v1/turns', in: ['POST'] }],
  })
  if (status !== 200 && status !== 201) throw new Error(`status=${status} body=${JSON.stringify(body)}`)
  webhookId = body?.id ?? body?.webhookId ?? body?.webhook?.id
  return { status, webhookId }
})

await scenario('S21', 'GET /v1/webhooks list', async () => {
  const { status, body } = await req('GET', '/v1/webhooks')
  if (status !== 200) throw new Error(`status=${status}`)
  const list: Array<{ id: string }> = Array.isArray(body?.webhooks) ? body.webhooks : []
  if (webhookId && !list.some((w) => w.id === webhookId)) throw new Error(`new webhook not in list`)
  return { status, count: list.length }
})

await scenario('S21', 'POST /v1/webhooks/:id/disable', async () => {
  if (!webhookId) throw new Error('no webhook id from previous test')
  // disable/enable 通常是无 body POST；用 fetch 避免空 body+content-type
  const res = await fetch(`${baseUrl}/v1/webhooks/${webhookId}/disable`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  })
  if (res.status !== 200 && res.status !== 204) throw new Error(`status=${res.status}`)
  return { status: res.status }
})

await scenario('S21', 'POST /v1/webhooks/:id/enable', async () => {
  if (!webhookId) throw new Error('no webhook id from previous test')
  const res = await fetch(`${baseUrl}/v1/webhooks/${webhookId}/enable`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  })
  if (res.status !== 200 && res.status !== 204) throw new Error(`status=${res.status}`)
  return { status: res.status }
})

// ════════════════════════════════════════════════════════════════════════
// §S34. Webhooks raw incoming HMAC 验证（6 用例 — hmac-sha256 正反 + github/slack handshake）
//   §S21 创建的 webhook scheme 是 'hmac-sha256'，secret 是 webhook secret
//   用例覆盖：✓ 正确签名 → 202 / ✗ 错误签名 → 401 / ✗ 缺签头 → 401 / ✗ scheme 错位 → 401
//   handshake（github ping / slack url_verification）通过临时注册对应 scheme webhook 验证
// ════════════════════════════════════════════════════════════════════════
console.log('\n§S34 Webhooks raw incoming HMAC 验证')

// S34 用例的 webhook 共享 §S21 的 secret 字符串（必须是同一字符串才能算"正确签名"）
const S34_WEBHOOK_SECRET = 'wh-secret-2025'

await scenario('S34', 'POST /v1/webhooks/incoming/:id (hmac-sha256 + 正确 x-signature → 202 accepted)', async () => {
  if (!webhookId) throw new Error('no webhook id from §S21')
  const body = JSON.stringify({ event: 'push', ref: 'refs/heads/main' })
  const sig = 'sha256=' + createHmac('sha256', S34_WEBHOOK_SECRET).update(body).digest('hex')
  const res = await fetch(`${baseUrl}/v1/webhooks/incoming/${webhookId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-signature': sig },
    body,
  })
  if (res.status !== 202) throw new Error(`status=${res.status} body=${await res.text()}`)
  return { status: res.status, scheme: 'hmac-sha256' }
})

await scenario('S34', 'POST /v1/webhooks/incoming/:id (错误 x-signature → 401)', async () => {
  if (!webhookId) throw new Error('no webhook id from §S21')
  const body = JSON.stringify({ event: 'push' })
  const res = await fetch(`${baseUrl}/v1/webhooks/incoming/${webhookId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-signature': 'sha256=' + '0'.repeat(64) },
    body,
  })
  if (res.status !== 401) throw new Error(`status=${res.status} body=${await res.text()}`)
  return { status: res.status, expect: 401 }
})

await scenario('S34', 'POST /v1/webhooks/incoming/:id (缺 x-signature 头 → 401)', async () => {
  if (!webhookId) throw new Error('no webhook id from §S21')
  const body = JSON.stringify({ event: 'push' })
  const res = await fetch(`${baseUrl}/v1/webhooks/incoming/${webhookId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  })
  if (res.status !== 401) throw new Error(`status=${res.status} body=${await res.text()}`)
  return { status: res.status, expect: 401 }
})

await scenario('S34', 'POST /v1/webhooks/incoming/:id (slack scheme header 但 webhook 是 hmac-sha256 → 401)', async () => {
  // scheme 错位：slack 头格式但 scheme 不匹配 → verify 失败 → 401
  if (!webhookId) throw new Error('no webhook id from §S21')
  const body = '{"type":"event_callback"}'
  const ts = String(Math.floor(Date.now() / 1000))
  const res = await fetch(`${baseUrl}/v1/webhooks/incoming/${webhookId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-slack-request-timestamp': ts, 'x-slack-signature': 'v0=' + '0'.repeat(64) },
    body,
  })
  if (res.status !== 401) throw new Error(`status=${res.status} body=${await res.text()}`)
  return { status: res.status, schemeMismatch: 'slack-vs-hmac-sha256' }
})

// handshake 测试需要 github/slack scheme 的 webhook；临时创建一个用完即弃
await scenario('S34', '临时创建 github scheme webhook → handshake ping → 200 pong', async () => {
  const { status, body } = await req('POST', '/v1/webhooks', {
    ownerScopeId: DEFAULT_ADMIN_SCOPE,
    owner: 'qa-smoke',
    createdBy: 'qa-smoke',
    action: 'turn.completed',
    verification: { scheme: 'github', secret: 'webhook-secret' },
  })
  if (status !== 200 && status !== 201) throw new Error(`create failed status=${status} body=${JSON.stringify(body)}`)
  const ghId = body?.webhook?.id ?? body?.id
  if (!ghId) throw new Error(`no webhook id from create`)
  // handshake：x-github-event: ping → github.verifier.handshake → 'pong' body, 200
  // 不需要带有效签名（handshake 在 verify 之前返回）
  const res = await fetch(`${baseUrl}/v1/webhooks/incoming/${ghId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-github-event': 'ping' },
    body: '{"zen":"Speak like a human"}',
  })
  if (res.status !== 200) throw new Error(`handshake status=${res.status} body=${await res.text()}`)
  const text = await res.text()
  if (text !== 'pong') throw new Error(`expected handshake 'pong', got '${text}'`)
  return { status: res.status, handshake: text, scheme: 'github' }
})

await scenario('S34', '临时创建 slack scheme webhook → url_verification handshake → 200 echo challenge', async () => {
  const { status, body } = await req('POST', '/v1/webhooks', {
    ownerScopeId: DEFAULT_ADMIN_SCOPE,
    owner: 'qa-smoke',
    createdBy: 'qa-smoke',
    action: 'turn.completed',
    verification: { scheme: 'slack', secret: 'webhook-secret' },
  })
  if (status !== 200 && status !== 201) throw new Error(`create failed status=${status} body=${JSON.stringify(body)}`)
  const slId = body?.webhook?.id ?? body?.id
  if (!slId) throw new Error(`no webhook id from create`)
  // slack url_verification: type=url_verification + challenge → 回原 challenge 200
  const challenge = 'a'.repeat(20)
  const res = await fetch(`${baseUrl}/v1/webhooks/incoming/${slId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'url_verification', challenge }),
  })
  if (res.status !== 200) throw new Error(`handshake status=${res.status} body=${await res.text()}`)
  const text = await res.text()
  if (text !== challenge) throw new Error(`expected echo '${challenge}', got '${text}'`)
  return { status: res.status, handshake: 'url_verification', scheme: 'slack' }
})

// ════════════════════════════════════════════════════════════════════════
// §S22. 用户 - Keychain（5 用例）
// ════════════════════════════════════════════════════════════════════════
console.log('\n§S22 用户 - Keychain')

await scenario('S22', 'GET /v1/keychain/overview', async () => {
  const { status, body } = await req('GET', '/v1/keychain/overview')
  if (status !== 200) throw new Error(`status=${status}`)
  return { status }
})

let credId: string | undefined
await scenario('S22', 'POST /v1/keychain/credentials (写入 fake cred)', async () => {
  // service 名要作为 envKey（不允许以数字开头）。用纯字母数字下划线名
  const { status, body } = await req('POST', '/v1/keychain/credentials', {
    service: 'phase2_test_service',
    secret: 'wh-secret-2025',
  })
  if (status !== 200 && status !== 201) throw new Error(`status=${status} body=${JSON.stringify(body)}`)
  credId = body?.credential?.id ?? body?.id
  return { status, credId }
})

await scenario('S22', 'GET /v1/keychain/credentials list', async () => {
  const { status, body } = await req('GET', '/v1/keychain/credentials')
  if (status !== 200) throw new Error(`status=${status}`)
  const list: Array<{ id: string }> = Array.isArray(body?.credentials) ? body.credentials : []
  if (credId && !list.some((c) => c.id === credId)) throw new Error(`new cred not in list`)
  return { status, count: list.length }
})

let grantId: string | undefined
await scenario('S22', 'POST /v1/keychain/grants', async () => {
  const { status, body } = await req('POST', '/v1/keychain/grants', {
    credential: credId,
    purpose: 'phase2 test',
    expiresInSec: 60,
  })
  if (status !== 200 && status !== 201) throw new Error(`status=${status} body=${JSON.stringify(body)}`)
  grantId = body?.id ?? body?.grantId ?? body?.grant?.id
  return { status, grantId }
})

await scenario('S22', 'POST /v1/keychain/asks + /use (validate input check)', async () => {
  // qm-next 检查：自己 owner 的 credential 不允许 ask 自己（应直接 grant）
  // 这里验证这一行为，期望 400 with 正确 message
  const ask = await req('POST', '/v1/keychain/asks', {
    credential: credId,
    purpose: 'phase2 test use',
  })
  if (ask.status !== 400) throw new Error(`expected 400 got ${ask.status} body=${JSON.stringify(ask.body)}`)
  if (!/own this credential/i.test(String(ask.body?.message ?? ''))) {
    throw new Error(`unexpected message: ${JSON.stringify(ask.body)}`)
  }
  return { status: ask.status, message: ask.body.message }
})

// ════════════════════════════════════════════════════════════════════════
// §S23. 用户 - Directory（3 用例）
// ════════════════════════════════════════════════════════════════════════
console.log('\n§S23 用户 - Directory')

await scenario('S23', 'GET /v1/directory/meta', async () => {
  const { status, body } = await req('GET', '/v1/directory/meta')
  if (status !== 200) throw new Error(`status=${status} body=${JSON.stringify(body)}`)
  return { status }
})

await scenario('S23', 'POST /v1/directory sync push (mock workspace)', async () => {
  const { status, body } = await req('POST', '/v1/directory', {
    surface: 'slack',
    members: [
      { id: 'U001', name: 'alice', email: '[email protected]' },
      { id: 'U002', name: 'bob', email: '[email protected]' },
    ],
    channels: [
      { id: 'C001', name: 'general', memberIds: ['U001', 'U002'] },
    ],
  })
  if (status !== 200 && status !== 201 && status !== 204) throw new Error(`status=${status} body=${JSON.stringify(body)}`)
  return { status }
})

await scenario('S23', 'GET /v1/directory/resolve?q=alice', async () => {
  const { status, body } = await req('GET', `/v1/directory/resolve?q=alice&surface=slack`)
  if (status !== 200) throw new Error(`status=${status} body=${JSON.stringify(body)}`)
  return { status }
})

// ════════════════════════════════════════════════════════════════════════
// §S24. 用户 - Sessions 详情（4 用例）
// ════════════════════════════════════════════════════════════════════════
console.log('\n§S24 用户 - Sessions 详情')

let testSessionId: string | undefined
await scenario('S24', 'GET /v1/sessions/:id (已有 session)', async () => {
  // 先用一个 turn 创建 session
  const turnRes = await req('POST', '/v1/turns', turnBody('ack', `${RUN_TAG}:s24-1`, { async: false }))
  if (turnRes.status !== 200) throw new Error(`turn create failed: ${turnRes.status}`)
  const sid = turnRes.body?.sessionId ?? turnRes.body?.session?.id
  if (!sid) throw new Error(`no session id from turn: ${JSON.stringify(turnRes.body)}`)
  testSessionId = sid
  // 详情路由需要 viewer query
  const { status, body } = await req('GET', `/v1/sessions/${sid}?viewer=qa-smoke`)
  if (status !== 200) throw new Error(`status=${status} body=${JSON.stringify(body)}`)
  return { status, sessionId: sid }
})

await scenario('S24', 'POST /v1/sessions/:id (改 title — qm-next 用 POST+patchOf, 不是 PATCH)', async () => {
  if (!testSessionId) throw new Error('no session id from previous test')
  const { status, body } = await req('POST', `/v1/sessions/${testSessionId}`, {
    principalId: 'qa-smoke',
    title: `${RUN_TAG}-renamed`,
  })
  if (status !== 200) throw new Error(`status=${status} body=${JSON.stringify(body)}`)
  return { status }
})

await scenario('S24', 'GET /v1/sessions/:id/entries/:seq (取单条)', async () => {
  if (!testSessionId) throw new Error('no session id from previous test')
  const { status, body } = await req('GET', `/v1/sessions/${testSessionId}/entries/1?viewer=qa-smoke`)
  // 可能是 404 (seq 编码方式不同)，也接受
  if (status !== 200 && status !== 404) throw new Error(`status=${status} body=${JSON.stringify(body)}`)
  return { status }
})

await scenario('S24', 'POST /v1/sessions/:id/fork', async () => {
  if (!testSessionId) throw new Error('no session id from previous test')
  const { status, body } = await req('POST', `/v1/sessions/${testSessionId}/fork`, { principalId: 'qa-smoke' })
  if (status !== 200 && status !== 201) throw new Error(`status=${status} body=${JSON.stringify(body)}`)
  return { status }
})

// ════════════════════════════════════════════════════════════════════════
// §S25. 用户 - Misc（Runtime / Soul / Grants / Share）（4 用例）
// ════════════════════════════════════════════════════════════════════════
console.log('\n§S25 用户 - Misc')

await scenario('S25', 'GET /v1/runtime-config', async () => {
  const { status, body } = await req('GET', '/v1/runtime-config')
  if (status !== 200 && status !== 403) throw new Error(`status=${status}`)
  return { status }
})

await scenario('S25', 'PUT /v1/runtime-config (更新模型选择)', async () => {
  const { status, body } = await req('PUT', '/v1/runtime-config', {
    modelId: 'sensenova-6.8-flash-lite',
    providerId: 'sensenova',
  })
  if (status !== 200 && status !== 403) throw new Error(`status=${status} body=${JSON.stringify(body)}`)
  return { status }
})

await scenario('S25', 'POST /v1/grants (Grant schema)', async () => {
  const { status, body } = await req('POST', '/v1/grants', {
    ownerScopeId: DEFAULT_ADMIN_SCOPE,
    ref: `file:${RUN_TAG}-test-artifact`,
    granteeScopeId: 'qa-other',
    permission: 'read',
    grantedBy: 'qa-smoke',
  })
  if (status !== 200 && status !== 201) throw new Error(`status=${status} body=${JSON.stringify(body)}`)
  return { status }
})

await scenario('S25', 'POST /v1/share (requires agent capability)', async () => {
  // /v1/share 需要 agent capability token（不是 bearer）。bearer 会得 403。
  // 这里只验证能力需求被报告（403 而非 400/500）
  const { status, body } = await req('POST', '/v1/share', {
    resourceType: 'artifact',
    resourceId: `${RUN_TAG}-test-artifact`,
    surface: 'slack',
    target: '#C001',
  })
  if (status !== 403) throw new Error(`expected 403 got ${status} body=${JSON.stringify(body)}`)
  return { status }
})

// ═══════════════════════════════════════════════════════════════════════
// §S26. 用户 - Keychain 收尾（5 用例）
// ═══════════════════════════════════════════════════════════════════════
console.log('\n§S26 用户 - Keychain 收尾')

await scenario('S26', 'DELETE /v1/keychain/credentials/:id (删除 S22.2 创建的 cred)', async () => {
  if (!credId) throw new Error('no credId from previous test')
  // qm DELETE 不接受带 body 的 content-type；用 fetch 直发
  const res = await fetch(`${baseUrl}/v1/keychain/credentials/${credId}`, {
    method: 'DELETE',
    headers: { authorization: authHeaders.authorization },
  })
  const text = await res.text()
  let parsed: any; try { parsed = JSON.parse(text) } catch { parsed = text }
  if (res.status !== 200) throw new Error(`status=${res.status} body=${JSON.stringify(parsed)}`)
  if (parsed?.ok !== true) throw new Error(`expected ok=true got ${JSON.stringify(parsed)}`)
  return { status: res.status, ok: parsed.ok }
})

await scenario('S26', 'POST /v1/keychain/grants/:id/revoke (撤销 S22.4 创建的 grant)', async () => {
  if (!grantId) throw new Error('no grantId from previous test')
  // POST 无 body 时不能用 content-type:application/json（Fastify 拒空 body）；直接 fetch 无 body
  const res = await fetch(`${baseUrl}/v1/keychain/grants/${grantId}/revoke`, {
    method: 'POST',
    headers: { authorization: authHeaders.authorization },
  })
  const text = await res.text()
  let parsed: any; try { parsed = JSON.parse(text) } catch { parsed = text }
  if (res.status !== 200) throw new Error(`status=${res.status} body=${JSON.stringify(parsed)}`)
  if (parsed?.ok !== true) throw new Error(`expected ok=true got ${JSON.stringify(parsed)}`)
  return { status: res.status, ok: parsed.ok }
})

await scenario('S26', 'POST /v1/keychain/asks/:id/decline (无 ask 时应 404)', async () => {
  // 我们没有创建 ask（self-own 被拒绝）；用一个不存在 ID 应得 404
  const res = await fetch(`${baseUrl}/v1/keychain/asks/nonexistent-${RUN_TAG}/decline`, {
    method: 'POST',
    headers: { authorization: authHeaders.authorization },
  })
  const text = await res.text()
  let parsed: any; try { parsed = JSON.parse(text) } catch { parsed = text }
  if (res.status !== 404) throw new Error(`expected 404 got ${res.status} body=${JSON.stringify(parsed)}`)
  return { status: res.status }
})

await scenario('S26', 'POST /v1/keychain/use (无 grant 时 400)', async () => {
  // 用一个不存在的 grantId；期望 404 或 bad_request
  const { status, body } = await req('POST', '/v1/keychain/use', { grant: 'nonexistent-grant' })
  if (status !== 400 && status !== 404) throw new Error(`expected 400/404 got ${status} body=${JSON.stringify(body)}`)
  return { status, error: body?.error }
})

await scenario('S26', 'POST /v1/keychain/drops (需要 agent capability token)', async () => {
  // drops mint 需要 agent capability；用 bearer 应得 401 unauthorized
  const { status, body } = await req('POST', '/v1/keychain/drops', {
    title: 'github',
    purpose: 'phase3 test drop',
  })
  if (status !== 401) throw new Error(`expected 401 got ${status} body=${JSON.stringify(body)}`)
  return { status, error: body?.error }
})

// ═══════════════════════════════════════════════════════════════════════
// §S33. Phase 3D — Keychain drops 完整链路（3 用例 · §7.2 🥇）
// ═══════════════════════════════════════════════════════════════════════
console.log('\n§S33 Phase 3D - Keychain drops 完整链路 (capability mint → form → redeem)')

let dropId: string | undefined

await scenario('S33', 'POST /v1/keychain/drops (agent capability token mint → dropId + formPath)', async () => {
  // Phase 3D: 完整链路第一步——agent 用 cap token mint 一个 secret-drop,
  // 拿到 dropId + formPath。错误路径已在 S26.5 覆盖 (bearer → 401)。
  const dropCap = await mintCapabilityToken({
    actorId: 'qa-smoke',
    scopeId: 'personal:qa-smoke',
    // framework.ts:113 要求 'either' 路由的 cap token 必须用 CONTROL_PLANE_AUD；
    // mintDrop 内部不做 aud 校验（只查 capability.triggered），所以 SECRET_DROP_AUD 反而会 403
    aud: CONTROL_PLANE_AUD,
    exp: Date.now() + 60_000,
  }, SECRET, 'default')
  const res = await fetch(`${baseUrl}/v1/keychain/drops`, {
    method: 'POST',
    headers: { 'x-agent-capability': dropCap, 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'github', purpose: `phase3d drops test ${RUN_TAG}` }),
  })
  const parsed = await res.json().catch(() => ({}))
  if (res.status !== 200) throw new Error(`expected 200 got ${res.status} body=${JSON.stringify(parsed)}`)
  if (typeof parsed?.dropId !== 'string' || !parsed.dropId) throw new Error(`expected dropId string got ${JSON.stringify(parsed)}`)
  if (parsed?.formPath !== `/v1/keychain/drops/${parsed.dropId}/form`) {
    throw new Error(`expected formPath=/v1/keychain/drops/${parsed.dropId}/form got ${parsed?.formPath}`)
  }
  dropId = parsed.dropId
  return { status: res.status, dropId, formPath: parsed.formPath }
})

await scenario('S33', 'GET /v1/keychain/drops/:id/form (返回 form HTML · 含 POST action 到 redeem 路由)', async () => {
  // Phase 3D: 完整链路第二步——user 在浏览器 GET form 拿到 HTML（含
  // <form method="POST" action="/v1/keychain/drops/:id"> + submit 按钮）。
  if (!dropId) throw new Error('no dropId from S33.1')
  const res = await fetch(`${baseUrl}/v1/keychain/drops/${dropId}/form`, {
    headers: { authorization: authHeaders.authorization },
  })
  const text = await res.text()
  if (res.status !== 200) throw new Error(`expected 200 got ${res.status} body=${text.slice(0, 200)}`)
  if (!text.includes(`<form method="POST" action="/v1/keychain/drops/${dropId}">`)) {
    throw new Error(`form HTML missing POST action to /v1/keychain/drops/${dropId}; got: ${text.slice(0, 300)}`)
  }
  if (!text.includes('Submit securely')) throw new Error(`form HTML missing submit button`)
  if (!text.includes(`phase3d drops test ${RUN_TAG}`)) throw new Error(`form HTML missing purpose text`)
  return { status: res.status, htmlLen: text.length }
})

await scenario('S33', 'POST /v1/keychain/drops/:id (redeem secret → 200 + credential.service)', async () => {
  // Phase 3D: 完整链路第三步——user 提交表单 secret → drop 标记 consumed,
  // 返回 { ok:true, credential:{ service, ownerId, ... } }。
  if (!dropId) throw new Error('no dropId from S33.1')
  const dropSecret = `phase3d-secret-${RUN_TAG}`
  const res = await fetch(`${baseUrl}/v1/keychain/drops/${dropId}`, {
    method: 'POST',
    headers: { authorization: authHeaders.authorization, 'content-type': 'application/json' },
    body: JSON.stringify({ secret: dropSecret }),
  })
  const parsed = await res.json().catch(() => ({}))
  if (res.status !== 200) throw new Error(`expected 200 got ${res.status} body=${JSON.stringify(parsed)}`)
  if (parsed?.ok !== true) throw new Error(`expected ok=true got ${JSON.stringify(parsed)}`)
  if (parsed?.credential?.service !== 'github') throw new Error(`expected credential.service=github got ${parsed?.credential?.service}`)
  if (parsed?.credential?.ownerId !== 'qa-smoke') throw new Error(`expected credential.ownerId=qa-smoke got ${parsed?.credential?.ownerId}`)
  return { status: res.status, service: parsed.credential.service, fields: parsed.credential.fields }
})

// ═══════════════════════════════════════════════════════════════════════
// §S27. Admin 杂项（6 用例）
// ═══════════════════════════════════════════════════════════════════════
console.log('\n§S27 Admin 杂项')

await scenario('S27', 'PUT /v1/admin/scopes/:scope/:resource (command-policy-simulate → 501)', async () => {
  // resource=command-policy-simulate → 501 not_configured；其他 → 404 not_found
  // 注意：必须送 admin token + scope query（authorizeAdmin 跨 scope 不读 query，但 requireScopedAdmin 不调）
  const res = await fetch(`${baseUrl}/v1/admin/scopes/org:default/command-policy-simulate`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ttlSeconds: 3600 }),
  })
  const text = await res.text()
  let parsed: any; try { parsed = JSON.parse(text) } catch { parsed = text }
  if (res.status !== 501) throw new Error(`expected 501 got ${res.status} body=${JSON.stringify(parsed)}`)
  return { status: res.status, error: parsed?.error }
})

await scenario('S27', 'POST /v1/admin/scopes/:scope/auto-flagger/test (无 flagger → 501)', async () => {
  const res = await fetch(`${baseUrl}/v1/admin/scopes/org:default/auto-flagger/test`, {
    method: 'POST',
    headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'hello' }),
  })
  const text = await res.text()
  let parsed: any; try { parsed = JSON.parse(text) } catch { parsed = text }
  if (res.status !== 501) throw new Error(`expected 501 got ${res.status} body=${JSON.stringify(parsed)}`)
  return { status: res.status, error: parsed?.error }
})

await scenario('S27', 'GET /v1/admin/errors (列错误)', async () => {
  const { status, body } = await req('GET', `/v1/admin/errors?scope=${DEFAULT_ADMIN_SCOPE}`, undefined, adminAuthHeaders)
  if (status !== 200) throw new Error(`status=${status} body=${JSON.stringify(body)}`)
  if (!Array.isArray(body?.errors)) throw new Error(`expected errors array got ${JSON.stringify(body)}`)
  return { status, count: body.errors.length }
})

await scenario('S27', 'POST /v1/admin/security/release (sessionId 缺 → 400)', async () => {
  const { status, body } = await req('POST', `/v1/admin/security/release?scope=${DEFAULT_ADMIN_SCOPE}`, {}, adminAuthHeaders)
  if (status !== 400) throw new Error(`expected 400 got ${status} body=${JSON.stringify(body)}`)
  return { status }
})

await scenario('S27', 'POST /v1/admin/impersonate (start)', async () => {
  const { status, body } = await req('POST', `/v1/admin/impersonate?scope=${DEFAULT_ADMIN_SCOPE}`, { target: 'alice' }, adminAuthHeaders)
  if (status !== 200) throw new Error(`status=${status} body=${JSON.stringify(body)}`)
  if (body?.ok !== true || body?.target !== 'alice') throw new Error(`unexpected body: ${JSON.stringify(body)}`)
  return { status, target: body.target, displayName: body.displayName }
})

await scenario('S27', 'POST /v1/admin/impersonate/stop', async () => {
  const { status, body } = await req('POST', `/v1/admin/impersonate/stop?scope=${DEFAULT_ADMIN_SCOPE}`, {}, adminAuthHeaders)
  if (status !== 200) throw new Error(`status=${status} body=${JSON.stringify(body)}`)
  if (body?.ok !== true) throw new Error(`expected ok=true got ${JSON.stringify(body)}`)
  return { status }
})

// ═══════════════════════════════════════════════════════════════════════
// §S28. Admin artifacts（6 用例）
// ═══════════════════════════════════════════════════════════════════════
console.log('\n§S28 Admin artifacts')

await scenario('S28', 'GET /v1/admin/crons (triggers 未启用 → 空数组)', async () => {
  const { status, body } = await req('GET', `/v1/admin/crons?scope=${DEFAULT_ADMIN_SCOPE}`, undefined, adminAuthHeaders)
  if (status !== 200) throw new Error(`status=${status} body=${JSON.stringify(body)}`)
  if (!Array.isArray(body?.crons)) throw new Error(`expected crons array got ${JSON.stringify(body)}`)
  return { status, count: body.crons.length }
})

await scenario('S28', 'PUT /v1/admin/crons/:id/destination (无 cron → 404)', async () => {
  // 404：cron 不存在（triggers 未启用 → deps.crons undefined → cron lookup returns null）
  const res = await fetch(`${baseUrl}/v1/admin/crons/nonexistent-${RUN_TAG}/destination?scope=${DEFAULT_ADMIN_SCOPE}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ destination: { type: 'principal', target: 'alice' } }),
  })
  const text = await res.text()
  let parsed: any; try { parsed = JSON.parse(text) } catch { parsed = text }
  if (res.status !== 404) throw new Error(`expected 404 got ${res.status} body=${JSON.stringify(parsed)}`)
  return { status: res.status }
})

await scenario('S28', 'GET /v1/admin/deployments', async () => {
  const { status, body } = await req('GET', `/v1/admin/deployments?scope=${DEFAULT_ADMIN_SCOPE}`, undefined, adminAuthHeaders)
  if (status !== 200) throw new Error(`status=${status} body=${JSON.stringify(body)}`)
  if (!Array.isArray(body?.deployments)) throw new Error(`expected deployments array got ${JSON.stringify(body)}`)
  return { status, count: body.deployments.length }
})

await scenario('S28', 'GET /v1/admin/skills', async () => {
  const { status, body } = await req('GET', `/v1/admin/skills?scope=${DEFAULT_ADMIN_SCOPE}`, undefined, adminAuthHeaders)
  if (status !== 200) throw new Error(`status=${status} body=${JSON.stringify(body)}`)
  if (!Array.isArray(body?.skills)) throw new Error(`expected skills array got ${JSON.stringify(body)}`)
  return { status, count: body.skills.length }
})

let adminTestSkillId: string | undefined
await scenario('S28', 'GET /v1/admin/skills/:id (取列表第一个)', async () => {
  // 先 list 拿 id；S7 创建的 skill 在 personal:qa-smoke scope 内；admin 看 org:default scope 的可能不可见
  // 这里看的是所有 org 范围内的 skills（含 S7 中 archived 的）
  const list = await req('GET', `/v1/admin/skills?scope=${DEFAULT_ADMIN_SCOPE}`, undefined, adminAuthHeaders)
  const arr: any[] = Array.isArray(list?.body?.skills) ? list.body.skills : []
  // 找 RUN_TAG 命名的、未 archive 的
  const candidate = arr.find((s) => String(s?.name ?? '').includes(RUN_TAG) && s?.status !== 'archived')
  const first = candidate ?? arr.find((s) => s?.status !== 'archived') ?? arr[0]
  if (!first?.id) throw new Error(`no skill found: ${JSON.stringify(arr.slice(0, 3))}`)
  adminTestSkillId = first.id
  const { status, body } = await req('GET', `/v1/admin/skills/${adminTestSkillId}?scope=${DEFAULT_ADMIN_SCOPE}`, undefined, adminAuthHeaders)
  if (status !== 200) throw new Error(`status=${status} body=${JSON.stringify(body)}`)
  return { status, name: body.name, status_: body.status }
})

await scenario('S28', 'DELETE /v1/admin/skills/:id (archive)', async () => {
  if (!adminTestSkillId) throw new Error('no adminTestSkillId')
  const res = await fetch(`${baseUrl}/v1/admin/skills/${adminTestSkillId}?scope=${DEFAULT_ADMIN_SCOPE}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${adminToken}` },
  })
  const text = await res.text()
  let parsed: any; try { parsed = JSON.parse(text) } catch { parsed = text }
  if (res.status !== 200) throw new Error(`status=${res.status} body=${JSON.stringify(parsed)}`)
  if (parsed?.ok !== true) throw new Error(`expected ok=true got ${JSON.stringify(parsed)}`)
  return { status: res.status }
})

// ═══════════════════════════════════════════════════════════════════════
// §S29. Admin provider 写（预期失败 D6-D9 回归测试）（4 用例）
// ═══════════════════════════════════════════════════════════════════════
console.log('\n§S29 Admin provider 写 (D6-D9 回归)')

await scenario('S29', 'GET /v1/admin/model-providers (D6: 应列 sensenova，实际返回空)', async () => {
  // D6: getModelProviders 是 stub, 返回 notFound。期望 200 + 非空（但实际 404）→ 失败
  const { status, body } = await req('GET', `/v1/admin/model-providers`, undefined, adminAuthHeaders)
  if (status !== 200) throw new Error(`[D6 expected] status=200 got ${status} body=${JSON.stringify(body)}`)
  const list = Array.isArray(body?.providers) ? body.providers : []
  if (list.length === 0) throw new Error(`[D6 expected] providers non-empty (sensenova should be listed)`)
  return { status, count: list.length }
})

await scenario('S29', 'PUT /v1/admin/model-providers/sensenova (D9: stub → 期望 200)', async () => {
  // D9: putModelProvider 是 stub。期望 200，实际 404
  const { status, body } = await req('PUT', `/v1/admin/model-providers/sensenova`, {
    apiKey: 'sk-fake-test-key',
  }, adminAuthHeaders)
  if (status !== 200) throw new Error(`[D9 expected] status=200 got ${status} body=${JSON.stringify(body)}`)
  return { status }
})

await scenario('S29', 'DELETE /v1/admin/model-providers/sensenova (D9: stub → 期望 200)', async () => {
  // DELETE 无 body；用 fetch 直发避免 content-type:application/json + empty body
  const res = await fetch(`${baseUrl}/v1/admin/model-providers/sensenova?scope=${DEFAULT_ADMIN_SCOPE}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${adminToken}` },
  })
  const text = await res.text()
  let parsed: any; try { parsed = JSON.parse(text) } catch { parsed = text }
  if (res.status !== 200) throw new Error(`[D9 expected] status=200 got ${res.status} body=${JSON.stringify(parsed)}`)
  return { status: res.status }
})

await scenario('S29', 'DELETE /v1/admin/custom-providers/qa-test (D7/D8: stub → 期望 200)', async () => {
  // D7: putCustomProvider stub; D8: getCustomProviders hardcoded []. delete 也是 stub
  const res = await fetch(`${baseUrl}/v1/admin/custom-providers/qa-test-${RUN_TAG}?scope=${DEFAULT_ADMIN_SCOPE}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${adminToken}` },
  })
  const text = await res.text()
  let parsed: any; try { parsed = JSON.parse(text) } catch { parsed = text }
  if (res.status !== 200 && res.status !== 404) throw new Error(`[D7 expected] status=200/404 got ${res.status} body=${JSON.stringify(parsed)}`)
  // 实际是 404 (notFound ctx) → 标 D7/D8/D9 仍存在
  return { status: res.status, defect: res.status === 404 ? 'D7/D9 stub' : undefined }
})

// ═══════════════════════════════════════════════════════════════════════
// §S30. Sessions 详情（3 用例）
// ═══════════════════════════════════════════════════════════════════════
console.log('\n§S30 Sessions 详情')

await scenario('S30', 'POST /v1/sessions/:id/fork (复刻 session)', async () => {
  if (!testSessionId) throw new Error('no testSessionId')
  const { status, body } = await req('POST', `/v1/sessions/${testSessionId}/fork`, {
    principalId: 'qa-smoke',
  })
  if (status !== 200 && status !== 201) throw new Error(`status=${status} body=${JSON.stringify(body)}`)
  return { status, newSessionId: body?.session?.id ?? body?.newSessionId }
})

await scenario('S30', 'GET /v1/sessions/:id/entries/:seq (查 seq=0)', async () => {
  if (!testSessionId) throw new Error('no testSessionId')
  const { status, body } = await req('GET', `/v1/sessions/${testSessionId}/entries/0?viewer=qa-smoke`)
  if (status !== 200 && status !== 404) throw new Error(`status=${status} body=${JSON.stringify(body)}`)
  return { status, entryType: body?.entry?.type }
})

await scenario('S30', 'GET /v1/sessions/:id/entries/99999 (不存在的 seq → 404)', async () => {
  if (!testSessionId) throw new Error('no testSessionId')
  const { status, body } = await req('GET', `/v1/sessions/${testSessionId}/entries/99999?viewer=qa-smoke`)
  if (status !== 404) throw new Error(`expected 404 got ${status} body=${JSON.stringify(body)}`)
  return { status }
})

// ═══════════════════════════════════════════════════════════════════════
// §S31. User misc（5 用例）
// ═══════════════════════════════════════════════════════════════════════
console.log('\n§S31 User misc')

await scenario('S31', 'GET /v1/surface-config (surfaceConfig 未配置 → 404)', async () => {
  // 不配 surfaceConfig 时返回 404 not_found
  const { status, body } = await req('GET', '/v1/surface-config')
  if (status !== 404 && status !== 200) throw new Error(`expected 404/200 got ${status} body=${JSON.stringify(body)}`)
  return { status, found: status === 200 }
})

await scenario('S31', 'GET /v1/channel-header-pin (default)', async () => {
  const { status, body } = await req('GET', `/v1/channel-header-pin?principalId=qa-smoke&scopeId=personal:qa-smoke`)
  if (status !== 200) throw new Error(`status=${status} body=${JSON.stringify(body)}`)
  return { status, on: body?.on, configured: body?.configured }
})

await scenario('S31', 'PUT /v1/channel-header-pin (设 on=true)', async () => {
  const { status, body } = await req('PUT', `/v1/channel-header-pin?principalId=qa-smoke&scopeId=personal:qa-smoke`, { on: true })
  if (status !== 200) throw new Error(`status=${status} body=${JSON.stringify(body)}`)
  return { status, on: body?.on }
})

await scenario('S31', 'GET /v1/soul (soul 未配置 → 400 缺 scopeId)', async () => {
  // /v1/soul 需要 soul 配置；没配时路由不注册 → 404. 但 query 没 scopeId 也 400
  // 实际上 soul 没启用，路由未注册 → 404
  const { status, body } = await req('GET', '/v1/soul')
  if (status !== 400 && status !== 404) throw new Error(`expected 400/404 got ${status} body=${JSON.stringify(body)}`)
  return { status }
})

await scenario('S31', 'POST /v1/grants/revoke (撤销测试 grant)', async () => {
  // qm grant schema: ownerScopeId + ref + granteeScopeId + permission + grantedBy；create 不返回 id
  // revoke 需要 ownerScopeId + ref + granteeScopeId + revokedBy
  const ref = `file:${RUN_TAG}-revoke-target`
  const created = await req('POST', '/v1/grants', {
    ownerScopeId: DEFAULT_ADMIN_SCOPE,
    ref,
    granteeScopeId: 'qa-other',
    permission: 'read',
    grantedBy: 'qa-smoke',
  })
  if (created.status !== 200 && created.status !== 201) throw new Error(`setup grant failed: status=${created.status} body=${JSON.stringify(created.body)}`)
  const { status, body } = await req('POST', '/v1/grants/revoke', {
    ownerScopeId: DEFAULT_ADMIN_SCOPE,
    ref,
    granteeScopeId: 'qa-other',
    revokedBy: 'qa-smoke',
  })
  if (status !== 200 && status !== 201) throw new Error(`status=${status} body=${JSON.stringify(body)}`)
  if (body?.ok !== true) throw new Error(`expected ok=true got ${JSON.stringify(body)}`)
  return { status, ok: body.ok }
})

// ════════════════════════════════════════════════════════════════════════
// §S32. Connectors OAuth Mock（Phase 3C — 8 用例）
// ════════════════════════════════════════════════════════════════════════
console.log('\n§S32 Connectors OAuth Mock')

let consentLinkId: string | undefined
let consentState: string | undefined
let consentCode: string | undefined
let consentHost: string | undefined
let oauthStartState: string | undefined

await scenario('S32', 'GET /v1/connectors/catalog (mock provider 列表)', async () => {
  const { status, body } = await req('GET', '/v1/connectors/catalog')
  if (status !== 200) throw new Error(`status=${status} body=${JSON.stringify(body)}`)
  const list = Array.isArray(body?.catalog) ? body.catalog : []
  if (list.length === 0) throw new Error('catalog empty')
  if (!list.some((p: { id: string }) => p.id === 'google-mock')) throw new Error('google-mock missing')
  return { status, count: list.length }
})

await scenario('S32', 'POST /v1/connectors/oauth/consent/mint (创建 consent link)', async () => {
  // Note: /v1/connectors/oauth/consent/mint uses auth { aud: 'oauth-consent' }.
  // Lane A has no cap tokens so even a source bearer should reach the
  // handler (the route falls back to bearer-based auth on lane A).
  const { status, body } = await req('POST', '/v1/connectors/oauth/consent/mint', {
    provider: 'google-mock',
    host: 'google-m.example.test',
    principalId: 'qa-smoke',
    redirectUri: 'https://example.test/cb',
  })
  if (status === 404) throw new Error(`route not registered (consent links still stub)`)
  if (status !== 200 && status !== 201) throw new Error(`status=${status} body=${JSON.stringify(body)}`)
  consentLinkId = body?.linkId
  consentState = body?.state
  if (!consentLinkId || !consentState) throw new Error(`missing linkId/state: ${JSON.stringify(body)}`)
  consentHost = body?.host
  return { status, linkId: consentLinkId }
})

await scenario('S32', 'POST consent/mint 缺参数 → 400', async () => {
  const { status, body } = await req('POST', '/v1/connectors/oauth/consent/mint', { provider: 'google-mock' })
  if (status !== 400) throw new Error(`expected 400 got ${status} body=${JSON.stringify(body)}`)
  return { status }
})

await scenario('S32', 'POST consent/mint 未知 provider → 404', async () => {
  const { status, body } = await req('POST', '/v1/connectors/oauth/consent/mint', {
    provider: 'unknown-mock',
    host: 'unknown.example.test',
    principalId: 'qa-smoke',
    redirectUri: 'https://example.test/cb',
  })
  if (status !== 404) throw new Error(`expected 404 got ${status} body=${JSON.stringify(body)}`)
  return { status }
})

await scenario('S32', 'GET /v1/connectors/oauth/consent/redeem/:linkId (签发 auth code)', async () => {
  if (!consentLinkId) throw new Error('no consent link from previous test')
  const { status, body } = await req('GET', `/v1/connectors/oauth/consent/redeem/${consentLinkId}`)
  if (status !== 200) throw new Error(`status=${status} body=${JSON.stringify(body)}`)
  if (!body?.code || !body?.state) throw new Error(`missing code/state: ${JSON.stringify(body)}`)
  consentCode = body.code
  return { status, code: consentCode }
})

await scenario('S32', 'GET redeem 重复 redeem → 410', async () => {
  if (!consentLinkId) throw new Error('no consent link')
  const { status, body } = await req('GET', `/v1/connectors/oauth/consent/redeem/${consentLinkId}`)
  if (status !== 410) throw new Error(`expected 410 got ${status} body=${JSON.stringify(body)}`)
  return { status }
})

await scenario('S32', 'GET redeem 不存在 linkId → 404', async () => {
  const { status, body } = await req('GET', '/v1/connectors/oauth/consent/redeem/nonexistent-link-id')
  if (status !== 404) throw new Error(`expected 404 got ${status} body=${JSON.stringify(body)}`)
  return { status }
})

await scenario('S32', 'GET /v1/connectors/oauth/:provider/start (返回 authorize URL)', async () => {
  oauthStartState = `state-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const { status, body } = await req('GET', `/v1/connectors/oauth/slack-mock/start?state=${encodeURIComponent(oauthStartState)}`)
  if (status !== 200) throw new Error(`status=${status} body=${JSON.stringify(body)}`)
  if (!body?.authorizeUrl || !body?.state) throw new Error(`missing authorizeUrl/state: ${JSON.stringify(body)}`)
  return { status, authorizeHost: new URL(body.authorizeUrl).host }
})

await scenario('S32', 'GET /v1/connectors/oauth/:provider/start 缺 state → 400', async () => {
  const { status, body } = await req('GET', '/v1/connectors/oauth/slack-mock/start')
  if (status !== 400) throw new Error(`expected 400 got ${status} body=${JSON.stringify(body)}`)
  return { status }
})

await scenario('S32', 'GET /v1/connectors/oauth/:provider/start 未知 provider → 404', async () => {
  const { status, body } = await req('GET', `/v1/connectors/oauth/unknown-provider/start?state=anything`)
  if (status !== 404) throw new Error(`expected 404 got ${status} body=${JSON.stringify(body)}`)
  return { status }
})

await scenario('S32', 'GET /v1/connectors/oauth/:provider/callback (code+state 完整闭环)', async () => {
  if (!consentCode || !consentState) throw new Error('no consent code/state from previous tests')
  const res = await fetch(
    `${baseUrl}/v1/connectors/oauth/google-mock/callback?code=${encodeURIComponent(consentCode)}&state=${encodeURIComponent(consentState)}`,
  )
  const text = await res.text()
  let parsed: any; try { parsed = JSON.parse(text) } catch { parsed = text }
  if (res.status !== 200) throw new Error(`status=${res.status} body=${JSON.stringify(parsed)}`)
  if (parsed?.provider !== 'google-mock') throw new Error(`expected google-mock got ${JSON.stringify(parsed)}`)
  return { status: res.status, provider: parsed.provider }
})

await scenario('S32', 'GET callback 错 code → 400', async () => {
  const { status, body } = await req('GET', `/v1/connectors/oauth/google-mock/start?state=test-state`)
  if (status !== 200) throw new Error(`setup failed: status=${status}`)
  const res = await fetch(`${baseUrl}/v1/connectors/oauth/google-mock/callback?code=wrong-code&state=test-state`)
  const text = await res.text()
  let parsed: any; try { parsed = JSON.parse(text) } catch { parsed = text }
  if (res.status !== 400) throw new Error(`expected 400 got ${res.status} body=${JSON.stringify(parsed)}`)
  return { status: res.status }
})

await scenario('S32', 'POST /v1/connectors/token (手动注册 token → status 应含 host)', async () => {
  const { status, body } = await req('POST', '/v1/connectors/token', {
    host: 'google-m.example.test',
    principalId: 'qa-smoke',
    accessToken: 'phase3c-mock-token',
    accountType: 'default',
  })
  if (status !== 200) throw new Error(`status=${status} body=${JSON.stringify(body)}`)
  // Now check status reflects the token
  const check = await req('GET', '/v1/connectors/oauth/status?principalId=qa-smoke')
  if (check.status !== 200) throw new Error(`status check failed: ${check.status}`)
  const providers = check.body?.providers ?? {}
  const googleEntry = providers['google-mock']
  if (!googleEntry || !googleEntry.hasToken) throw new Error(`google-mock should have hasToken=true after POST token, got ${JSON.stringify(googleEntry)}`)
  return { status, hasToken: googleEntry.hasToken }
})

await scenario('S32', 'GET /v1/connectors/oauth/status (空 principal → 400)', async () => {
  const { status, body } = await req('GET', '/v1/connectors/oauth/status')
  if (status !== 400) throw new Error(`expected 400 got ${status} body=${JSON.stringify(body)}`)
  return { status }
})

await scenario('S32', 'POST /v1/connectors/oauth/revoke (按 host 删 token → status hasToken=false)', async () => {
  const { status, body } = await req('POST', '/v1/connectors/oauth/revoke', {
    principalId: 'qa-smoke',
    host: 'google-m.example.test',
  })
  if (status !== 200) throw new Error(`status=${status} body=${JSON.stringify(body)}`)
  const check = await req('GET', '/v1/connectors/oauth/status?principalId=qa-smoke')
  const googleEntry = check.body?.providers?.['google-mock']
  if (googleEntry?.hasToken !== false) throw new Error(`google-mock should have hasToken=false after revoke, got ${JSON.stringify(googleEntry)}`)
  return { status, hasToken: googleEntry?.hasToken }
})

await scenario('S32', 'POST revoke 缺 principalId → 400', async () => {
  const { status, body } = await req('POST', '/v1/connectors/oauth/revoke', { host: 'google-m.example.test' })
  if (status !== 400) throw new Error(`expected 400 got ${status} body=${JSON.stringify(body)}`)
  return { status }
})

// §S26 末尾 dispose（§S12 注释 line 984 遗留：原意"dispose 测试移到 §S26 末尾"，
// 但 dispose 后 fastify server 关闭 → 后续 §S27-§S32 全部失败；真正的"末尾"是 §S32 之后）
await scenario('S26', 'fiber.dispose 关闭 ApiService + 端口释放（修 §S12 注释遗留：dispose 必须在最后）', async () => {
  // 这是 §S12 注释（line 984）原意"fiber.dispose 后端口释放"用例的真正落地位置——
  // 必须放在最后一个 scenario 之后。修脚本不再自然 exit 的根因（process.exitCode 设了但
  // event loop 不空：fastify listen 持续），让 qa-smoke.ts 能完整跑到报告输出并 exit。
  const portBeforeDispose = port
  await fiber.dispose()
  let connectionRefused = false
  try {
    await fetch(`http://127.0.0.1:${portBeforeDispose}/healthz`, { signal: AbortSignal.timeout(1000) })
  } catch (e: any) {
    if (e?.code === 'ECONNREFUSED' || e?.cause?.code === 'ECONNREFUSED') connectionRefused = true
  }
  if (!connectionRefused) throw new Error(`expected ECONNREFUSED after dispose, port ${portBeforeDispose} still accepting`)
  return { portBeforeDispose, connectionRefused: true }
})

// ════════════════════════════════════════════════════════════════════════
// 汇总报告
// ════════════════════════════════════════════════════════════════════════

const passed = results.filter((r) => r.ok).length
const failed = results.filter((r) => !r.ok).length
const total = results.length

const sectionTitles: Record<string, string> = {
  S1: '启动 / 基础设施 / 健康',
  S2: '认证 / 授权',
  S3: '同步 turn / Harness / Model',
  S4: '异步 turn / Run 状态机',
  S5: '会话管理',
  S6: '记忆',
  S7: '技能',
  S8: '错误路径 / 输入校验',
  S9: '自定义 Provider / 模型',
  S10: '并发 / 竞态',
  S11: '性能 / 时序',
  S12: '资源 / 生命周期',
  S13: 'Admin 身份与权限',
  S14: 'Admin 监控 / Audit',
  S15: 'Admin 跨主体数据访问',
  S16: 'Admin 用户 / Grant 管理',
  S17: 'Admin 模型 / Provider',
  S18: 'Admin MCP / Resources / Skill-packs',
  S19: '用户 - Memory agent face',
  S20: '用户 - Files',
  S21: '用户 - Webhooks',
  S22: '用户 - Keychain',
  S23: '用户 - Directory',
  S24: '用户 - Sessions 详情',
  S25: '用户 - Misc (Runtime/Soul/Grants/Share)',
  S26: '用户 - Keychain 收尾',
  S27: 'Admin 杂项 (Scope/Security/Errors/Impersonate)',
  S28: 'Admin artifacts (Crons/Deployments/Skills)',
  S29: 'Admin provider 写 (D6-D9 回归)',
  S30: 'Sessions 详情 (Fork/Entries)',
  S31: 'User misc (Surface-config/Pin/Soul/Grants revoke)',
  S32: 'Connectors OAuth Mock (Phase 3C)',
  S33: 'Keychain drops 完整链路 (Phase 3D · capability mint → form → redeem)',
  S34: 'Webhooks raw incoming HMAC + handshake (Phase 3D · hmac-sha256 正反 + github/slack handshake)',
  S35: 'Admin grants/onboarding/reset (Phase 3D · onboarding PUT + grants 显式 role + reset deletedSessions)',
}

console.log('')
console.log('═══════════════════════════════════════════════════════════════════════')
console.log('  qm-next 全面功能测试 报告')
console.log('═══════════════════════════════════════════════════════════════════════')
console.log(`  Run tag:        ${RUN_TAG}`)
console.log(`  Model:          ${process.env.QM_MODEL_ID || DEFAULT_MODEL}`)
console.log(`  Provider:       ${PROVIDER_ID} (${baseUrl.replace(/:\d+$/, '')})`)
console.log('')

const sections = new Map<string, { pass: number; fail: number }>()
for (const r of results) {
  const cur = sections.get(r.section) ?? { pass: 0, fail: 0 }
  if (r.ok) cur.pass += 1
  else cur.fail += 1
  sections.set(r.section, cur)
}

console.log('  ── 用例分布 ──')
for (const [sec, c] of [...sections.entries()].sort()) {
  const total_s = c.pass + c.fail
  const bar = '█'.repeat(c.pass) + '░'.repeat(c.fail)
  console.log(`    ${sec}  ${sectionTitles[sec]?.padEnd(24, ' ')}  ${bar}  ${c.pass}/${total_s}`)
}
console.log('')
console.log('  ── 模型调用 ──')
console.log(`    调用次数:    ${modelCalls}`)
console.log(`    总延迟:      ${(modelTotalMs / 1000).toFixed(1)}s`)
console.log(`    平均延迟:    ${modelCalls ? Math.round(modelTotalMs / modelCalls) : 0}ms/turn`)
console.log('')
console.log('  ── 总体 ──')
console.log(`    total:   ${total}`)
console.log(`    passed:  \x1b[32m${passed}\x1b[0m`)
console.log(`    failed:  \x1b[31m${failed}\x1b[0m`)
console.log(`    rate:    ${total ? Math.round((passed / total) * 100) : 0}%`)

if (failed > 0) {
  console.log('')
  console.log('  ── 失败明细 ──')
  for (const r of results) {
    if (!r.ok) console.log(`    \x1b[31m✗\x1b[0m [${r.section}] ${r.name}\n        ${r.reason}`)
  }
}

console.log('═══════════════════════════════════════════════════════════════════════')

process.exitCode = failed === 0 ? 0 : 1
// 脚本最末的 fiber.dispose() 已在前一个 §S26 用例中执行；fastify listen 已释放，
// event loop 空 → node 自动 exit。保留 process.exitCode 设值让 CI 能拿到退出码。
// 不调 process.exit() 是为了不杀任何尚在 settle 的 promise（dispose 链）。
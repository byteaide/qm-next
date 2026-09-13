import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CodexRpcError,
  acquireCodexOAuthAuthLock,
  childCodexAuthFromDerived,
  childCodexOAuthAuth,
  codexAuthFileForEnv,
  codexChildEnv,
  codexChildToolAllowed,
  codexNonRetryable,
  codexOAuthAuthFromValue,
  codexOAuthJwtAccountId,
  codexProviderFailure,
  codexReplayCallId,
  codexReasoningEffort,
  codexTaskTitle,
  codexTokenUsageUpdate,
  codexTurnInputText,
  codexUsageTotals,
  createCodexHarness,
  fileCodexAuthStore,
  prepareCodexHome,
  readCodexOAuthAuthFile,
  redactCodexDiagnostics,
  sanitizedCodexOAuthAuth,
  writeCodexOAuthAuthFile,
} from '@qm/harness-codex'
import type { Session } from '@qm/types'

function makeSession(id = 's1'): Session {
  return { id, type: 'channel', scopeId: 'org:default', threadRef: 't1', surface: 'api', createdAt: Date.now() }
}

function base64url(value: object): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

function fakeIdToken(accountId: string): string {
  return ['eyJhbGciOiJIUzI1NiJ9', base64url({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId } }), 'sig'].join(
    '.',
  )
}

const validAuth = () => ({
  auth_mode: 'chatgpt',
  tokens: {
    access_token: 'at',
    refresh_token: 'rt',
    id_token: fakeIdToken('acc-123'),
    account_id: 'acc-123',
  },
})

test('codexNonRetryable classifies auth/quota failures, codexProviderFailure redacts', () => {
  assert.equal(codexNonRetryable('HTTP 401 Unauthorized'), true)
  assert.equal(codexNonRetryable('insufficient_quota: exceeded your current quota'), true)
  assert.equal(codexNonRetryable('connection reset by peer'), false)
  const error = codexProviderFailure('request failed with api_key sk-abcdef1234567890 and 401')
  assert.ok(!/sk-abcdef1234567890/.test(error.message))
  assert.equal(codexNonRetryable(error.message), true)
})

test('redactCodexDiagnostics strips bearer tokens, jwt-looking strings, and structured secrets', () => {
  const out = redactCodexDiagnostics(
    'Authorization: Bearer abc.def.ghi and access_token={"secret":"x"} token: yyy111222xxx',
  )
  assert.ok(!out.includes('Bearer abc'))
  assert.ok(out.includes('[redacted]'))
})

test('codexChildToolAllowed gates child threads to the shared tool set', () => {
  for (const name of ['execute', 'read', 'write', 'publish', 'memory', 'history', 'background'])
    assert.equal(codexChildToolAllowed(name), true)
  assert.equal(codexChildToolAllowed('spawn_agent'), false)
})

test('codexUsageTotals reads tokenUsage.total in both casing conventions', () => {
  assert.deepEqual(codexUsageTotals({ tokenUsage: { total: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 2 } } }), {
    input: 10,
    output: 5,
    cacheRead: 2,
    cacheWrite: 0,
    totalTokens: 15,
    costUsd: 0,
  })
  assert.deepEqual(codexUsageTotals({ tokenUsage: { total: { input_tokens: 7, output_tokens: 3 } } }), {
    input: 7,
    output: 3,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 10,
    costUsd: 0,
  })
  assert.equal(codexUsageTotals({}), null)
  assert.equal(codexUsageTotals(null), null)
})

test('codexTokenUsageUpdate reports only forward progress', () => {
  const first = codexTokenUsageUpdate({ tokenUsage: { total: { inputTokens: 100 }, last: { inputTokens: 40 } } })
  assert.deepEqual(first, { inputTokens: 40, totalInputTokens: 100 })
  assert.equal(codexTokenUsageUpdate({ tokenUsage: { total: { inputTokens: 100 } } }, 100), null)
  assert.equal(codexTokenUsageUpdate(null), null)
})

test('codexChildEnv jails CODEX_HOME and suppresses ambient OpenAI auth under oauth', () => {
  const source = { PATH: '/usr/bin', OPENAI_API_KEY: 'ambient', OPENAI_BASE_URL: 'https://x', CODEX_ACCESS_TOKEN: 't' }
  const plain = codexChildEnv(source, '/jail')
  assert.equal(plain.HOME, '/jail')
  assert.equal(plain.CODEX_HOME, '/jail/codex-home')
  assert.equal(plain.OPENAI_API_KEY, 'ambient')
  const oauth = codexChildEnv(source, '/jail', validAuth())
  assert.equal(oauth.OPENAI_API_KEY, undefined)
  assert.equal(oauth.OPENAI_BASE_URL, undefined)
  assert.equal(oauth.CODEX_ACCESS_TOKEN, undefined)
  assert.equal(oauth.PATH, '/usr/bin')
})

test('prepareCodexHome: oauth jail gets derived auth without the refresh token', () => {
  const jail = mkdtempSync(join(tmpdir(), 'qm-codex-test-'))
  try {
    const target = prepareCodexHome({}, jail, validAuth())
    const file = join(target, 'auth.json')
    assert.equal(statSync(file).mode & 0o777, 0o600)
    const auth = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(auth.auth_mode, 'chatgpt')
    assert.equal(auth.tokens.refresh_token, undefined)
    assert.equal(auth.tokens.access_token, 'at')
  } finally {
    rmSync(jail, { recursive: true, force: true })
  }
})

test('prepareCodexHome: falls back to apikey mode from the environment', () => {
  const jail = mkdtempSync(join(tmpdir(), 'qm-codex-test-'))
  try {
    const target = prepareCodexHome({ OPENAI_API_KEY: 'sk-test' }, jail, undefined)
    const auth = JSON.parse(readFileSync(join(target, 'auth.json'), 'utf8'))
    assert.equal(auth.auth_mode, 'apikey')
    assert.equal(auth.OPENAI_API_KEY, 'sk-test')
  } finally {
    rmSync(jail, { recursive: true, force: true })
  }
})

test('codex auth file round-trip enforces the oauth shape and 0600 mode', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qm-codex-test-'))
  try {
    const path = join(dir, 'auth.json')
    writeCodexOAuthAuthFile(path, validAuth())
    assert.ok(readCodexOAuthAuthFile(path), 'valid 0600 chatgpt auth is readable')
    chmodSync(path, 0o644)
    assert.equal(readCodexOAuthAuthFile(path), null, 'group/other-readable auth files are rejected')
    const bad = join(dir, 'bad.json')
    writeFileSync(bad, JSON.stringify({ auth_mode: 'chatgpt' }), { mode: 0o600 })
    assert.equal(readCodexOAuthAuthFile(bad), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('codexAuthFileForEnv resolves explicit, CODEX_HOME, and default locations', () => {
  assert.equal(codexAuthFileForEnv({ CODEX_AUTH_FILE: '~/x.json' }), join(homedir(), 'x.json'))
  assert.equal(codexAuthFileForEnv({ CODEX_HOME: '/ch' }, true), '/ch/auth.json')
  assert.equal(codexAuthFileForEnv({ HOME: '/h' }, true), '/h/.codex/auth.json')
  assert.equal(codexAuthFileForEnv({}, false), undefined)
})

test('child codex auth derivations never carry the refresh token', () => {
  const auth = validAuth()
  const child = childCodexOAuthAuth(auth)
  assert.equal((child.tokens as Record<string, unknown> | undefined)?.refresh_token, undefined)
  assert.ok(codexOAuthJwtAccountId(child))
  const derived = childCodexAuthFromDerived({
    accessToken: 'at',
    idToken: fakeIdToken('acc-9'),
    accountId: 'acc-9',
  })
  assert.ok(derived)
  assert.equal((derived!.tokens as Record<string, unknown>).id_token, fakeIdToken('acc-9'))
  assert.equal(childCodexAuthFromDerived({ accessToken: '', idToken: 'not-a-jwt' }), null)
})

test('codexOAuthAuthFromValue validates the same shape as the file reader', () => {
  assert.ok(codexOAuthAuthFromValue(validAuth()))
  assert.equal(codexOAuthAuthFromValue({ auth_mode: 'apikey' }), null)
  assert.equal(codexOAuthAuthFromValue(null), null)
  const sanitized = sanitizedCodexOAuthAuth(validAuth())
  assert.deepEqual(Object.keys(sanitized.tokens as object).sort(), [
    'access_token',
    'account_id',
    'id_token',
    'refresh_token',
  ])
})

test('fileCodexAuthStore load returns null when the auth file is absent or invalid', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qm-codex-test-'))
  try {
    assert.equal(await fileCodexAuthStore(join(dir, 'missing.json')).load(), null)
    const bad = join(dir, 'auth.json')
    writeFileSync(bad, JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'k' }), { mode: 0o600 })
    assert.equal(await fileCodexAuthStore(bad).load(), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('acquireCodexOAuthAuthLock is exclusive and re-entrant safe to release', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qm-codex-test-'))
  try {
    const path = join(dir, 'auth.json')
    const lock = await acquireCodexOAuthAuthLock(path, undefined, 1000, 10)
    assert.equal(lock.isHeld(), true)
    assert.ok(statSync(`${path}.lock`))
    await lock.release()
    assert.equal(lock.isHeld(), false)
    const again = await acquireCodexOAuthAuthLock(path, undefined, 1000, 10)
    await again.release()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('codex pure helpers: replay call ids, task titles, reasoning effort, turn input text', () => {
  assert.equal(codexReplayCallId('short-id'), 'short-id')
  assert.equal(codexReplayCallId('x'.repeat(65)), codexReplayCallId('x'.repeat(65)))
  assert.match(codexReplayCallId('x'.repeat(65)), /^[0-9a-f]{64}$/)
  assert.equal(codexTaskTitle('You are the research subagent. Go look.'), 'research subagent')
  assert.equal(codexTaskTitle('plain prompt'), 'plain prompt')
  assert.equal(codexTaskTitle(''), 'subagent task')
  assert.equal(codexTaskTitle(`${'y'.repeat(130)}`), `${'y'.repeat(119)}…`)
  assert.equal(codexReasoningEffort('high'), 'high')
  assert.equal(codexReasoningEffort('ultracode'), undefined)
  assert.equal(codexReasoningEffort(undefined), undefined)
  const input = codexTurnInputText({
    history: [],
    priorTurns: [],
    input: 'now',
    environment: 'env',
  })
  assert.equal(input, 'now\n\nenv')
})

test('CodexRpcError carries its name', () => {
  const error = new CodexRpcError('boom')
  assert.equal(error.name, 'CodexRpcError')
  assert.equal(error.message, 'boom')
})

test('createCodexHarness: adapter profile and pre-aborted cancel short-circuit', async () => {
  const harness = createCodexHarness({ env: { PATH: '/usr/bin' } })
  assert.deepEqual(
    { ...harness.profile, capabilities: [...harness.profile.capabilities].sort() },
    {
      id: 'codex',
      controlTransport: 'json-rpc',
      toolTransport: 'dynamic',
      transcriptFormat: 'responses-api',
      capabilities: ['abort', 'images', 'provider-sessions', 'steer'],
    },
  )
  assert.equal(typeof harness.models.oneShot, 'function')
  assert.equal(typeof harness.models.screenSecurity, 'function')
  harness.turns.resetSession?.('s1')
  const controller = new AbortController()
  controller.abort()
  let emitted = 0
  const result = await harness.turns.runTurn({
    session: makeSession(),
    input: 'hello',
    systemPrompt: 'sys',
    history: [],
    scopeLabel: 'org:default',
    orgScopeId: 'org:default',
    cancel: controller.signal,
    emit: async () => {
      emitted++
      throw new Error('should not emit')
    },
    recordModelCall: () => {},
  })
  assert.deepEqual(result, { reply: '', stopped: true })
  assert.equal(emitted, 0)
  await harness.turns.close?.()
})

test('mkdirSync is available for jail preparation semantics', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qm-codex-test-'))
  try {
    mkdirSync(join(dir, 'codex-home'), { recursive: true })
    assert.ok(statSync(join(dir, 'codex-home')).isDirectory())
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

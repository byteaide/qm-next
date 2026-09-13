/**
 * Real-machine e2e boot (task 17.1): the full M3 stack from
 * `profiles/im-e2e.yml` — api + bridge (ambient wiring) + cron/triggers +
 * Feishu WS provider — with a marker harness: turns containing `!approval`
 * pause on a pending approval (delivered as a card), everything else
 * echoes. Drives the three remaining manual legs:
 *
 *   1. card click     @bot `!approval` → card → Approve/Reject → follow-up echo
 *   2. ambient        non-mention chatter in an E2E_AMBIENT_CONTAINER chat → judge → reply
 *   3. cron delivery  the e2e cron fires (one-shot by default) → reply lands in E2E_CRON_CHAT
 *
 * Run from `repos/qm-next/` via `aidevops secret run` so FEISHU_* ride the
 * process environment. `E2E_CRON_CHAT` selects the cron destination chat —
 * without it the boot lists the bot's chats and skips cron registration.
 * Boot lines also append to `.im-e2e.log` (repo root): pnpm pipes buffer
 * stdout, so the file is the reliable evidence trail (10.x lesson).
 * Stop with Ctrl-C (or SIGTERM); shutdown unmounts the profile tree.
 */
import { bootProfile } from '../packages/boot/src/index.ts'
import { createMockHarness } from '../packages/orchestrator/src/index.ts'
import { appendFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const LOG_FILE = fileURLToPath(new URL('../.im-e2e.log', import.meta.url))

function log(message: string): void {
  const line = `${new Date().toISOString()} ${message}`
  console.log(line)
  try {
    appendFileSync(LOG_FILE, `${line}\n`)
  } catch {
    // file logging is evidence-only; never block the boot on it
  }
}

const ctx = await bootProfile(fileURLToPath(new URL('../profiles/im-e2e.yml', import.meta.url)))

const api = ctx.api
const base = createMockHarness()
const echoTurn = base.turns.runTurn
// Unique command per card: requestId is `${sessionId}:${command}`, so a
// per-turn command keeps every card independently decidable no matter
// which session the marker message lands in.
let approvalSeq = 0
base.turns.runTurn = async (input) => {
  if (input.input.includes('!approval')) {
    approvalSeq += 1
    return {
      reply: '',
      pausedOnApproval: true,
      pendingApprovals: [{ command: `e2e-approval-${approvalSeq}`, reason: '17.1 real-device card click' }],
    }
  }
  return echoTurn(input)
}
api.orchestrator.deps.harness.register(base)

const { port } = api.address
log(`im-e2e: booted, api 127.0.0.1:${port}, healthz ${(await fetch(`http://127.0.0.1:${port}/healthz`)).status}`)

const ambientContainers = (process.env.E2E_AMBIENT_CONTAINER ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
if (ambientContainers.length > 0) {
  log(`im-e2e: ambient ON for ${ambientContainers.join(', ')} (keyword '${process.env.E2E_AMBIENT_KEYWORD ?? '*'}')`)
  log('im-e2e: leg 2 — send a NON-mention message in that chat; expect the bot to reply')
} else {
  log('im-e2e: ambient OFF for now (set E2E_AMBIENT_CONTAINER to pin it; auto-arm enables it for the first observed chat)')
}

const feishu = ctx.im.get('feishu')
if (feishu?.collectDirectory) {
  try {
    const roster = await feishu.collectDirectory()
    const chats = roster.spaces.filter((s) => s.kind !== 'dm')
    if (chats.length > 0) log(`im-e2e: bot chats — ${chats.map((s) => `${s.spaceId}${s.name ? ` (${s.name})` : ''}`).join(', ')}`)
  } catch (err) {
    log(`im-e2e: chat listing unavailable: ${err instanceof Error ? err.message : String(err)}`)
  }
}

const cronChat = process.env.E2E_CRON_CHAT
if (cronChat) {
  const everyMs = Number(process.env.E2E_CRON_EVERY_MS ?? 0)
  const delayMs = Number(process.env.E2E_CRON_DELAY_MS ?? 15_000)
  const cron = await ctx.triggers.crons.create({
    scopeId: 'org:default',
    ownerId: 'e2e:owner',
    createdBy: 'boot-im-e2e',
    schedule: everyMs > 0 ? { everyMs } : { firstFireAt: Date.now() + delayMs },
    action: process.env.E2E_CRON_ACTION ?? '!run e2e cron fire',
    destination: { type: 'feishu', target: cronChat },
    title: everyMs > 0 ? `e2e cron every ${everyMs}ms` : 'e2e one-shot fire',
  })
  log(
    everyMs > 0
      ? `im-e2e: leg 3 — cron ${cron.id} fires every ${everyMs}ms into ${cronChat}; expect the echo reply there`
      : `im-e2e: leg 3 — cron ${cron.id} fires once ~${Math.round(delayMs / 1000)}s from now into ${cronChat}; expect the echo reply there`,
  )
} else {
  log('im-e2e: cron OFF for now (set E2E_CRON_CHAT to pin it; auto-arm schedules it for the first observed chat)')
}

log('im-e2e: leg 1 — @机器人 with !approval; expect the card, then click Approve/Reject and watch the follow-up echo')

// Auto-arm legs 2+3 for the first observed real chat: the chat id rides
// inbound runs (threadRef `provider:target[:thread]`), so any @bot
// message discovers it — no console or env setup needed. Explicit env
// always wins; E2E_AUTO_ARM=0 disables.
const armedChats = new Set<string>()
const autoArm = process.env.E2E_AUTO_ARM !== '0'
if (autoArm) {
  log('im-e2e: auto-arm on — send ANY @bot message and legs 2+3 arm for that chat')
}

async function armLegs(chatId: string): Promise<void> {
  if (armedChats.has(chatId) || !autoArm) return
  armedChats.add(chatId)
  const ambientBridge = ctx['im-bridge']
  if (!ambientContainers.includes(`feishu:${chatId}`) && ambientBridge.ambientPolicy) {
    await ambientBridge.ambientPolicy.setAmbient(`feishu:${chatId}`, true)
    log(`im-e2e: leg 2 ARMED — ambient on for feishu:${chatId} (keyword '${process.env.E2E_AMBIENT_KEYWORD ?? '*'}'); send a NON-mention message and the bot replies`)
  }
  if (!cronChat && ctx.triggers?.crons) {
    const delayMs = 20_000
    const cron = await ctx.triggers.crons.create({
      scopeId: 'org:default',
      ownerId: 'e2e:owner',
      createdBy: 'boot-im-e2e',
      schedule: { firstFireAt: Date.now() + delayMs },
      action: '!run e2e cron fire',
      destination: { type: 'feishu', target: chatId },
      title: 'e2e one-shot fire (auto-armed)',
    })
    log(`im-e2e: leg 3 ARMED — cron ${cron.id} fires once ~${delayMs / 1000}s from now into ${chatId}; expect 'e2e echo: !run e2e cron fire' there`)
  }
}

// Terminal-run evidence into the file log: shows which path each turn
// took (echo vs pending_approval card vs approval follow-up), and arms
// the legs once real chat traffic reveals the chat id.
api.runs.onTerminal((run) => {
  const result = run.result
  const approvals = result?.pendingApprovals?.length ?? 0
  const threadRef = run.request?.conversation?.threadRef
  log(
    `im-e2e: run ${run.id} terminal surface=${run.request?.surface} origin=${String(run.request?.origin?.kind)} status=${run.status} result=${result?.status ?? 'n/a'}` +
      (typeof result?.reply === 'string' ? ` reply=${JSON.stringify(result.reply.slice(0, 120))}` : '') +
      (approvals > 0 ? ` pendingApprovals=${approvals}` : '') +
      (threadRef ? ` threadRef=${threadRef}` : ''),
  )
  const segments = threadRef?.split(':') ?? []
  if (run.request?.surface === 'feishu' && segments[0] === 'feishu' && segments[1]) {
    void armLegs(segments[1]).catch((err) => log(`im-e2e: auto-arm failed: ${err instanceof Error ? err.message : String(err)}`))
  }
})

let stopping = false
async function shutdown(signal: string): Promise<void> {
  if (stopping) return
  stopping = true
  log(`im-e2e: ${signal} received, unmounting profile tree`)
  try {
    await ctx.loader.remove('include')
  } finally {
    process.exit(0)
  }
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

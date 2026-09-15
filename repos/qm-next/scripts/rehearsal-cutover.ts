/**
 * Cutover rehearsal (p002 P5 21.0): proves the deployment-handoff
 * mechanics against a disposable postgres —
 *
 *   21.1 灰度双跑   same build sha: instances coexist in
 *                  `instance_heartbeats` and share the run queue (the
 *                  entry-side traffic split is the LB's weights).
 *   21.2 blue-green a live newer build drains every older generation —
 *                  claim gate closes, in-flight turns finish; when the
 *                  newer build goes quiet past the liveness window the
 *                  older instances resume (rollback path).
 *   21.3 worker 拆分 real child processes boot api+runner over the same
 *                  `databaseUrl`; claims interleave across processes, a
 *                  SIGKILLed worker's run is taken over via lease expiry
 *                  (attempts 2, exactly-once everywhere else).
 *
 * Run via `pnpm rehearsal:cutover` (scripts/run-cutover-rehearsal.sh) or
 * directly with QM_CUTOVER_PG_URL pointing at an empty postgres.
 */
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
// Root scripts resolve through the repository-root node_modules links:
// @qm/api (and its Context/Service re-export) by package name, store and
// types by relative source path (vendor sources are a separate project).
import { ApiService, Context, Service } from '@qm/api'
import { createPgPool, type PgPool } from '../packages/store/src/pg-pool.ts'
import type { Run, RunStore } from '../packages/types/src/run.ts'
import type { TurnInput } from '../packages/types/src/turn.ts'

const pgUrl = process.env.QM_CUTOVER_PG_URL
if (!pgUrl) {
  console.error('rehearsal-cutover: QM_CUTOVER_PG_URL is required (run via pnpm rehearsal:cutover)')
  process.exit(1)
}
const databaseUrl: string = pgUrl

// Fast cadences: sweeps beats every 400ms, superseding builds go stale
// after 1.2s, run leases expire after 1.5s — the whole rehearsal stays
// well under a minute while exercising the production semantics.
const FAST = {
  drainSweepMs: 400,
  drainLivenessMs: 1_200,
  tickMs: 25,
  leaseTtlMs: 1_500,
  reapIntervalMs: 500,
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function turnInput(text: string): TurnInput {
  return {
    surface: 'rehearsal',
    actor: { id: 'cutover-driver', type: 'internal' },
    conversation: { kind: 'dm', threadRef: `thread:${text}`, audience: [{ id: 'cutover-driver', type: 'internal' }] },
    origin: { kind: 'direct' },
    text,
  }
}

async function waitUntil(label: string, probe: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await probe().catch(() => false)) return
    await sleep(50)
  }
  throw new Error(`rehearsal: timed out waiting for ${label}`)
}

async function waitRun(
  runs: RunStore,
  id: string,
  pred: (run: Run) => boolean,
  label: string,
  timeoutMs = 20_000,
): Promise<Run> {
  let last: Run | null = null
  await waitUntil(
    label,
    async () => {
      last = await runs.get(id)
      return last !== null && pred(last)
    },
    timeoutMs,
  )
  return last!
}

async function waitAllComplete(runs: RunStore, ids: string[], label: string, timeoutMs = 30_000): Promise<Run[]> {
  const out: Run[] = []
  await waitUntil(
    label,
    async () => {
      out.length = 0
      for (const id of ids) out.push((await runs.get(id))!)
      return out.every((run) => run.status === 'done')
    },
    timeoutMs,
  )
  return out
}

async function enqueueRuns(runs: RunStore, count: number, tag: string): Promise<string[]> {
  const ids: string[] = []
  for (let i = 0; i < count; i++) {
    const { run } = await runs.enqueue({ sessionId: `sess-cutover-${tag}-${i}`, request: turnInput(`${tag} ${i}`) })
    ids.push(run.id)
  }
  return ids
}

async function liveHeartbeats(pg: PgPool): Promise<string[]> {
  const rows = await pg.q(
    `SELECT instance_id FROM instance_heartbeats WHERE beat_at > now() - interval '5 seconds'`,
  )
  return rows.map((row) => row.instance_id as string)
}

interface Instance {
  svc: ApiService
  dispose: () => Promise<void>
}

async function boot(id: string, buildSha: string, extra: Record<string, unknown> = {}): Promise<Instance> {
  const svc = new ApiService(new Context(), {
    port: 0,
    secrets: [`cutover-secret-${id}`],
    databaseUrl,
    instanceId: id,
    buildSha,
    ...FAST,
    ...extra,
  })
  const dispose = (await svc[Service.init]()) ?? (async () => undefined)
  return { svc, dispose }
}

const WORKER_ENTRY = fileURLToPath(new URL('./cutover-worker-entry.ts', import.meta.url))

interface WorkerHandle {
  id: string
  child: ChildProcess
  stdout: string
  stderr: string
  ready: Promise<void>
}

function spawnWorker(id: string, stallMs?: number): WorkerHandle {
  const handle: WorkerHandle = {
    id,
    child: spawn(
      process.execPath,
      ['--import', 'tsx/esm', WORKER_ENTRY],
      {
        env: {
          ...process.env,
          QM_CUTOVER_PG_URL: databaseUrl,
          QM_CUTOVER_INSTANCE_ID: id,
          QM_CUTOVER_BUILD_SHA: 'v3',
          QM_CUTOVER_TICK_MS: String(FAST.tickMs),
          QM_CUTOVER_LEASE_TTL_MS: String(FAST.leaseTtlMs),
          QM_CUTOVER_DRAIN_SWEEP_MS: String(FAST.drainSweepMs),
          QM_CUTOVER_DRAIN_LIVENESS_MS: String(FAST.drainLivenessMs),
          QM_CUTOVER_REAP_MS: String(FAST.reapIntervalMs),
          ...(stallMs !== undefined ? { QM_CUTOVER_STALL_MS: String(stallMs) } : {}),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    ),
    stdout: '',
    stderr: '',
    ready: Promise.resolve(),
  }
  handle.child.stdout!.on('data', (chunk: Buffer) => {
    handle.stdout += chunk.toString()
  })
  handle.child.stderr!.on('data', (chunk: Buffer) => {
    handle.stderr += chunk.toString()
  })
  handle.ready = waitUntil(
    `worker ${id} ready`,
    async () => handle.stdout.includes(`cutover-worker ready ${id} `),
    60_000,
  ).catch((err: unknown) => {
    throw new Error(`rehearsal: worker ${id} failed to boot\nstdout: ${handle.stdout}\nstderr: ${handle.stderr}\n${err}`)
  })
  return handle
}

async function stopWorker(handle: WorkerHandle): Promise<void> {
  if (handle.child.exitCode !== null) return
  handle.child.kill('SIGTERM')
  await waitUntil(`worker ${handle.id} exit`, async () => handle.child.exitCode !== null, 10_000).catch(() => {
    handle.child.kill('SIGKILL')
  })
}

let passCount = 0
function pass(label: string): void {
  passCount += 1
  console.log(`  ok  ${label}`)
}

async function main(): Promise<number> {
  const pg = createPgPool(databaseUrl, [])
  const instances: Instance[] = []
  const workers: WorkerHandle[] = []
  let failures = 0
  try {
    // ---- Phase 1: 灰度双跑 (21.1) — same build sha shares the queue ----
    console.log('phase 1: 灰度双跑 — same-sha instances coexist and share the run queue')
    const blue = await boot('inst-blue', 'v1')
    instances.push(blue)
    await waitUntil('inst-blue heartbeat', async () => (await liveHeartbeats(pg)).includes('inst-blue'))
    const first = await enqueueRuns(blue.svc.runs, 20, 'gray-a')
    const firstDone = await waitAllComplete(blue.svc.runs, first, 'first 20 runs complete')
    assert.ok(firstDone.every((run) => run.attempts === 1), 'exactly-once before the second instance joins')
    assert.ok(firstDone.every((run) => run.workerId === 'inst-blue'), 'solo instance processed everything')
    pass('solo instance claims the queue')

    const green = await boot('inst-green', 'v1')
    instances.push(green)
    await waitUntil('inst-green heartbeat', async () => (await liveHeartbeats(pg)).includes('inst-green'))
    assert.equal(blue.svc.drain?.canClaim(), true, 'same sha: blue keeps claiming')
    assert.equal(green.svc.drain?.canClaim(), true, 'same sha: green keeps claiming')
    pass('same-sha coexistence: neither instance drains')

    const second = await enqueueRuns(green.svc.runs, 20, 'gray-b')
    const secondDone = await waitAllComplete(green.svc.runs, second, 'next 20 runs complete')
    const workerSet = new Set(secondDone.map((run) => run.workerId))
    assert.ok([...workerSet].every((id) => id === 'inst-blue' || id === 'inst-green'), 'worker ids within the generation')
    assert.equal(workerSet.size, 2, 'both same-sha instances won claims')
    assert.ok(secondDone.every((run) => run.attempts === 1), 'no double execution across instances')
    pass('run queue shared across same-sha instances (20/20 attempts=1, both workers visible)')

    // ---- Phase 2: blue-green handoff (21.2) ----
    console.log('phase 2: blue-green — a newer build drains the older generations, rollback resumes them')
    const green2 = await boot('inst-green2', 'v2')
    instances.push(green2)
    await waitUntil('blue drains under v2', async () => blue.svc.drain?.canClaim() === false)
    await waitUntil('green drains under v2', async () => green.svc.drain?.canClaim() === false)
    assert.equal(green2.svc.drain?.canClaim(), true, 'the new build keeps claiming')
    pass('newer build supersedes every older generation (claim gate closed)')

    const third = await enqueueRuns(green2.svc.runs, 10, 'bg')
    const thirdDone = await waitAllComplete(green2.svc.runs, third, 'blue-green batch complete')
    assert.ok(thirdDone.every((run) => run.workerId === 'inst-green2'), 'new build owns all new claims')
    assert.ok(thirdDone.every((run) => run.attempts === 1), 'no double execution during handoff')
    pass('claims moved to the new build (10/10 by inst-green2)')

    await green2.dispose()
    instances.pop()
    await waitUntil('blue resumes after rollback', async () => blue.svc.drain?.canClaim() === true, 10_000)
    await waitUntil('green resumes after rollback', async () => green.svc.drain?.canClaim() === true, 10_000)
    pass('newer build gone → older generations resume (rollback path)')

    // ---- Phase 3: worker 拆分 (21.3) — real child processes ----
    console.log('phase 3: worker 拆分 — split child processes over the shared database + crash takeover')
    const keeper = await boot('inst-main', 'v2')
    instances.push(keeper)
    await waitUntil('v1 drains again under keeper', async () => blue.svc.drain?.canClaim() === false)

    const stalled = spawnWorker('worker-a', 60_000)
    workers.push(stalled)
    await stalled.ready
    await waitUntil('keeper drains under child v3', async () => keeper.svc.drain?.canClaim() === false)
    pass('child process heartbeat supersedes the parent instance (cross-process drain)')

    const stallRun = await enqueueRuns(keeper.svc.runs, 1, 'stall')
    await waitRun(
      keeper.svc.runs,
      stallRun[0]!,
      (run) => run.status === 'running' && run.workerId === 'worker-a',
      'worker-a claims and stalls in the turn',
    )
    pass('stalled run held by the child (status=running, worker=worker-a)')

    stalled.child.kill('SIGKILL')
    const takeover = spawnWorker('worker-b')
    workers.push(takeover)
    await takeover.ready
    const stalledDone = await waitRun(
      keeper.svc.runs,
      stallRun[0]!,
      (run) => run.status === 'done',
      'stalled run taken over after lease expiry',
    )
    assert.equal(stalledDone.attempts, 2, 'the takeover is a second attempt')
    assert.notEqual(stalledDone.workerId, 'worker-a', 'the crashed worker did not finish it')
    pass(`SIGKILL mid-turn → lease expiry → another instance re-ran it (attempt 2 by ${stalledDone.workerId})`)

    const other = spawnWorker('worker-c')
    workers.push(other)
    await other.ready
    const split = await enqueueRuns(keeper.svc.runs, 20, 'split')
    const splitDone = await waitAllComplete(keeper.svc.runs, split, 'split batch complete')
    const splitWorkers = new Set(splitDone.map((run) => run.workerId))
    assert.ok([...splitWorkers].every((id) => id === 'worker-b' || id === 'worker-c'), 'child workers own the claims')
    assert.ok(splitDone.every((run) => run.attempts === 1), 'exactly-once across the child workers')
    const live = await liveHeartbeats(pg)
    assert.ok(live.includes('worker-b') && live.includes('worker-c'), 'both child workers registered in the same registry')
    pass('two child processes share the queue without sticky routing (both registered, 20/20 attempts=1)')

    // ---- exact-once ledger across the whole rehearsal ----
    const all = await pg.q(`SELECT status, attempts FROM runs WHERE session_id LIKE 'sess-cutover-%'`)
    const failed = all.filter((row) => row.status === 'failed')
    const stuck = all.filter((row) => row.status === 'pending' || row.status === 'running')
    const doubleDone = all.filter((row) => row.status === 'done' && Number(row.attempts) > 2)
    assert.deepEqual([...failed, ...stuck, ...doubleDone], [], 'ledger: zero failed, zero stuck, zero triple-claimed')
    pass(`ledger clean: ${all.length} runs, every run done with attempts ≤ 2`)
  } catch (err) {
    failures += 1
    console.error('\nrehearsal-cutover: FAILED')
    console.error(err)
  } finally {
    for (const handle of workers) await stopWorker(handle).catch(() => undefined)
    while (instances.length > 0) {
      const inst = instances.pop()!
      await inst.dispose().catch(() => undefined)
    }
    await pg.close().catch(() => undefined)
  }
  if (failures === 0) console.log(`\nrehearsal-cutover: PASS (${passCount} checks)`)
  else console.log(`\nrehearsal-cutover: FAIL (${passCount} checks passed before the failure)`)
  return failures === 0 ? 0 : 1
}

process.exit(await main())

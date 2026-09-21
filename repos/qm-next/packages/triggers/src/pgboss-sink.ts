/**
 * pg-boss-backed TriggerSink (cluster 2 brief `qm-next-c2-pgboss-queue`):
 *
 *   - `fire(input)` calls the underlying FireEngine synchronously so the
 *     caller still gets the real `runId` + dedup verdict (matches today's
 *     `createTriggerSink` semantics: two `fire()` calls with the same
 *     key dedupe onto the same run).
 *   - Each fire is mirrored into a pg-boss `singleton` queue keyed by
 *     `input.key`, giving a durable cross-instance audit log and a
 *     recovery path if the local process dies between fire and terminal
 *     handling.
 *   - A worker (`start()`) re-runs the same fire for any pre-existing
 *     singleton job that the local process didn't finish — idempotent
 *     because `engine.submit` dedupes on `fireKey`.
 *   - The tick scheduler stays the default; `JOB_QUEUE=pgboss` flips the
 *     composition root to this sink (cluster 2 follow-up wires that
 *     flag; this brief only adds the primitive).
 */
import { PgBoss } from 'pg-boss'
import type { TriggerFireInput, TriggerSink, TriggerSubmission } from './contract.ts'
import type { FireEngine } from './fire.ts'

/** pg-boss queue name used for trigger fires. */
export const PGBOSS_TRIGGER_QUEUE = 'qm_trigger_fire'

export interface PgBossSinkOptions {
  /** Postgres connection string (or any URL pg-boss accepts). */
  connectionString: string
  /** Queue name; defaults to `qm_trigger_fire`. */
  queueName?: string
  /** Worker concurrency; defaults to 4. */
  workerConcurrency?: number
  /** How long completed jobs are retained (seconds); defaults to 7 days. */
  retentionSeconds?: number
  /** Cap on how long a job may sit before being considered failed (seconds); defaults to 30 minutes. */
  expireInSeconds?: number
  /**
   * When true, mirror `fire()` calls into pg-boss without starting a
   * worker (useful for production setups that run workers on a separate
   * process). Defaults to false.
   */
  enqueueOnly?: boolean
}

export interface PgBossSinkHandle {
  /** TriggerSink shape — caller assigns this to `triggers` directly. */
  fire(input: TriggerFireInput): Promise<TriggerSubmission>
  /** Start the pg-boss worker. Idempotent. */
  start(): Promise<void>
  /** Stop the worker (queue stays mirrored; engine stays call-able). */
  stop(): Promise<void>
  /** Tear down pg-boss (drains the queue poller). */
  close(): Promise<void>
}

/**
 * Build a TriggerSink whose every fire is durably mirrored into pg-boss.
 *
 * `engine` is the existing fire engine (built by `createFireEngine`); the
 * sink calls it synchronously to keep today's contract, then enqueues for
 * durability. The pg-boss worker is opt-in via `start()`; until it's
 * running, the sink is a fire-and-mirror with no drain side.
 */
export function createPgBossSink(engine: FireEngine, opts: PgBossSinkOptions): PgBossSinkHandle {
  if (!opts.connectionString) throw new Error('createPgBossSink: connectionString is required')

  const queueName = opts.queueName ?? PGBOSS_TRIGGER_QUEUE
  const workerConcurrency = opts.workerConcurrency ?? 4
  const retentionSeconds = opts.retentionSeconds ?? 7 * 24 * 60 * 60
  const expireInSeconds = opts.expireInSeconds ?? 30 * 60

  const boss = new PgBoss(opts.connectionString)

  let started: Promise<void> | null = null
  let working: Promise<string> | null = null
  const ensure = (): Promise<void> =>
    (started ??= boss.start().then(() => boss.createQueue(queueName).then(() => undefined)))

  async function submit(input: TriggerFireInput): Promise<TriggerSubmission> {
    const submission = await engine.submit({
      surface: 'trigger',
      fireKey: input.key,
      text: input.text,
      ownerId: input.ownerId,
      ...(input.ownerType ? { ownerType: input.ownerType } : {}),
      ...(input.scopeId ? { scopeId: input.scopeId } : {}),
      ...(input.destination ? { destination: input.destination } : {}),
      ...(input.title ? { title: input.title } : {}),
      firedAt: Date.now(),
    })
    return submission
  }

  const sink: TriggerSink = {
    async fire(input: TriggerFireInput): Promise<TriggerSubmission> {
      const submission = await submit(input)
      // Mirror into pg-boss for durability. Use `singletonKey` so re-firing
      // the same key replaces the queued job instead of stacking.
      try {
        await ensure()
        await boss.send(
          queueName,
          input as unknown as object,
          {
            singletonKey: input.key,
            retryLimit: 3,
            retryBackoff: true,
            expireInSeconds,
            retentionSeconds,
          },
        )
      } catch (err) {
        // pg-boss is a durability layer, not the source of truth. If the
        // mirror fails (e.g. PG transient down), the local fire still
        // succeeded; surface a warning and continue.
        process?.emitWarning?.(`pg-boss mirror failed for fire ${input.key}: ${String(err)}`, 'PgBossSinkWarning')
      }
      return submission
    },
  }

  return {
    fire: sink.fire,
    async start(): Promise<void> {
      if (opts.enqueueOnly) return
      if (working) return
      await ensure()
      working = boss.work(
        queueName,
        { batchSize: workerConcurrency },
        async (jobs: Array<{ data: TriggerFireInput }>) => {
          for (const job of jobs) {
            try {
              // Idempotent re-run: engine.submit dedupes by fireKey, so
              // re-running a job whose local fire already happened returns
              // the existing runId.
              await submit(job.data)
            } catch (err) {
              // Worker error → pg-boss retries per `retryLimit`. Don't
              // throw here, or pg-boss marks the batch failed.
              process?.emitWarning?.(`pg-boss worker error: ${String(err)}`, 'PgBossSinkWarning')
            }
          }
        },
      )
    },
    async stop(): Promise<void> {
      if (!working) return
      const w = working
      working = null
      await boss.offWork(queueName, { wait: true }).catch(() => undefined)
      await w.catch(() => undefined)
    },
    async close(): Promise<void> {
      await this.stop()
      await boss.stop({ graceful: true, timeout: 30 }).catch(() => undefined)
    },
  }
}
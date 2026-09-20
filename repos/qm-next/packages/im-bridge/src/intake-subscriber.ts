/**
 * Phase 5 — the `bridge` Intake Subscriber (plan §Phase 5 slice 4,
 * ADR-0008/0015). Wraps the existing `ImTurnBridge.sink` so Turn-creation
 * behavior is unchanged, and records the created Turn identity on the
 * Intake Record (`markTurn`, first-writer-wins) so a redelivery after a
 * crash between Turn creation and cursor advance maps to the same Turn
 * instead of enqueueing a second Run.
 */
import type { ImIntakeInbox, IntakeRecord, IntakeSubscriber } from '@qm/im-core'
import type { ImTurnBridge } from './bridge.ts'

/**
 * Tracks the record the bridge subscriber is currently processing so the
 * bridge's `onTurnCreated` hook can attach the Run identity to the right
 * Intake Record. The fan-out is strictly sequential per subscriber, so
 * one slot is enough. Create the tracker BEFORE the bridge (its
 * `onTurnCreated` is a bridge option), then hand it to the subscriber.
 */
export interface BridgeTurnTracker {
  /** Bridge option — invoked after an intake-sourced Turn is enqueued. */
  onTurnCreated(eventId: string, runId: string): Promise<void>
  /** Subscriber-side: bind the record being processed. */
  begin(record: IntakeRecord): void
  /** Subscriber-side: clear the binding when the attempt settles. */
  end(): void
}

export function createBridgeTurnTracker(inbox: ImIntakeInbox): BridgeTurnTracker {
  let current: IntakeRecord | undefined
  return {
    async onTurnCreated(_eventId: string, runId: string): Promise<void> {
      const record = current
      if (!record) return
      await inbox.markTurn(record.id, runId).catch(() => undefined)
    },
    begin(record: IntakeRecord): void {
      // A record that already carries its Turn identity is skipped by the
      // subscriber before sink; binding it would be a no-op anyway.
      current = record.turnId === undefined ? record : undefined
    },
    end(): void {
      current = undefined
    },
  }
}

/**
 * The named `bridge` subscriber: at-least-once dispatch of accepted
 * intake into the turn bridge. Idempotent by the record's Turn identity:
 * when `turnId` is already set the record was fully processed on an
 * earlier attempt and the redelivery is a no-op.
 */
export function createBridgeIntakeSubscriber(bridge: ImTurnBridge, tracker: BridgeTurnTracker): IntakeSubscriber {
  return {
    name: 'bridge',
    async handle(record: IntakeRecord): Promise<void> {
      if (record.turnId !== undefined) return
      tracker.begin(record)
      try {
        await bridge.sink([record.event])
      } finally {
        tracker.end()
      }
    },
  }
}

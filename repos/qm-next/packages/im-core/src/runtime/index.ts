/**
 * Runtime entry (`@qm/im-core/runtime`): implementations behind the frozen
 * contract. Import the contract from `@qm/im-core`, the machinery from here.
 */
export { createMemoryDeliveryQueue } from './memory-delivery-queue.ts'
export { DELIVERIES_SCHEMA_STATEMENTS, createPostgresDeliveryQueue, type PostgresDeliveryQueue } from './postgres-delivery-queue.ts'
export { createImRegistry } from './registry.ts'
export type { ImRegistryHandle } from './registry.ts'
export { ImRegistryService } from './registry-service.ts'
export { createDeliveryLoop } from './delivery-loop.ts'
export { createMemoryIntakeInbox, createMemoryIntakeCursorStore, createMemoryIntakeDeadLetterStore } from './memory-intake-store.ts'
export type { MemoryIntakeInbox } from './memory-intake-store.ts'
export {
  INTAKE_SCHEMA_STATEMENTS,
  createPostgresIntakeInbox,
  createPostgresIntakeCursorStore,
  createPostgresIntakeDeadLetterStore,
} from './postgres-intake-store.ts'
export { createIntakeFanout, createSinkIntakeSubscriber, createMirrorSubscriber, createAuditSubscriber } from './intake-fanout.ts'
export type { IntakeFanout, IntakeFanoutOptions, IntakeIngestResult, IntakeReplayResult } from './intake-fanout.ts'


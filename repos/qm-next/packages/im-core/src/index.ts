/**
 * @qm/im-core — provider-neutral IM contract (M2, frozen at 7.1) and its
 * core-side implementation: registry, inbound routing, delivery claim loop.
 *
 * Layers:
 *   types.ts      shared envelope/capability types
 *   inbound.ts    InboundEvent discriminated union (provider → core)
 *   outbound.ts   OutboundOperation union (core → provider)
 *   delivery.ts   durable outbound queue + claim-loop contracts
 *   provider.ts   ImProvider port every adapter implements
 *   directory.ts  DirectorySync push shapes
 *   registry.ts   ImRegistry + `ctx.im` augmentation
 */
export * from './types.ts'
export * from './inbound.ts'
export * from './outbound.ts'
export * from './delivery.ts'
export * from './provider.ts'
export * from './directory.ts'
export * from './registry.ts'

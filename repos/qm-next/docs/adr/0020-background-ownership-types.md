---
status: proposed
---

# Background ownership is an explicit per-deployment durable record

A core deployment owns the background work it has admitted (cron polling,
slack ingress, inline HTTP, sync turns, in-flight runs, scheduled callbacks,
process sessions, web-ui long-poll). Another deployment may take over only
when the original durable ownership record says so. The reaper, lease
controller, and process sessions all live under that record; switching the
record is the deployment boundary, not the worker boundary.

qm-verbatim discipline: this ADR mirrors qm's `docs/background-ownership.md`
and only adds the layering / type boundaries qm-next enforces (single
cordis process per deployment, memory+PG dual implementation,
`packages/runs/`-scoped ownership types). M-Tape-3 (#56/#57 closed) gates
the renderer-side projection; this ADR gates the deployment-side split.

## Scope of "background work" in qm-next

Everything that survives a turn boundary:

- Cron fires whose `runId` outlives the calling turn (memory + PG
  `cron_fire_log` rows).
- Web-UI long-poll subscribers and observation streams (one cursor per
  subscriber, durable across reconnects).
- Slack / IM ingress handlers holding open `LarkClient` / `IM-Bridge`
  websocket connections.
- Inline HTTP execution via the sandbox process sessions.
- Synchronous turns running under a held run lease.
- Reaper and lease controller watching their respective durable maps.
- Task protection against in-flight turn SIGKILL.

Admission is the durable assertion that a deployment has agreed to do
this work; relinquishment is the durable assertion that it has stopped.
Both belong to the deployment identity, not the worker process — a fresh
process on the same deployment inherits its predecessor's claims; a
process on a different deployment must prove acceptance via a transfer
token before claiming any of it.

## State the types must capture

```
Ownership       { deploymentId, generation, acceptedAt, members[] }
TransferToken   { token, acceptedDeploymentId, sourceDeploymentId, issuedAt, expiresAt }
OwnershipLease  { instanceId, ownership, claimKind, claimId, claimToken, expiresAt }
```

- `Ownership` is the durable record: one per `(deploymentId, generation)`;
  CAS-on-generation increments move it forward.
- `TransferToken` is the sealed credential a relinquishing process
  issues to a successor; carries the source/acceptor identities and a
  hard expiry. Treat its `token` field as opaque and never log it.
- `OwnershipLease` is the per-claim handle a worker holds while doing
  work under an `Ownership`. Binds and loses its lock when the
  reaper / lease controller sees the instance die.

The qm-next §3.4 dependency matrix listed ownership as a P5 21.0
backlog. This ADR moves the type contract forward so P5 21.0's
worker split doesn't have to invent the contract under time pressure.

## Where the types live (qm-next layering)

```
packages/types/src/ownership.ts      (interface only)
packages/runs/src/ownership.ts       (type guards + stubs)
packages/runs/src/task-protection.ts  (tryHandoverOwnership + acceptHandover stubs)
```

`Ownership` / `TransferToken` / `OwnershipLease` ship in `@qm/types` so the
runtime (api / orchestrator / web-ui / portal) and the durable backend
(`@qm/runs`) consume the same contract without an `@qm/runs → @qm/api`
dependency cycle. The type guards `isTransferToken` / `isOwnershipLease`
live next to the runtime stubs in `@qm/runs`; they're called at the
boundary between the wire format (which carries untyped JSON) and the
typed contract.

The stubs throw `"not yet implemented"` — they exist so future P5 21.0
work can land against a stable contract without breaking existing callers
(no callers yet in this batch). The full implementation (PG twin,
memory twin, reaper integration) is explicitly out of scope for this
ADR; see §"Implementation deferral" below.

## Protocol boundary

Adopting this contract is a deliberate two-step process (mirrors qm
`docs/background-ownership.md` "Enable the capability"):

1. **Install** the capability — code lands, the contract is enforced in
   `@qm/types`, but no `BACKGROUND_DEPLOYMENT_ID` is required. Existing
   single-deployment behavior is unchanged.
2. **Bootstrap** the protocol — once both deployments have the contract,
   `BACKGROUND_DEPLOYMENT_ID` + `DEPLOYMENT_CONTROL_SECRET` are
   configured; the first `POST /v1/background-work` carries the cohort.
   Bootstrap is the explicit go-live; until then both deployments verify
   by exact task-ARN matching.

This batch lands step 1 only. The boot-flag mechanism and exact-ARN
cohort verification are part of P5 21.0's `instance-registry` +
`run-signal-store` integration; they are not in this ADR.

## Implementation deferral

Per M-Soul-3 (2026-09-26): this batch ships the **type contract only**.
The following are deferred to P5 21.0:

- PG twin for `Ownership` / `OwnershipLease` DurableMap tables.
- Memory twin (single-process fallback).
- Reaper integration that consumes `Ownership.generation` to decide
  whether a stale instance may have its lease force-released.
- `worker.ts` background loop that respects the admission generation.
- `tryHandoverOwnership` / `acceptHandover` actual implementations.
- `POST /v1/background-work` and `GET /v1/background-work` route
  surfaces (`packages/api/src/routes/admin-routes.ts` lane).

Until those land:

- `tryHandoverOwnership` throws `"not yet implemented"` (consistent with
  the qm-next "fail loud, fail closed" discipline).
- `acceptHandover` throws `"not yet implemented"`.
- No caller is allowed to assume admission generation fences work;
  single-deployment semantics continue unchanged.
- Existing `task-protection.ts` ECS PUT path is untouched.

## Acceptance criteria (this ADR)

- `packages/types/src/ownership.ts` exports `Ownership`, `TransferToken`,
  `OwnershipLease` with no `@qm/runs`-shaped dependencies.
- `packages/runs/src/ownership.ts` exports `isTransferToken` /
  `isOwnershipLease` type guards and the two stub functions.
- `packages/runs/src/task-protection.ts` re-exports the stubs for the
  composition-root convenience; the existing `createEcsTaskProtection`
  path is unchanged.
- `pnpm typecheck` + `pnpm test` green; new tests pin the "throw not yet
  implemented" contract so P5 21.0 cannot silently regress to a no-op.

## Considered options

- **Keep the contract fully implicit (status quo)**: rejected because
  P5 21.0 worker split would have to invent three coupled types under
  time pressure, and the worker / reaper / lease controller would each
  pick a slightly different shape.
- **Re-export qm's types verbatim via `@qm/types`**: rejected for the
  same reason `#56` rejected re-exporting qm's tape projection —
  qm-next's narrower `RuntimeChoice` discipline, `check:im` IM-symbol
  isolation, and `exactOptionalPropertyTypes` already differ; verbatim
  ports accumulate drift.
- **Implement the protocol now (PG twin + reaper integration)**:
  rejected by M-Soul-3 (2026-09-26); the contract is the deliverable.

## Compatibility

The contract is additive. No existing route / store / harness consumes
the new types; existing behavior is preserved bit-for-bit. Migration of
`packages/runs/src/task-protection.ts` is a re-export only, not a
behavior change. The two stub functions have no callers and cannot
fail to compile a consumer that does not import them.
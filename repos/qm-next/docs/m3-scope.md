# M3 scope: enterprise capability packages (11.0 draft)

Status: DRAFT for serial-gate confirmation. Inventory surveyed against qm
`main` (2026-09-12). Goal: parity of core enterprise capabilities, not
Slack-specific polish. Five packages per the task plan; boundaries and
acceptance items below; open questions need user sign-off before lanes open.

## Inventory → package map

### 12.0 `packages/approvals` (approvals + ambient)

qm sources: `src/slack/approvals.ts` (862L), `approval-cards.ts`,
`approval-context.ts`, `agent-requests.ts`; ambient:
`src/api/app-ambient.ts`, `src/surface-cache/{ambient-judge,ambient-judgment-store,channel-policy-store}.ts`,
`src/wake/`.

Capabilities in qm: turn pauses on `pendingApprovals` (orchestrator already
emits these); approval registry with persistence and restart recovery
(`recoveredApprovalContext`); card render + click → decision → resume or
terminate; reaction-as-ack; agent-request directives; ambient = judge model
deciding engagement for un-@mentioned chatter, with org/channel switches,
persisted judgments, cursors.

qm-next M3 boundary:
- IN: approval store (memory + pg) keyed by requestId; decision state machine
  (pending → approved/rejected → resume/terminate); Interaction → decision
  routing (replaces im-bridge placeholder card semantics; card RENDERING stays
  provider-side via opaque `OutboundBody.card`); channel policy port with
  ambient on/off (default off); ambient judge PORT (pluggable, default no-op)
  submitting turns with `origin: { kind: 'ambient' }`.
- OUT: judge model prompt/persistence, ambient cursors, reaction-as-ack,
  agent-request directives.

Acceptance: paused mock turn → card → approve resumes, reject terminates;
double-click deduped; decision survives restart (pg); ambient off = zero
behavior change; judge stub on → non-mention message yields an ambient turn.

### 13.0 `packages/triggers` (cron + triggers)

qm sources: `src/cron/{cron-store,schedule,scheduler,cron-fire-store,job-queue}.ts`,
`src/triggers/{run-trigger,trigger-store,consent-notice,edit-notice,keychain-ask,provenance}.ts`.

Capabilities in qm: cron CRUD + schedule math, leader-lease tick, fire dedup
(cron-fire-store + idempotency), fire → TurnRequest → delivery of reply;
triggers (event-driven turns) with consent, visibility, membership gates and
delivery provenance.

qm-next M3 boundary:
- IN: cron store (memory + pg), scheduler service (tick lease, next-fire,
  fire → run queue, reply → im delivery queue), fire idempotency; trigger
  port: `fireTrigger(key, destination, text)` → turn.
- OUT: consent/keychain-ask/edit-notice flows, provenance UI, job-queue
  (pg-boss style) — scheduler tick suffices at this scale.

Acceptance: fake-clock test fires on schedule once (idempotent), leader lease
blocks double-fire, reply lands in im delivery queue; trigger creates a turn.

### 14.0 `packages/memory` + `packages/skills`

qm sources: `src/memory/{memory-service,postgres-memory-service,notebook,strategies/,memorable/,provider-*.ts}`,
`src/skills/{skill-store,skill-pack-store,ingest,materialize,skill-sync-engine,skill-collision,...}.ts`.

Capabilities in qm: scoped MEMORY.md notebook (≤300 facts, revision tokens,
normalization), file + postgres providers, strategy modes (per-turn,
agent-only, consolidation, scratch-promote), memorable relay; skills: bundle
store, packs, name normalization/collision, materialization paths, sync
engine.

qm-next M3 boundary:
- IN (memory): `ScopeMemory` port — head/get/append with revision conflict
  detection, recall-by-bullets; memory + pg implementations. Hook point:
  orchestrator resolution injects recalled memory into systemPrompt.
- IN (skills): skill registry + lookup (name → materialized skill body)
  exposed to harness input assembly; collision-checked names.
- OUT: pack fetching, sync engine, memorable relay, strategy modes beyond
  static selection.

Acceptance: per-scope memory round-trip with conflict detection (both impls,
parity test); skill registered → appears in harness input context.

### 15.0 `packages/reach` + `packages/directory`

qm sources: `src/reach/reach.ts` (329L), `src/directory/{directory-store,person,visibility,postgres-directory-store}.ts`.

Capabilities in qm: recipient/channel/group resolution from queries, group
DM open/register, visibility filtering (external/private), person identity
merging; powers triggers, ambient roster, approvals.

qm-next M3 boundary:
- IN (directory): `DirectoryStore` port fed by im-core `DirectorySyncPush`
  (shapes already align: people/spaces/spaceMembers); memory + pg impls;
  visibility filter.
- IN (reach): query → Destination resolution (recipient/channel/group),
  member checks. Consumers: triggers, approvals (approval card destination).
- OUT: person identity merge heuristics, openGroup (provider write-back) —
  registry `collectDirectory` covers the read path first.

Acceptance: provider `collectDirectory()` push → store → resolve "@name" →
Destination; external spaces filtered by visibility; parity test impls.

### 16.0 `packages/web-ui`

qm sources: `plugins/web-ui` (Lit SPA, ~60 modules: sessions, crons, skills,
memory, files, deploys, ambient-policy, playground, webhooks, connectors...).

Confirmed at the gate (2026-09-13): web-ui is a **conversation surface**, not
an admin panel — qm's web app is a first-class chat client over the pi agent.

qm-next M3 boundary:
- IN: **SPA ports wholesale** — `plugins/web-ui/src/` + its pi deps
  (`pi-web-ui`, `pi-agent-core`) move as-is; the backend coupling is
  concentrated in `src/core-bridge.ts` (`streamFn`: `POST /v1/turns?async=1`
  + SSE `GET /api/runs/:id/events` + polling fallback), and qm-next's async
  turn API already speaks that shape. The **server half is rewritten** as a
  thin cordis plugin: serve `dist`, principal cookie (dev mode), proxy
  turns/runs, and the **SSE run-events endpoint** backed by the frozen
  `RunEventBus` (`@qm/types`, wired through `OrchestratorDeps.runEvents`).
  Views whose backends land in M3 (skills picker, crons, contexts) go live;
  webhooks/files/connectors/deploys render stub-empty states.
- OUT: playground, deploys, files, connectors, webhooks UI, ambient-policy
  UI, portal SSO (bind 127.0.0.1, no auth — admin hardening is follow-up).

Estimate: ~1.5–2d (was ~1d; +SSE run-events seam). Independent lane.

## Frozen at the gate (11.0, 2026-09-13)

- `RunEventBus` port (`packages/types/src/run-events.ts`) + memory
  implementation (`packages/store`) + optional `OrchestratorDeps.runEvents`
  wiring — the only cross-cutting contract change; backwards compatible.
- Per-package ports (`ApprovalStore`, `CronStore`/`TriggerSink`,
  `ScopeMemory`, `SkillRegistry`, `DirectoryStore`) are committed by each
  lane as its first commit, mirroring the im-core 7.1 pattern — no lane
  consumes another package's internals, except **DirectoryStore**, which
  13.0 (triggers) and web-ui (contexts) consume: 15.0 commits its contract
  file before those two start reading it.
- Lane-opening protocol: contracts committed → `pnpm install` by the main
  session → lane works only in its package directory → contract gaps stop
  the lane and return to the main session.

## Open questions for gate confirmation

RESOLVED 2026-09-13: (1) approvals pg recovery IN (restart-safe pending
approvals; "resume" = durable decision + approval-carrying follow-up turn —
harness-side pause/resume lands with the real harness package); (2) ambient
minimal slice IN (policy store + judge port, judge model OUT); (3) skills
registry + lookup confirmed; (4) web-ui = chat surface + SSE (revised from
minimal-admin at the gate, see 16.0); (5) `pnpm test:pg` container parity
gate runs at serial gates (11.x/17.x) and M4 close, not per-edit.

## Dependency order for lanes

directory (15) feeds approvals-card-destination + triggers; memory/skills
(14) independent; triggers (13) wants directory for recipient resolution but
can lane against the frozen DirectoryStore contract; web-ui (16) last (needs
api surfaces stable). Suggested lane split stays as planned (A1/A2/A3,
B1/B2) with contracts frozen first.

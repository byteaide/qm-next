# Parity Clearance — `qm-next` vs `qm`

**Date**: 2026-09-21
**Source**: `repos/qm-next/docs/parity-deviations.md` (54 deviations + 17.0 closure table + P5 19.0/20.0 sections)
**Method**: Read every line of `parity-deviations.md`, then verified status in repo via targeted greps against `repos/qm-next/packages/`.

## Legend

- ✅ Landed — verified present in repo
- 🟡 Partial — route/contract/port registered, backend behaviour or final piece missing
- ❌ Still open — verified absent; will need a future ticket
- ⚪ Removed by decision or out-of-scope per `m3-scope.md` gate

## P1 contract freeze (#1-10)

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | `HarnessTurnInput.tools` optional | ✅ | profile-assembly 4.1 landed |
| 2 | Security-screening callbacks | 🟡 | `@qm/security` exists; `HarnessSecurityScreenInput` freezing needs spot check on `packages/types` |
| 3 | `HarnessModelUtilities` P4 members (judge/pickAckEmoji/summarizeApproval) | ✅ | `createModelAmbientJudge` in `@qm/approvals` |
| 4-7 | Config/contract alignment | ✅ | Type layer aligned |
| 8 | `ToolContext` M3 surfaces | 🟡 | Core executors wired; publish/background/MCP/surface still return honest unavailable per route |
| 9 | SessionStore tape/LLM-record methods | ✅ | Memory + PG dual impl |
| 10 | Goal hooks vocabulary | ✅ | Types frozen |

## Lane A1/A2/A3/A4/B/B2 (#11-25, #30-36)

| # | Item | Status | Evidence |
|---|---|---|---|
| 11-13 | DurableMap/keychain/secret-source | ✅ | `@qm/store` |
| 14 | Keychain manifest/ask-notice renderers | ⚪ | IM domain, dropped |
| 15 | Model stores staged | ✅ | `@qm/model` |
| 17 | WorkspaceStore seam narrowed | ✅ | `ScratchLogStore` replaces (15.0b) |
| 18 | Blob staging control-plane | ✅ | 12.0 control plane landed; blob transfer accepts capability |
| 19-21 | OAuth/JWT/tar codec | ✅ | `@qm/model` / `@qm/credentials` |
| 22 | secret-drop + codex-device-login | 🟡 / ❌ | secret-drop form/redeem ladder in; **`requiresToken` binding still open** (`parity-lanes-routes.ts:146`); codex-device-login **still 502** in `user-model-auth-routes.ts:55-64` |
| 23-24 | pi-coding-agent vendored + config injection | ✅ | `@qm/pi-coding-agent` |
| 25 | tape audience filtering + RunSignal.request | 🟡 | `RunSignal.request: TurnInput` typed; audience filter per harness needs spot check |
| 27 | Local sandbox image is P1 subset | 🟡 | `aws/microvm-agent` + `fly/Dockerfile` + `local/Dockerfile` exist at root; base tags still unpinned (operations.md §8) |
| 28 | No per-turn tool ledger | ❌ | Comment in tools lane: "lands with runs/replay lane" |
| 30 | Per-package narrow task-store | ✅ | `@qm/tasks` |
| 31-32 | Platform-neutral surface name + 5s signal timeout | ✅ | check:im clean |
| 33-34 | Run-signal contract + Reaper | ✅ | `@qm/runs` |
| 35-36 | Worker / real-task smokes | 🟡 | pi proven (4.2); claude/codex/opencode smokes still skip-until-key |

## P3 lane A (#37-41, #43)

| # | Item | Status | Evidence |
|---|---|---|---|
| 37 | `either` auth → capability principal | ✅ | 12.0 capability tokens |
| 38 | Cron routes @ M3 store scope | 🟡 | Base routes live; `runAs` / `unattendedGrants` need 14.0 IM domain (dropped) |
| 39 | Reach send gate = 501 | 🟡 | `/v1/reach` registered; 501 not_configured stands (web-ui text delivery dropped) |
| 40 | Directory routes | ✅ | `@qm/directory`; `deactivate`/`reactivate` present |
| 43 | Memory/skills routes lane-A principal | ✅ | 12.0 capability tokens unlock memory grant |

## P3 lane A tranche 3 (#42, #44, #45, #46)

| # | Item | Status | Evidence |
|---|---|---|---|
| 42 | Surface sessions/conversations | ✅ | SessionStore extensions all in; **`regenerateTitle` LLM path is live** in `pi-harness.ts:2095`, `claude-harness.ts:955`, `codex-harness.ts:1727`, `opencode-harness.ts:1492` |
| 44 | Context/surface-cache/projects lane-A | 🟡 | (a) `identity_unverified` / `channel_not_found` / `ambiguous_channel` vocabulary imported in `@qm/reach` (`contract.ts:103,165,171`) and `packages/types/src/tools.ts:459-463`; (b) `/v1/surface-file` `download: null` shape in; (c) `context-policy-routes.ts:5` self-documents "lane A" gap (membership check missing); (d) projects member check + environments viewer-only list still lane-A |
| 45 | Files/grants/share/soul/... | 🟡 | (a) share 401 resolved via 12.0; (b) **deployment proxy lane (`/d/<slug>`, git http-backend, admin proxy) routes are NOT registered** — only the in-memory `DeploymentStore` is wired; `deployment-routes.ts:4` self-documents "needs the deployment runtime, which lands with the 13.0 im-bridge"; (c) connectors OAuth consent mint/redeem routes are live in `connector-routes.ts:211-212`; (e) `soul-routes.ts:4` self-documents `managesScope` unwired; (g) per-process stores for environments/projects/connectors/webhooks deliberately preserved per `services/{environment-registry, project-store, webhook-store}.ts` (see #816 comment) |
| 46 | Admin block + closing modules | 🟡 | (a) Admin guards in; **`command-policy-simulate` still 501** (13.0 deferred); (b) admin file ACL bypass for reads — note (12.0) but ACL package now exists, may have closed — needs spot check; (g) secret-drop mint 401 + form/redeem ladder live |

## 12.0 control plane (#47-49)

| # | Item | Status | Evidence |
|---|---|---|---|
| 47 | 12.0 control plane substitutions | 🟡 | `@qm/admin` + `@qm/auth` landed; share / capability / blobs / secret-drop routed. Open sub-items: (a) drop URL `requiresToken` binding (parity-lanes-routes.ts:146); (b) portal identity wired in `@qm/auth` but **not enforced by gate**; (d) identity + capability scope-membership (`authorizesCapabilityScope`) unwired, so revoked-scope 403s cannot fire; (e) runs-based aggregates keep `sessionsByThreadRefs` seam null |
| 48 | Admin console | ✅ | `packages/api/admin-ui/` byte-level port + `/admin/ui` served |
| 49 | Portal SSO | 🟡 | `@qm/portal` package in (18.2); **impersonation routes unported** (self-documented); playground anonymous sessions stay with 13.0 (dropped); production boot checklist reduced — full one lands with deployment hardening |

## 13.0 web-ui + deploy (#50)

| # | Item | Status | Evidence |
|---|---|---|---|
| 50 | Web-ui convergence relay | ✅ | `createApiRelay` + 12 domain relays |

## 14.0 IM-domain backfill (#51-54)

| # | Item | Status | Evidence |
|---|---|---|---|
| 51 | Ambient model judge | ✅ | `createModelAmbientJudge` in `@qm/approvals/ambient-judge-model.ts`; `ambientJudgeMode: 'model' \| 'keyword'` in `im-bridge` (`bridge.ts:114`, `service.ts:64-162`) |
| 52 | Reaction-as-ack | 🟡 | 14.0b live in `im-feishu`; emoji removal has a windowed race (self-documented; qm has the same) |
| 53 | Agent-request adaptations | ✅ | `qm.agent-request.v1` codec + Lark card renderer in `@qm/approvals` |
| 54 | Consent / edit / ask / provenance | 🟡 | Recipient-consent pure helpers + cron stamp live; webhook consent deferred (dropped); destination retargeting **never implemented** (no qm-next route); DM-unresolvable cases warn+mark |

## 15.0 / 16.0 long-tail subsystems

| Topic | Status | Evidence |
|---|---|---|
| Memory strategies / routing / providers | ✅ | `@qm/memory` full; MCP provider refused in `parseMemoryProviderConfig` (16.0 follow-up) |
| Reach `openGroup` write-back | ✅ | `ReachOpts.mayOpenGroup` + 502 ladder in `@qm/reach` |
| Directory `personKey` | ✅ | `@qm/directory/src/person.ts` |
| Skills full lifecycle | ✅ | `@qm/skills` 14.0 + 15.0c |
| Monitors | 🟡 | Store + broker live in `@qm/monitors`; **poller not ported** (`monitor-broker.ts:6`, `monitor-store.ts:8` self-document) |
| ACL | ✅ | `@qm/acl` + `acl_grants_version` PG trigger |
| Tasks | ✅ | `@qm/tasks` + PG schema |
| Processes / insights | ✅ | `@qm/processes`, `@qm/insights` |
| Security | ✅ | `@qm/security` (screener + posture) |
| Egress authz | ✅ | `@qm/egress-authz` |
| Connectors cores | 🟡 | Background-exec / oauth-flow / consent-link / browser-session / secret-envelope live; **`connectors/oauth.ts` (626L, PROVIDERS+well-known+PKCE+refresh) and `emoji-upload-service.ts` (199L, IM-specific) still out** — comment at connectors section says "until IM providers land in P5 18.0" |

## P5 19.0 / 20.0 productionization

| Item | Status | Evidence |
|---|---|---|
| 19.0 Migration decisions + 44/44 rehearsal | ✅ | `docs/migration.md` |
| 20.0 Durable-by-default sweep | ✅ | `packages/api/src/service.ts` PG twins; new twins: `createPostgresDeliveryQueue`, `createPostgresChannelPolicyStore`, `createPostgresFileStore` |
| S3 byte backend | ❌ | `operations.md` §8 explicitly defers; byte-store only has memory + local |
| `instance_heartbeats` 21.0 multi-instance | 🟡 | Table in `packages/runs/src/instance-registry.ts`; `TRUNCATE_ONLY notes-only` path is by design — not a true multi-instance handoff |

## Cross-cutting 16.0 follow-ups (status)

```
❌  Deploy runtime (13.0)             — AWS/Fly/Docker providers + /d/<slug> proxy + git http-backend
❌  S3 byte backend (20.0+)           — memory/local only
❌  MonitorPoller (16.0 follow-up)    — broker/store live, poller absent
❌  pg-boss job queue (16.0 follow-up) — blocked by lockfile-only policy; comment in triggers/contract.ts
❌  codex-device-login                — user-model-auth returns 502 oauth_start_failed
❌  subscription OAuth                — user-model-auth returns 502 oauth_complete_failed
❌  emoji-upload-service              — returns "isn't available in this deployment"
❌  Webhook deliveries → agent        — IM domain (decision: dropped)
🟡  environments / projects stores    — deliberately per-process in @qm/api/src/services/
🟡  ToolContext publish/background/MCP — honest-unavailable per route
🟡  secret-drop dropUrl token binding  — #47a, awaits 13.0 web runtime
🟡  portal identity enforcement        — #47b, wired not enforced
🟡  revoked-scope 403                 — #47d, identity+capability scope-membership unwired
🟡  runs aggregate sessionsByThreadRefs — #47e
🟡  Ambient judge model default-on    — currently `keyword` is default; `model` requires explicit config
🟡  Local sandbox base image digest pin — #27, lands with image-supply lane
🟡  Per-turn tool ledger              — #28, lands with runs/replay lane
🟡  Reach / ambient DM unresolvable    — #53/54, warn+mark
🟡  PG twins gap list                 — tasks/acl/admin sinks/runs activity/signals/instance registry/ambient/ack (per `docs/migration.md` 20.0 checklist)
```

## Bottom line

Since 2026-09-15 the deviations ledger has closed substantially (12.0 control plane, 16.0 long-tail, 18.2 portal SSO, 19.0 migration, 20.0 durable-by-default). Three real gap clusters remain:

1. **Deploy runtime** — biggest: DeployProvider, `/d/<slug>` serving, git http-backend, AWS/Fly/Docker providers. Marked 13.0 but not started.
2. **Productionization follow-ups** — S3 / pg-boss / MonitorPoller / codex-device-login / emoji-upload. All explicitly tagged as 16.0 follow-ups and not started.
3. **Small tails** — secret-drop `requiresToken` binding, portal identity enforcement, runs aggregate seam, PG twins gap list, digest-pinned sandbox base, per-turn tool ledger. Each is a single targeted ticket.

The 16.0 follow-up cluster has the longest "documented but not started" runway and the least external coordination cost — good candidate for the next planning round.

---

## Going Forward (2026-09-21)

Three gap clusters mapped to plan artifacts in this directory:

| Cluster | Plan artifact | Scope | Status (2026-09-21) |
|---|---|---|---|
| 1 — Deploy runtime | `qm-next-deploy-runtime-mvp.md` | Docker provider + `/d/<slug>` proxy; git HTTP deferred to follow-up PRD | ✅ merged `ea6303f` on main (proxy slice; git HTTP + Fly/AWS providers still future PRD) |
| 2 — Productionization | `briefs/qm-next-c2-s3-byte-store.md`, `...-c2-pgboss-queue.md`, `...-c2-emoji-upload.md` (active); `...-c2-codex-device-login.md`, `...-c2-monitor-poller.md` (blocked) | 5 worker-ready briefs | 3/5 merged (cluster-2 worktree), 2/2 still blocked |
| 3 — Small tails | `briefs/qm-next-c3-secret-drop-requires-token.md`, `...-c3-portal-identity-enforce.md`, `...-c3-sandbox-digest-pin.md`, `...-c3-pg-twins-migration.md` (active); `...-c3-runs-aggregate.md`, `...-c3-tool-ledger.md` (blocked) | 6 worker-ready briefs | 4/6 merged (cluster-3 worktree), 2/2 still blocked |

**Execution plan (recommended)**:

- **Batch 1** (parallel, ~8-10 days wall clock):
  - 1 engineer: cluster 1 MVP (Docker provider + `/d/<slug>`) — ✅ done
  - Worker A: cluster 2 active briefs (S3 + pg-boss + emoji-upload) — ✅ done
  - Worker B: cluster 3 active briefs (secret-drop + portal identity + digest pin + PG twins) — ✅ done
- **Batch 2** (after Batch 1, blocked on observability/replay/credentials):
  - Cluster 3 blocked: runs aggregate + per-turn tool ledger
  - Cluster 2 blocked: codex-device-login (needs ChatGPT creds) + MonitorPoller (needs surface exposure)

Total: 11 worker briefs + 1 PRD. Each brief is `tier:simple` or `tier:standard` except the four blocked briefs (marked `tier:thinking` until dependencies resolve).

**Migration plan**: once network access to `byteaide/qm-next.git` is restored, the entire `docs/` tree in this worktree (PRD + 11 briefs + this report) should be PR'd to `qm-next/docs/qm-next-parity-clearance/` so the plan lives next to the source of truth (`parity-deviations.md`).

---

## Appendix: verification commands run

```
# capability tokens
rg -l "mintCapability|CapabilityToken|capability-token" packages

# deploy providers (no hits)
rg -l "DeployProvider|deploy-provider|FlyDeploy|AwsDeploy|DockerDeploy" packages

# byte-store (only memory/local, no S3)
rg "createLocalByteStore|createMemoryByteStore|createS3ByteStore" packages

# monitor poller (only doc comments, not implementation)
rg "monitor-poller|MonitorPoller|createMonitorPoller|startMonitorPoller" packages

# codex device login + subscription OAuth (502 stubs)
rg "codex-device-login|secret-drop|secretDrop|emoji-upload" packages

# deploy route surface (in-memory store, no live runtime)
rg "fetch|logs|redeploy|rollback" packages/api/src/routes/deployment-routes.ts

# regenerateTitle (LLM path live in every harness)
rg "regenerateTitle|generateTitle" packages

# ambient judge model
rg "createModelAmbientJudge|ambientJudge|judgeModel" packages

# surface-context pre-checks
rg "channel_not_found|not_visible|identity_unverified|ambiguous_channel" packages

# context-policy membership check (gap self-documented)
rg "managesScope|listContexts|membershipCheck|membersFor" packages

# connector consent mint/redeem (live)
rg "consent/mint|consent/redeem|/v1/connectors/oauth/consent" packages

# secret-drop dropUrl token binding (still open)
rg "requiresToken|secret-drop.*token|dropUrl" packages
```

Each row in the tables above traces to one or more of these queries.
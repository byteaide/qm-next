# Phase 6 Test Impact Assessment

**Phase:** 6 — Connector OAuth lifecycle
**Branch:** `feat/connector-oauth`
**Linked ADRs:** 0009 (Connector context owns OAuth), 0016 (Connector tokens stay out of observation), 0017 (OAuth token encryption at rest — authored for this phase)
**Linked plan:** `docs/implementation-plan.md` §Phase 6
**Authored in commit:** first Phase 6 groundwork commit (ADR-0017 + this assessment)
**Started:** 2026-09-20

This document captures the test impact before the first Phase 6 PR. It follows the same template as `docs/test-impact/phase-{0..5}.md`.

## 1. Summary

Phase 6 moves the OAuth lifecycle out of `packages/api/src/routes/connector-routes.ts` into the Connector context (`@qm/connectors`). The route-local `pendingLinks` Map (KV-003), the in-process mock provider registry default, and the route-owned callback state machine are deleted from production runtime. Routes become HTTP adapters: validate callback input, normalize the provider payload, invoke a Connector operation, return/redact the result. The already-constructed durable stores (`oauth_flows`, `consent_links` — wired in `api/service.ts` since the 20.0 twin lane) become the actual backing for every flow step, making flows restart-safe and multi-instance-safe. A new Connector token vault seals `ConnectorToken` values with the AES-256-GCM envelope under the purpose-derived KEK from ADR-0017 before any durable write, decrypts only inside short-lived Connector provider calls, and emits the §6.5 observability families (`oauth_flow_total`, `oauth_token_decrypt_total`, `oauth_redaction_hit_total`).

**Groundwork PR (this branch):** ADR-0017 + this assessment. **Implementation PRs:** slices 6.1–6.7 plus §6.5 observability on `feat/connector-oauth`.

## 2. Regression basket

| Test path | Purpose | Why critical |
|---|---|---|
| `packages/connectors/tests/connectors.test.ts` | Envelope encrypt/decrypt, key derivation isolation, consent-link TTL/single-use, flow-store TTL | The crypto and store primitives Phase 6 builds on; their contracts must not drift |
| `packages/api/tests/tranche6-routes.test.ts` | Host-keyed token register/status/revoke surface | Host-keyed token operations keep working while provider-keyed routes migrate |
| `packages/model/tests/model-stores.test.ts` | Model credential store encryption (keyMaterial pattern) | Neighbor consumer of the same master secret; proves purpose derivation isolates it |
| `packages/triggers/tests/architecture.test.ts` | Package boundary assertions | Phase 6 must not introduce new cross-package imports |
| `pnpm test:architecture` | Static + contract gate incl. "rejects process-local pending OAuth maps" (Phase 6 boundary test) | The gate must flip from acknowledging KV-003 to asserting zero hits |
| `pnpm check:im` | IM isolation | Untouched area stays clean |
| `packages/runs/tests/observability.test.ts` | Metric registry semantics | §6.5 families extend, never mutate, the registry contract |

## 3. Tests expected to break

| Test path | Why it breaks | Resolution | Replacement test |
|---|---|---|---|
| `packages/api/tests/tranche7-routes.test.ts` (OAuth loop cases) | Mock mint→redeem→start→callback loop is driven through the route-local `pendingLinks` Map; the Map is deleted | Rewrite | `packages/api/tests/connector-routes-adapter.test.ts` (same loop through the Connector context + durable stores) |
| `packages/connectors/tests/connectors.test.ts` (mock-registry-dependent cases, if any) | Provider registry moves from route default to deployment config | Rewrite | same file, registry injected by test |

## 4. Deletion justifications

| Original test | Justification | Alternative coverage |
|---|---|---|
| (none — all breakages are rewrites in place) | Route surface paths and status/revoke semantics survive; only the backing state location changes | `packages/api/tests/connector-routes-adapter.test.ts` |

## 5. New test inventory

| Test path | Layer | Targets ADR | Memory mode | PG mode | Architecture gate |
|---|---|---|---|---|---|
| `packages/connectors/tests/connector-oauth-flow.test.ts` | contract | 0009 | yes | yes (PG twin) | no |
| `packages/connectors/tests/token-vault.test.ts` | contract | 0016, 0017 | yes | n/a | yes (no plaintext-at-rest assertions) |
| `packages/connectors/tests/token-vault-pg.test.ts` | contract | 0017 | n/a | yes | no |
| `packages/api/tests/connector-routes-adapter.test.ts` | integration | 0009 | yes | n/a | yes (no route-local OAuth state) |
| `packages/runs/tests/observability-phase-6.test.ts` | unit | 0009, 0016 | yes | n/a | no |
| `packages/connectors/tests/token-vault-failclosed.test.ts` | unit | 0017 | yes | n/a | yes (fail-closed construction) |

Coverage notes:

- `connector-oauth-flow.test.ts` asserts the plan's Phase 6 gate cases: start→callback completes through the Connector-owned flow; restart between start and callback completes; callback routed to a second simulated instance (fresh route deps, same durable stores) completes; duplicate callback creates no duplicate tokens or accounts; expired consent cannot be exchanged; used consent link cannot be replayed.
- `token-vault*.test.ts` asserts: sealed ciphertext at rest (no token-shaped plaintext in the backing store), decrypt restricted to vault methods, decrypt audit record payload-free, §6.5 counters tick, wrong-KEK decrypt fails closed.
- `connector-routes-adapter.test.ts` asserts the adapter contract: route modules hold no flow state (no module-level Maps), unknown provider returns the structured `not_found`, token values never appear in any route response.

## 6. Coverage deltas

| Layer | Before phase | Target after phase | Floor | Actual at PR time |
|---|---|---|---|---|
| `packages/connectors` lines | ≥ 90% | ≥ 95% (new vault + flow service) | 90% (gate-enforcement §3) | measured at PR |
| `packages/connectors` branches | n/a | ≥ 90% | 85% | measured at PR |
| `packages/api` connector-route lines | ≥ 90% | ≥ 90% | 90% | measured at PR |

## 7. Memory/Postgres contract parity strategy

- **Shared contract suite**: `connector-oauth-flow.test.ts` (memory `DurableMap`) mirrors `token-vault-pg.test.ts` / PG-backed flow cases case-for-case on the same logical operation sequence.
- **Random-seed replay**: not introduced in Phase 6; flow state transitions are deterministic on inputs. The Phase 0 fake-clock fixture drives TTL/expiry assertions.
- **Deterministic-clock strategy**: stores accept `now` injection (existing pattern in `oauth-flow-store` / `consent-link`); tests inject a stepped clock.
- **Cross-implementation runner**: both legs run under `pnpm test`; PG legs env-gated on `QM_NEXT_PG_URL` under `pnpm test:pg` (same pattern as `intake-store-pg.test.ts`).
- **PG-mode parity failure handling**: memory-green/PG-red blocks the phase gate (plan: gate must pass in both modes).

## 8. Test data lifecycle

- **New fixtures introduced**: synthetic provider specs (`id: 'p6-mock'`) and token-shaped test strings; no external data.
- **Existing fixtures modified**: tranche6/tranche7 route tests inject their registries/stores instead of relying on route defaults.
- **Test data reset strategy**: per-test fresh stores; PG tests key on `p6-` prefixed identifiers and close pools in `t.after`.
- **Cross-test isolation**: memory stores are per-instance; PG assertions key on unique per-test identifiers (existing conventions).

## 9. Performance budget

| Operation | Memory mode SLO | PG mode SLO | Measurement |
|---|---|---|---|
| OAuth callback to durable exchange | < 5 ms p95 | < 15 ms p95 | adapter→Connector op→vault seal→store put, timed in flow tests |
| Token seal (encrypt + store put) | < 2 ms p95 | < 10 ms p95 | vault write path |
| Token open (store get + decrypt + audit) | < 2 ms p95 | < 10 ms p95 | vault read path |
| Flow start (durable) | < 2 ms p95 | < 10 ms p95 | `oauth_flows` store put |

A regression beyond the SLO blocks the PR; the phase gate ratifies these numbers.

## 10. Open questions

| Question | Owner | Due |
|---|---|---|
| Where does the consent mint surface live after the mock registry leaves the route layer — behind the existing `oauth-consent` audience route as an adapter, or behind an admin surface? Plan slice 2 keeps routes as adapters; the mint adapter stays unless review moves it | phase owner | before phase gate sign-off |
| Re-encryption sweep: admin tool in this phase or deferred to the rotation runbook's first real use? ADR-0017 requires it for online rotation completion; if deferred, rotation stays "append + restart + sweep pending" and the runbook marks the sweep step as manual | phase owner | before phase gate sign-off |

## 11. Changelog

| Date | Change | Author |
|---|---|---|
| 2026-09-20 | Initial submission | phase-6 groundwork session |

## 12. Gate self-check

Before the Phase Gate is signed off, confirm:

- [ ] Regression basket is green in memory and PG modes
- [ ] All "expected to break" tests are resolved (rewritten per §3)
- [ ] No deletions in §4 (none)
- [ ] Coverage on changed code is at or above the floor
- [ ] Memory/PG contract parity strategy is verified by automated tests
- [ ] Performance budgets are met or have an open waiver
- [ ] All open questions in §10 are resolved
- [ ] Architecture gate has run on the phase branch (KV-003 entries removed; zero pending-OAuth-Map hits asserted)
- [ ] Linked ADRs are referenced in test names or descriptions where applicable (ADR-0009, ADR-0016, ADR-0017)

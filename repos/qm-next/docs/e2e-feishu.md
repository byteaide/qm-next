# Real-device Feishu e2e (17.1)

The three remaining manual legs before the `m3` tag: **card click**,
**ambient in a real channel**, and **cron fire → real IM delivery**. All
three run against the full M3 stack in one boot:
`profiles/im-e2e.yml` (api + im-bridge with ambient wiring + triggers
scheduler + feishu WS provider), driven by `scripts/boot-im-e2e.ts`.

Automated coverage already proves the logic (im-bridge ambient gating,
keyword judge, TriggersService mount, approval restart survival,
claimSlot idempotency — `pnpm test:pg` 245/245). This pass proves the
**real provider round-trip**: Feishu WS events in, cards out, clicks
back, deliveries landing in a real chat.

## Prerequisites

- Feishu open-platform app with **long connection** events enabled
  (websocket transport, no public webhook needed) and **card callbacks
  over the long connection** (console setting — required for leg 1).
- The bot is a member of a test group chat (the e2e channel).
- aidevops secrets `FEISHU_APP_ID` / `FEISHU_APP_SECRET` present
  (`aidevops secret list`). `FEISHU_VERIFICATION_TOKEN` /
  `FEISHU_ENCRYPT_KEY` optional.

## Boot

```bash
cd repos/qm-next

# leg 3 only: pick the cron destination chat first (see chat listing below)
E2E_CRON_CHAT=oc_xxx aidevops secret run pnpm exec tsx scripts/boot-im-e2e.ts
```

The boot prints the API health, ambient state, the bot's group chats
(useful when you don't know the `oc_…` id — re-run with it), the cron
schedule, and one runbook line per leg.

Environment knobs:

| Variable | Default | Meaning |
|---|---|---|
| `E2E_AMBIENT_CONTAINER` | *(unset — ambient off)* | Comma-separated containers (`feishu:oc_…`) with ambient enabled |
| `E2E_AMBIENT_KEYWORD` | `*` | Stub judge keyword (`*` = engage every unaddressed message) |
| `E2E_CRON_CHAT` | *(unset — cron off)* | Destination chat for the e2e cron |
| `E2E_CRON_DELAY_MS` | `15000` | One-shot fire delay from boot |
| `E2E_CRON_EVERY_MS` | *(unset — one-shot)* | Set (≥60000) for a repeating cron instead |
| `E2E_CRON_ACTION` | `!run e2e cron fire` | Stored task every fire submits (`!run` skips the cron preamble) |

Stop with Ctrl-C; SIGTERM unmounts the whole profile tree.

## Leg 1 — card click

1. In the test chat, **@机器人** with `!approval`.
2. Expect the *Approval needed* card in-thread (command `e2e-approval`).
3. Click **Approve** → expect the follow-up echo `e2e echo: Approve: e2e-approval`.
4. Repeat once and click **Reject** → expect `e2e echo: Reject: e2e-approval`.
5. Click a third time on the first card → nothing (double-click dedup).

Pass: every click answers in-thread; duplicate clicks are silent.

## Leg 2 — ambient

1. Boot with `E2E_AMBIENT_CONTAINER=feishu:<chatId>` for the test chat.
2. From a **human** account, send a message that does **not** @mention the
   bot (with the default `*` judge, anything engages; set
   `E2E_AMBIENT_KEYWORD=deploy` to require the word).
3. Expect exactly **one** bot reply — the ambient turn (no separate echo).
   A message in a thread gets the ambient reply in the same thread.

Pass: unaddressed chatter produces the single ambient reply; @mentions
and DMs still take the normal echo path (no double replies).

## Leg 3 — cron fire → IM delivery

1. Boot with `E2E_CRON_CHAT=<chatId>`.
2. One-shot default: ~15s after boot the cron fires, the turn runs, and
   the reply `e2e echo: !run e2e cron fire` lands in the chat.
3. Repeating variant (`E2E_CRON_EVERY_MS=60000`): a delivery every minute
   until Ctrl-C.

Pass: deliveries arrive with no human interaction; the boot log shows no
fire errors (`triggers: fire failed …` would print).

## Evidence checklist (17.1 sign-off)

- [ ] Leg 1: card → approve → reply; reject → reply; duplicate click silent
- [ ] Leg 2: one ambient reply per unaddressed message; mention/DM echo unaffected
- [ ] Leg 3: one-shot delivery observed in the real chat
- [ ] Shutdown clean (Ctrl-C unmounts without stack traces)

Then tick 17.1 in `todo/tasks/tasks-qm-next.md` and proceed to 17.2
(tag `m3`).

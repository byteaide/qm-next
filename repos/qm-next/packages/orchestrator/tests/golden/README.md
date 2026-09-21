# Soul-layer golden fixtures (ADR-0018)

Byte-identical qm baselines for the three-mode protocol frames, rendered by
qm's own renderer (`applyPromptVars` over qm's `src/resolution/protocols/*.md`).
The qm-next frame composer must reproduce these outputs; the only allowed
divergence is at the platform-vocabulary replacement points pre-registered as
**deviation #55** in `docs/parity-deviations.md`.

## Matrix (12 files)

`<mode>-<soul>-<surface>.md`

- mode: `autonomous` | `conversation` | `fallback` (qm orchestrator mode selection)
- soul: `soul` (org + distinct scope soul composed with qm's guard wording) | `nosoul` (empty resolution prompt; the `\n\n\n\n` junction run is qm-exact — the composer reproduces it via unconditional `\n\n` joins)
- surface: `im` (IM surface, `slack`/`imChannel` = true) | `web`

Fallback fixtures with the same soul flag are byte-identical across surfaces
by design: the fallback frame takes no surface variables.

## Fixed inputs

| var | value | note |
|---|---|---|
| `botName` | `QM` | branding default (no stored branding) |
| `orgName` | `Acme Inc` | |
| `userName` / `userEmail` | `Ada` / `ada@acme.com` | conversation mode only |
| `surfaceTool` | `surface` | pi-tools default tool name (runtime variable, not a #55 point) |
| `botHandle` | absent | conditional dropped |
| security policy | `auto` posture, rendered by qm `renderSecurityPolicyPrompt` | byte-equivalent in qm-next (`packages/security`) |

Soul block (composed exactly like qm `resolution-service.ts` / qm-next
`SoulStore.getSoul`): org soul, then the lower-scope guard line, then the
scope soul, then the authoritative-policy line.

## Deviation #55 replacement points (qm → qm-next)

1. `shared-core.md` line 3: `{{#if botHandle}} (@{{botHandle}} in Slack){{/if}}` → `(@{{botHandle}} in {{imLabel}})`
2. `shared-core.md` files paragraph: "A file someone POSTED in Slack earlier" → "A file someone POSTED in {{imLabel}} earlier"
3. `mode-autonomous.md` closing block: `{{#if slack}}You're on Slack: …{{/if}}` → `{{#if imChannel}}You're on {{imLabel}}: …{{/if}}`
4. `mode-conversation.md` Slack bullet: `{{#if slack}}- This is Slack: …{{/if}}` → `{{#if imChannel}}- This is {{imLabel}}: …{{/if}}`
5. `mode-conversation.md` surface label variable value: qm hardcodes `surfaceLabel: "Slack"` for IM turns ("over Slack" in these fixtures); qm-next injects the provider display name via `imLabel`.

`{{#if web}}` and "the {{botName}} web app" are platform-neutral and unchanged.

## Regeneration

```
ln -s <aa-checkout>/repos/qm repos/qm                   # session-local; repos/* is gitignored
node --import tsx/esm scripts/generate-soul-golden.ts  # from repos/qm-next
```

Requires the sibling `repos/qm` upstream checkout (read-only reference).

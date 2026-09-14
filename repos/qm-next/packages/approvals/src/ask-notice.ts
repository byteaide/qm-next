/**
 * Keychain-ask resolution notices (qm src/triggers/keychain-ask.ts):
 * when an ask resolves — approved, declined, or expired — the requester's
 * personal agent hears the outcome and resumes (or redirects) the task.
 * The composer and the sweep are pure; the fire action is injected so the
 * bridge runs it as a personal turn in the requester's DM.
 */
import type { KeychainAsk } from '@qm/types'

const CAPABILITY_HEADER = 'x-agent-capability'

function keychainUseCommand(ref: { grant: string }): string {
  return (
    `curl -fsS -X POST "$AGENT_API_URL/v1/keychain/use" -H "${CAPABILITY_HEADER}: $AGENT_API_TOKEN" ` +
    `-H 'content-type: application/json' -d '{"grant":"${ref.grant}"}' -o /tmp/keychain.env && . /tmp/keychain.env`
  )
}

export interface AskResolutionGrant {
  mode?: 'once' | 'standing'
  purpose?: string
}

export function askResolutionInput(ask: KeychainAsk, grant?: AskResolutionGrant): string {
  if (ask.status === 'approved') {
    const once = grant?.mode !== 'standing'
    return (
      `Keychain ask \`${ask.id}\` was approved by its owner (${ask.ownerId}): ${once ? 'one-time' : 'standing'} ` +
      `grant \`${ask.grantId}\` for this conversation (the owner's consent, verbatim: "${grant?.purpose ?? ask.purpose}" — act within it; ` +
      `originally asked for: "${ask.purpose}"). Tell the requester and resume ` +
      `the task it was for — load the credential with ` +
      `\`${keychainUseCommand({ grant: String(ask.grantId) })}\` ` +
      `and run the task in that same shell${once ? ' (the grant is single-use)' : ''}.`
    )
  }
  if (ask.status === 'declined') {
    return (
      `Keychain ask \`${ask.id}\` (purpose: "${ask.purpose}") was declined by its owner (${ask.ownerId})` +
      `${ask.note ? ` — "${ask.note}"` : ''}. Tell the requester, and offer the alternatives: they can run the ` +
      `service's own login here themselves, or register their own credential in their DM with me.`
    )
  }
  return (
    `Keychain ask \`${ask.id}\` to ${ask.ownerId} (purpose: "${ask.purpose}") expired without an answer. ` +
    `Tell the requester, and offer the alternatives: re-send the ask, run the service's own login here ` +
    `themselves, or register their own credential in their DM with me.`
  )
}

export function askFallbackText(ask: KeychainAsk): string {
  let what = 'expired without an answer'
  if (ask.status === 'approved') what = 'was approved — the grant is active for this conversation'
  else if (ask.status === 'declined') what = `was declined${ask.note ? ` ("${ask.note}")` : ''}`
  return `Keychain ask \`${ask.id}\` (purpose: "${ask.purpose}") ${what}, but I couldn't resume the task automatically. Mention me here to pick it up.`
}

/** Structural slice of the keychain the sweep needs — no import weight. */
export interface AskSweepKeychain {
  unnotifiedResolvedAsks(now: number): Promise<KeychainAsk[]>
  markAskNotified(id: string): Promise<void>
}

export interface AskExpirySweepDeps {
  keychain: AskSweepKeychain
  fire: (ask: KeychainAsk) => Promise<unknown>
}

/** Poll resolved-but-unnotified asks, fire each once, then mark notified. */
export function createAskExpirySweep(deps: AskExpirySweepDeps): (now: number) => Promise<void> {
  return async (now) => {
    for (const ask of await deps.keychain.unnotifiedResolvedAsks(now)) {
      try {
        await deps.fire(ask)
        await deps.keychain.markAskNotified(ask.id)
      } catch {
        // qm swallows too: the sweep retries on the next tick.
      }
    }
  }
}

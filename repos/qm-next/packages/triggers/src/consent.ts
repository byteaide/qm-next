/**
 * Recipient consent (qm src/triggers/trigger-store.ts + consent-notice.ts):
 * a standing cron delivering into another person's DM waits for that
 * person's accept before its deliveries go out. The helpers are pure; the
 * notice sink is injected so routes adapt the delivery enqueue.
 */
import type { Destination, RecipientConsent } from '@qm/types'

export function consentRequiredRecipient(input: {
  owner: string
  standing: boolean
  destination?: Destination
}): string | undefined {
  if (!input.standing) return undefined
  const d = input.destination
  return d?.type === 'principal' && d.target !== input.owner ? d.target : undefined
}

export function recipientConsentSatisfied(
  input: { recipientConsent?: RecipientConsent },
  requiredRecipient?: string,
): boolean {
  if (!requiredRecipient) return input.recipientConsent === undefined || input.recipientConsent.status === 'accepted'
  return input.recipientConsent?.status === 'accepted' && input.recipientConsent.recipientId === requiredRecipient
}

export function decideRecipientConsent(
  current: RecipientConsent | undefined,
  actorId: string,
  decision: 'accept' | 'decline',
  now: number,
): { ok: true; consent: RecipientConsent } | { ok: false; reason: 'no_consent' | 'not_recipient' } {
  if (!current) return { ok: false, reason: 'no_consent' }
  if (current.recipientId !== actorId) return { ok: false, reason: 'not_recipient' }
  return { ok: true, consent: { ...current, status: decision === 'accept' ? 'accepted' : 'declined', decidedAt: now } }
}

export const CONSENT_AWAITING_NOTE = "awaiting the recipient's consent — delivery skipped"
export const CONSENT_DECLINED_NOTE = 'recipient turned this delivery off — skipped'

export function consentSkipNote(consent: RecipientConsent): string {
  return consent.status === 'declined' ? CONSENT_DECLINED_NOTE : CONSENT_AWAITING_NOTE
}

export function composeConsentNotice(args: { triggerId: string; what: string; ownerName?: string }): string {
  const who = args.ownerName ?? 'A teammate'
  return (
    `${who} set up ${args.what} to be delivered to you. It won't start until you accept.\n` +
    `Tell me "accept" to start receiving it, or "decline" to keep it off — you can stop it anytime. (ref: ${args.triggerId})`
  )
}

/** Sink adapter over the delivery queue: destination + text + idempotency. */
export type ConsentNoticeEnqueue = (input: {
  destination: Destination
  text: string
  idempotencyKey: string
}) => Promise<unknown>

export async function sendConsentNotice(
  enqueue: ConsentNoticeEnqueue,
  args: {
    triggerId: string
    recipientId: string
    ownerId: string
    ownerName?: string
    what: string
    /** Resolvable destination for the recipient's DM (route-resolved). */
    destination?: Destination
  },
): Promise<void> {
  if (!args.destination) return
  await enqueue({
    destination: args.destination,
    text: composeConsentNotice(args),
    idempotencyKey: `consent-notice:${args.triggerId}`,
  })
}

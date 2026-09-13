import type {
  Harness,
  HarnessAdapterProfile,
  HarnessCompactInput,
  HarnessDetectInput,
  HarnessDetectResult,
  HarnessModelUtilities,
  HarnessSecurityScreenInput,
  HarnessToolPresentation,
  HarnessTurnController,
  HarnessTurnInput,
  HarnessTurnResult,
} from '@qm/types'

export function envelopeWithoutMessages(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload
  return Object.fromEntries(Object.entries(payload as Record<string, unknown>).filter(([k]) => k !== 'messages'))
}

export type HarnessImplementation = HarnessTurnController & HarnessModelUtilities

export type {
  Harness,
  HarnessAdapterProfile,
  HarnessCompactInput,
  HarnessDetectInput,
  HarnessDetectResult,
  HarnessModelUtilities,
  HarnessSecurityScreenInput,
  HarnessToolPresentation,
  HarnessTurnController,
  HarnessTurnInput,
  HarnessTurnResult,
}

export function defineHarness(
  profile: HarnessAdapterProfile,
  implementation: HarnessImplementation,
  tools: HarnessToolPresentation = { name: (coreName) => coreName },
): Harness {
  const turns: HarnessTurnController = {
    runTurn: implementation.runTurn.bind(implementation),
    ...(implementation.close ? { close: implementation.close.bind(implementation) } : {}),
    ...(implementation.resetSession ? { resetSession: implementation.resetSession.bind(implementation) } : {}),
  }
  const models: HarnessModelUtilities = {
    ...(implementation.shouldRespond ? { shouldRespond: implementation.shouldRespond.bind(implementation) } : {}),
    ...(implementation.compactHistory ? { compactHistory: implementation.compactHistory.bind(implementation) } : {}),
    ...(implementation.contextTokenBudget
      ? { contextTokenBudget: implementation.contextTokenBudget.bind(implementation) }
      : {}),
    ...(implementation.oneShot ? { oneShot: implementation.oneShot.bind(implementation) } : {}),
    ...(implementation.judge ? { judge: implementation.judge.bind(implementation) } : {}),
    ...(implementation.screenSecurity ? { screenSecurity: implementation.screenSecurity.bind(implementation) } : {}),
    ...(implementation.pickAckEmoji ? { pickAckEmoji: implementation.pickAckEmoji.bind(implementation) } : {}),
    ...(implementation.generateTitle ? { generateTitle: implementation.generateTitle.bind(implementation) } : {}),
    ...(implementation.summarizeApproval
      ? { summarizeApproval: implementation.summarizeApproval.bind(implementation) }
      : {}),
  }
  return { profile, turns, models, tools }
}

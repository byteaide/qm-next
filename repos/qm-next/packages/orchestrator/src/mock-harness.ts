/**
 * Mock harness: scriptable Harness implementation for tests and the M1
 * end-to-end path. Each runTurn consumes the next step from the script (or
 * the default reply), emits the reply as an assistant entry through the
 * provided emitter, and counts model calls.
 */
import type {
  Harness,
  HarnessAdapterProfile,
  HarnessCompactInput,
  HarnessDetectInput,
  HarnessDetectResult,
  HarnessTurnInput,
  HarnessTurnResult,
} from '@qm/types'

export type MockTurnStep = HarnessTurnResult | Error

export interface MockHarnessOptions {
  defaultReply?: string
  /** Consumed in order; an Error step is thrown to the orchestrator. */
  script?: MockTurnStep[]
  detect?: (input: HarnessDetectInput) => Promise<HarnessDetectResult>
  /** Delta chunks streamed through `onDelta` before every reply. */
  deltas?: readonly string[]
  /** Wall-clock delay before every runTurn resolves (ack-timing tests). */
  turnDelayMs?: number
}

export const mockProfile: HarnessAdapterProfile = {
  id: 'mock',
  controlTransport: 'mock',
  toolTransport: 'mock',
  transcriptFormat: 'plaintext',
  capabilities: new Set(),
}

export function createMockHarness(opts: MockHarnessOptions = {}): MockHarness {
  const script = [...(opts.script ?? [])]
  const calls: HarnessTurnInput[] = []
  let modelCalls = 0
  const harness: MockHarness = {
    profile: { ...mockProfile },
    calls,
    modelCallCount: () => modelCalls,
    turns: {
      async runTurn(input) {
        calls.push(input)
        modelCalls += 1
        input.recordModelCall({ model: 'mock-1', inputTokens: 1, entryCount: input.history.length })
        if (opts.turnDelayMs) await new Promise((resolve) => setTimeout(resolve, opts.turnDelayMs))
        const next = script.shift()
        if (next instanceof Error) throw next
        const result: HarnessTurnResult = next ?? {
          reply: opts.defaultReply ?? `echo: ${input.input}`,
        }
        for (const chunk of opts.deltas ?? []) {
          await input.onDelta?.(chunk)
        }
        if (!result.silent) {
          await input.emit({ type: 'assistant', payload: { text: result.reply }, scopeLabel: input.scopeLabel })
        }
        return result
      },
    },
    models: {
      ...(opts.detect
        ? {
            shouldRespond: (input: HarnessDetectInput) => opts.detect!(input),
          }
        : {}),
      async compactHistory(input: HarnessCompactInput) {
        return input.history.map((e) => JSON.stringify(e.payload)).join('\n')
      },
    },
    tools: { name: (coreName) => coreName },
  }
  return harness
}

export interface MockHarness extends Harness {
  calls: HarnessTurnInput[]
  modelCallCount(): number
}

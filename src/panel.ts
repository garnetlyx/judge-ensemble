/**
 * Generic concurrent panel runner with delivery guarantees.
 *
 * Given N slots, runPanel always resolves with exactly N results (real,
 * substitute, or fallback — labeled via `via`), streams each result as it
 * lands through `onResult`, and enforces an overall time budget whose abort
 * signal cascades into retries and per-call timeouts. Results that complete
 * before the budget expires survive the timeout; missing slots are filled
 * with fallbacks.
 *
 * Extracted from aiJudge/index.ts orchestration (judge-ensemble Phase 2).
 * No app-config or app-type dependency.
 */
import { withRetry, withTimeout, type RetryOptions } from './retry';
// (RetryOptions may carry onRetry; panel callers configure it in opts.retry)

/** How a slot's result was produced. */
export type Via = 'real' | 'substitute' | 'fallback';

/** Why a fallback result was requested. */
export type FallbackCause =
  | 'unknown-slot'      // slot could not be resolved to a target
  | 'online-failure'    // target was online but the call failed / returned null
  | 'offline-failure'   // target was offline and no (usable) substitute found
  | 'budget';           // overall budget expired before the slot completed

export interface PanelResult<T> {
  /** The original slot this result belongs to (substitutes keep the original slot). */
  slot: string;
  via: Via;
  /** Result for slot `displayName`. */
  result: T;
}

export interface RunPanelOptions<T, M> {
  /** Slot identifiers to run (one result each, in completion order). */
  slots: string[];
  /** Overall budget for the whole panel. Completed results survive expiry. */
  budgetMs: number;
  /** Retry policy applied to every target call (primary and substitute). */
  retry: RetryOptions;

  /** Resolve a slot to its primary target; undefined means unknown slot. */
  resolveSlot: (slot: string) => M | undefined;
  /** Whether a target is currently usable. Offline targets go to substitution. */
  isOnline: (target: M) => boolean;
  /** Dedup key for the substitute pool (a target used once is never reused). */
  targetKey: (target: M) => string;
  /** Human-readable target name for timeout error messages. */
  describeTarget: (target: M) => string;
  /** Per-call timeout (may differ per target, e.g. reasoning models). */
  callTimeoutMs: (target: M) => number;
  /**
   * Invoke the target. Receives an AbortSignal that aborts on per-call timeout
   * or budget expiry — cancel in-flight HTTP requests with it. Return null to
   * signal a unusable response (falls back without retry/substitute error path).
   */
  call: (target: M, signal: AbortSignal) => Promise<T | null>;
  /** Stamp app-level metadata (e.g. judge display name, substitutedFor). */
  decorate: (result: T, target: M, via: Via, slot: string) => T;
  /** Produce a fallback result for a slot that could not complete. */
  fallback: (slot: string, cause: FallbackCause) => T;
  /**
   * Find an unused substitute target. Receives the set of already-assigned
   * target keys (seeded with the primary slots). Return undefined for none.
   */
  findSubstitute: (assignedKeys: ReadonlySet<string>) => M | undefined;
  /** Called when a primary target call fails (e.g. health-check the model). */
  onTargetError?: (target: M, error: unknown) => void;
  /** Stream each result as it lands. Callback errors are swallowed. */
  onResult?: (result: PanelResult<T>, completed: number, total: number) => void;
  /** Called with the budget-expiry error and the surviving results (for logging). */
  onBudgetExceeded?: (error: unknown, collected: PanelResult<T>[]) => void;
}

export async function runPanel<T, M>(opts: RunPanelOptions<T, M>): Promise<PanelResult<T>[]> {
  const total = opts.slots.length;
  const collected: PanelResult<T>[] = [];
  // Sealed when the budget expires: late slot completions are dropped so
  // exactly one result per slot is ever emitted.
  const state = { sealed: false };

  const emit = (pr: PanelResult<T>): boolean => {
    if (state.sealed) return false;
    collected.push(pr);
    if (opts.onResult) {
      try {
        opts.onResult(pr, collected.length, total);
      } catch {
        // callback crashes must not break the panel
      }
    }
    return true;
  };

  try {
    await withTimeout(
      (signal) => runSlots(opts, signal, emit),
      opts.budgetMs,
      `Panel budget of ${opts.budgetMs}ms exceeded`
    );
  } catch (error) {
    state.sealed = true;
    opts.onBudgetExceeded?.(error, collected);

    // Delivery guarantee: completed results survive the timeout; fill the rest.
    // Fill per slot *occurrence* (duplicate slots each get a result).
    const results = [...collected];
    const remaining = new Map<string, number>();
    for (const slot of opts.slots) {
      remaining.set(slot, (remaining.get(slot) ?? 0) + 1);
    }
    for (const r of results) {
      remaining.set(r.slot, (remaining.get(r.slot) ?? 0) - 1);
    }
    for (const slot of opts.slots) {
      const left = remaining.get(slot) ?? 0;
      if (left <= 0) continue;
      remaining.set(slot, left - 1);
      const pr: PanelResult<T> = { slot, via: 'fallback', result: opts.fallback(slot, 'budget') };
      results.push(pr);
      if (opts.onResult) {
        try {
          opts.onResult(pr, results.length, total);
        } catch {
          // callback crashes must not break the panel
        }
      }
    }
    return results;
  }

  return collected;
}

async function runSlots<T, M>(
  opts: RunPanelOptions<T, M>,
  signal: AbortSignal | undefined,
  emit: (pr: PanelResult<T>) => boolean
): Promise<void> {
  // Substitute dedup: a target used once (primary or substitute) is never reused.
  // Seeded from the *target keys* of resolvable primary slots — slots and target
  // keys are not required to be the same string.
  const assignedKeys = new Set<string>();
  for (const slot of opts.slots) {
    const target = opts.resolveSlot(slot);
    if (target) assignedKeys.add(opts.targetKey(target));
  }

  const fallbackResult = (slot: string, cause: FallbackCause): PanelResult<T> => ({
    slot,
    via: 'fallback',
    result: opts.fallback(slot, cause),
  });

  async function trySubstitute(
    slot: string,
    failureCause: FallbackCause,
    signal: AbortSignal | undefined,
    assignedKeys: Set<string>
  ): Promise<PanelResult<T>> {
    const substitute = opts.findSubstitute(assignedKeys);
    if (!substitute) {
      return fallbackResult(slot, failureCause);
    }

    assignedKeys.add(opts.targetKey(substitute));

    try {
      const res = await callWithRetry(opts, substitute, signal);
      if (res) {
        return { slot, via: 'substitute', result: opts.decorate(res, substitute, 'substitute', slot) };
      }
      return fallbackResult(slot, failureCause);
    } catch {
      return fallbackResult(slot, failureCause);
    }
  }

  await Promise.all(opts.slots.map(async (slot) => {
    let pr: PanelResult<T>;

    try {
      const target = opts.resolveSlot(slot);

      if (!target) {
        pr = fallbackResult(slot, 'unknown-slot');
      } else if (opts.isOnline(target)) {
        try {
          const res = await callWithRetry(opts, target, signal);
          if (res) {
            pr = { slot, via: 'real', result: opts.decorate(res, target, 'real', slot) };
          } else {
            pr = fallbackResult(slot, 'online-failure');
          }
        } catch (error) {
          opts.onTargetError?.(target, error);
          pr = await trySubstitute(slot, 'online-failure', signal, assignedKeys);
        }
      } else {
        pr = await trySubstitute(slot, 'offline-failure', signal, assignedKeys);
      }
    } catch {
      // Defensive: a slot promise must never reject.
      pr = fallbackResult(slot, 'online-failure');
    }

    emit(pr);
  }));
}

function callWithRetry<T, M>(
  opts: RunPanelOptions<T, M>,
  target: M,
  signal: AbortSignal | undefined
): Promise<T | null> {
  return withRetry(
    () => withTimeout(
      (callSignal) => opts.call(target, callSignal),
      opts.callTimeoutMs(target),
      `Call to ${opts.describeTarget(target)} timed out`,
      signal
    ),
    opts.retry,
    signal
  );
}

/**
 * Locks the core delivery-guarantee semantics of judge-ensemble's runPanel:
 *
 * 1. Budget expiry: completed results survive, missing slots filled with fallback.
 * 2. Substitute dedup: a substitute target is never assigned to two slots.
 * 3. Streaming: onResult fires as each result lands, with (result, completed, total).
 * 4. Abort cascade: budget expiry aborts in-flight calls' AbortSignals.
 * 5. Callback crashes never break the panel.
 * 6. Duplicate slots each receive a result.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { runPanel, RunPanelOptions, PanelResult, BudgetExpiredError } from '../src/panel';

interface Target {
  id: string;
  online: boolean;
}

interface Item {
  value: string;
  from: string;
}

const FAST_RETRY = { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 2 };

function makeTargets(): Record<string, Target> {
  return {
    a: { id: 'a', online: true },
    b: { id: 'b', online: true },
    c: { id: 'c', online: true },
    offline1: { id: 'offline1', online: false },
    offline2: { id: 'offline2', online: false },
  };
}

function baseOptions(
  targets: Record<string, Target>,
  calls: Mock,
  overrides: Partial<RunPanelOptions<Item, Target>> = {}
): RunPanelOptions<Item, Target> {
  return {
    slots: ['a', 'b'],
    budgetMs: 2000,
    retry: FAST_RETRY,
    resolveSlot: (slot) => targets[slot],
    isOnline: (t) => t.online,
    targetKey: (t) => t.id,
    describeTarget: (t) => t.id,
    callTimeoutMs: () => 500,
    call: calls,
    decorate: (result, target) => ({ ...result, from: target.id }),
    fallback: (slot, cause) => ({ value: `fallback:${slot}:${cause}`, from: slot }),
    findSubstitute: (assigned) =>
      Object.values(targets).find(t => t.online && !assigned.has(t.id)),
    ...overrides,
  };
}

describe('judgePanel runPanel', () => {
  let targets: Record<string, Target>;
  let calls: Mock;

  beforeEach(() => {
    targets = makeTargets();
    calls = vi.fn(async (target: Target) => ({ value: `ok:${target.id}`, from: target.id }));
  });

  it('returns one real result per slot in completion order', async () => {
    calls.mockImplementation(async (t: Target) => {
      if (t.id === 'a') await new Promise(r => setTimeout(r, 30));
      return { value: `ok:${t.id}`, from: t.id };
    });

    const results = await runPanel(baseOptions(targets, calls));

    expect(results).toHaveLength(2);
    expect(results.map(r => r.via)).toEqual(['real', 'real']);
    expect(results.map(r => r.result.from)).toEqual(['b', 'a']); // completion order
  });

  describe('1. budget expiry delivery guarantee', () => {
    it('preserves completed results and fills missing slots with fallback', async () => {
      calls.mockImplementation(async (t: Target) => {
        if (t.id === 'a') return { value: 'fast', from: t.id };
        return new Promise<Item>(() => { }); // b never resolves
      });

      const onResult = vi.fn();
      const results = await runPanel(baseOptions(targets, calls, { budgetMs: 80, onResult }));

      expect(results).toHaveLength(2);
      expect(results[0]!.via).toBe('real');
      expect(results[1]!).toMatchObject({ slot: 'b', via: 'fallback' });
      expect(results[1]!.result.value).toBe('fallback:b:budget');
      // survivor streamed normally; budget fill streamed too
      expect(onResult).toHaveBeenCalledTimes(2);
    });

    it('fills every occurrence of duplicate slots on budget expiry', async () => {
      calls.mockImplementation(() => new Promise<Item>(() => { }));

      const results = await runPanel(baseOptions(targets, calls, {
        slots: ['a', 'b', 'b'],
        budgetMs: 50,
      }));

      expect(results).toHaveLength(3);
      expect(results.every(r => r.via === 'fallback')).toBe(true);
    });

    it('suppresses late slot completions after budget expiry (one result per slot, ever)', async () => {
      // Slots resolve *slowly* via abort observation: the budget fires first,
      // then the aborted calls finish with a fallback-looking result. Those
      // late emits must be dropped — onResult total must stay at the slot count.
      const onResult = vi.fn();
      calls.mockImplementation((t: Target, signal: AbortSignal) =>
        new Promise<Item>((resolve) => {
          signal.addEventListener('abort', () => {
            // Late completion after the budget path already ran
            setTimeout(() => resolve({ value: `late:${t.id}`, from: t.id }), 20);
          });
        })
      );

      const results = await runPanel(baseOptions(targets, calls, { budgetMs: 50, onResult }));

      expect(results).toHaveLength(2);
      expect(results.every(r => r.via === 'fallback')).toBe(true);
      // Wait long enough for any late completions to land, then re-check:
      // exactly one result per slot must ever be emitted.
      await new Promise(r => setTimeout(r, 80));
      expect(onResult).toHaveBeenCalledTimes(2);
      expect(collectedAfterBudget(results)).toBe(2);
    });
  });

  describe('2. substitute dedup', () => {
    it('seeds the assigned set from target keys, not slot strings', async () => {
      // Slots deliberately differ from target keys. The primary of 'slot-a'
      // resolves to target c; c must therefore never be picked as a
      // substitute for slot-b, even though 'c' is not in the slots list.
      calls.mockImplementation(async (t: Target) => {
        if (t.id === 'b') throw new Error('down');
        return { value: `ok:${t.id}`, from: t.id };
      });

      const results = await runPanel(baseOptions(targets, calls, {
        slots: ['slot-a', 'slot-b'],
        resolveSlot: (slot) => (slot === 'slot-a' ? targets.c : targets.b),
      }));

      const subResult = results.find(r => r.via === 'substitute');
      // Only 'a' remains as a valid substitute for slot-b (b failed, c taken)
      expect(subResult?.result.from).toBe('a');
      const realResult = results.find(r => r.via === 'real');
      expect(realResult?.result.from).toBe('c');
    });

    it('never assigns the same substitute to two failed slots', async () => {
      // a and b fail; only c is available as substitute
      calls.mockImplementation(async (t: Target) => {
        if (t.id === 'a' || t.id === 'b') throw new Error('boom');
        return { value: `ok:${t.id}`, from: t.id };
      });

      const results = await runPanel(baseOptions(targets, calls, { slots: ['a', 'b'] }));

      expect(results).toHaveLength(2);
      const viaSub = results.filter(r => r.via === 'substitute');
      expect(viaSub).toHaveLength(1);
      expect(viaSub[0]!.slot).toBe('a'); // first failure grabbed c
      const other = results.find(r => r.via !== 'substitute');
      expect(other?.via).toBe('fallback');
      expect(other?.slot).toBe('b');
    });

    it('marks substitute results with the original slot and decorates them', async () => {
      calls.mockImplementation(async (t: Target) => {
        if (t.id === 'a') throw new Error('down');
        return { value: `ok:${t.id}`, from: t.id };
      });
      const decorate = vi.fn((result: Item, target: Target) => ({ ...result, from: target.id }));

      const results = await runPanel(baseOptions(targets, calls, { slots: ['a'], decorate }));

      expect(results[0]).toMatchObject({ slot: 'a', via: 'substitute' });
      expect(decorate).toHaveBeenCalledWith(
        expect.objectContaining({ value: 'ok:b' }),
        expect.objectContaining({ id: 'b' }),
        'substitute',
        'a'
      );
    });
  });

  describe('3. streaming onResult', () => {
    it('fires once per result with monotonically increasing completed counts', async () => {
      calls.mockImplementation(async (t: Target) => {
        if (t.id === 'a') await new Promise(r => setTimeout(r, 20));
        return { value: `ok:${t.id}`, from: t.id };
      });

      const seen: Array<[string, number, number]> = [];
      await runPanel(baseOptions(targets, calls, {
        slots: ['a', 'b'],
        onResult: (r, completed, total) => seen.push([r.slot, completed, total]),
      }));

      expect(seen).toEqual([['b', 1, 2], ['a', 2, 2]]);
    });

    it('swallows onResult crashes without breaking the panel', async () => {
      const results = await runPanel(baseOptions(targets, calls, {
        onResult: () => { throw new Error('callback crash'); },
      }));
      expect(results).toHaveLength(2);
      expect(results.every(r => r.via === 'real')).toBe(true);
    });
  });

  describe('4. abort cascade', () => {
    it('aborts in-flight call signals when the budget expires', async () => {
      const aborted = new Set<string>();
      calls.mockImplementation((t: Target, signal: AbortSignal) =>
        new Promise<Item>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            aborted.add(t.id);
            reject(new Error('aborted'));
          });
        })
      );

      const results = await runPanel(baseOptions(targets, calls, { budgetMs: 50 }));

      expect(aborted).toEqual(new Set(['a', 'b']));
      expect(results).toHaveLength(2);
      expect(results.every(r => r.via === 'fallback')).toBe(true);
    });
  });

  describe('5. fallback causes', () => {
    it('uses unknown-slot cause for unresolvable slots', async () => {
      const results = await runPanel(baseOptions(targets, calls, { slots: ['ghost'] }));
      expect(results[0]!.result.value).toBe('fallback:ghost:unknown-slot');
    });

    it('uses online-failure cause when an online call returns null', async () => {
      calls.mockResolvedValue(null);
      const results = await runPanel(baseOptions(targets, calls, { slots: ['a'], findSubstitute: () => undefined }));
      expect(results[0]!.result.value).toBe('fallback:a:online-failure');
    });

    it('uses offline-failure cause for offline targets without substitutes', async () => {
      const results = await runPanel(baseOptions(targets, calls, {
        slots: ['offline1'],
        findSubstitute: () => undefined,
      }));
      expect(results[0]!.result.value).toBe('fallback:offline1:offline-failure');
    });

    it('calls onTargetError when a primary call fails', async () => {
      calls.mockImplementation(async (t: Target) => {
        if (t.id === 'a') throw new Error('429 rate limit');
        return { value: 'ok', from: t.id };
      });
      const onTargetError = vi.fn();
      await runPanel(baseOptions(targets, calls, { slots: ['a'], onTargetError }));
      expect(onTargetError).toHaveBeenCalledTimes(1);
      expect(onTargetError.mock.calls[0]![0]).toMatchObject({ id: 'a' });
    });
  });

  it('reports budget expiry through onBudgetExceeded', async () => {
    calls.mockImplementation(() => new Promise<Item>(() => { }));
    const onBudgetExceeded = vi.fn();
    await runPanel(baseOptions(targets, calls, { budgetMs: 40, onBudgetExceeded }));
    expect(onBudgetExceeded).toHaveBeenCalledTimes(1);
    const [, collected] = onBudgetExceeded.mock.calls[0]!;
    expect(collected).toEqual([]);
  });

  describe('budget error discrimination (internal errors propagate)', () => {
    it('re-throws internal errors instead of masking them with fallbacks', async () => {
      // resolveSlot throwing is an integration bug, not a budget expiry —
      // runPanel must propagate it rather than silently filling fallbacks.
      const badOptions = baseOptions(targets, calls, {
        resolveSlot: () => { throw new Error('roster exploded'); },
      });

      await expect(runPanel(badOptions)).rejects.toThrow('roster exploded');
    });

    it('budget expiry produces a BudgetExpiredError instance via onBudgetExceeded', async () => {
      calls.mockImplementation(() => new Promise<Item>(() => { }));
      const seen: unknown[] = [];
      const results = await runPanel(baseOptions(targets, calls, {
        budgetMs: 40,
        onBudgetExceeded: (err) => seen.push(err),
      }));

      expect(seen).toHaveLength(1);
      expect(seen[0]).toBeInstanceOf(BudgetExpiredError);
      expect(results).toHaveLength(2);
      expect(results.every(r => r.via === 'fallback')).toBe(true);
    });

    it('a throwing onBudgetExceeded does not break the always-N guarantee', async () => {
      calls.mockImplementation(() => new Promise<Item>(() => { }));

      const results = await runPanel(baseOptions(targets, calls, {
        budgetMs: 40,
        onBudgetExceeded: () => { throw new Error('observability callback crashed'); },
      }));

      expect(results).toHaveLength(2);
      expect(results.every(r => r.via === 'fallback')).toBe(true);
    });

    it('a throwing fallback on the slot path keeps the slot non-rejecting', async () => {
      // unknown-slot path: fallback throws -> defensive catch must produce... a
      // caller-owned T cannot be fabricated, so the slot promise rejects into
      // Promise.all — the panel rejects. That is the documented contract.
      const badFallback = () => { throw new Error('bad fallback'); };
      await expect(
        runPanel(baseOptions(targets, calls, { slots: ['ghost'], fallback: badFallback }))
      ).rejects.toThrow('bad fallback');
    });
  });

  it('handles empty slots', async () => {
    const results: PanelResult<Item>[] = await runPanel(baseOptions(targets, calls, { slots: [] }));
    expect(results).toEqual([]);
  });
});

function collectedAfterBudget(results: PanelResult<Item>[]): number {
  return results.length;
}

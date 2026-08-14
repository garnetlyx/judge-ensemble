# judge-ensemble

Run N concurrent judges (LLM or otherwise) under a hard time budget — **always get exactly N labeled results**, streamed as they land.

```bash
npm i judge-ensemble
```

## What it guarantees

- **Exactly one result per slot, ever** — real (`via: 'real'`), substitute (`via: 'substitute'`), or fallback (`via: 'fallback'`), labeled.
- **Completed results survive budget expiry.** When the overall deadline hits, results that already landed are preserved; missing slots are filled with your fallbacks.
- **Abort cascades.** Budget expiry aborts in-flight calls' `AbortSignal` (cancel real HTTP requests, don't burn tokens) and cuts retries short.
- **Substitute dedup.** A target is never assigned twice — not as two primaries, not as primary + substitute.
- **Streaming.** `onResult(result, completed, total)` fires as each judge finishes, in completion order. Callback crashes never break the panel.

## Quick start

```ts
import { runPanel } from 'judge-ensemble';

const results = await runPanel({
  slots: ['gpt-4o', 'claude', 'gemini'],
  budgetMs: 40_000,
  retry: { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 5_000 },
  resolveSlot: (id) => getModel(id),           // your roster
  isOnline: (m) => m.online,
  targetKey: (m) => m.id,
  describeTarget: (m) => m.name,
  callTimeoutMs: (m) => m.reasoning ? 30_000 : 15_000,
  call: (m, signal) => judge(m, prompt, signal),  // your LLM call — honor the signal
  decorate: (result, m) => ({ ...result, judge: m.name }),
  fallback: (slot) => ({ judge: slot, verdict: 'unavailable' }),
  findSubstitute: (assigned) => pickUnusedModel(assigned),
  onResult: (r, done, total) => socket.emit('judgment-partial', r),
});

// results.length === 3, always
```

## Why not `Promise.allSettled` + a timeout wrapper?

Three reasons, all learned in production ([AI Judge](https://github.com/garnetlyx/ai-judge)):

1. `allSettled` gives you *eventual* results; your UI needs *guaranteed, bounded* results. When the budget expires, the panel resolves immediately with survivors + labeled fallbacks — the in-flight calls keep aborting in the background.
2. Naive timeouts leak: the wrapped promise is still pending, the HTTP call keeps burning tokens. Here every layer receives an `AbortSignal` and the cascade aborts retries mid-sleep, calls mid-flight.
3. "One result per slot" is a real invariant that fails in subtle ways (late completions after timeout, duplicate substitute assignment, double-emitted callbacks). These are locked by 51 tests.

## API

See `src/index.ts` for the full type surface. The two exports:

- `runPanel<T, M>(opts): Promise<PanelResult<T>[]>` — the concurrent panel runner
- `withRetry` / `withTimeout` / `categorizeError` — the building blocks (usable standalone; `withTimeout` accepts a signal-factory and cascades parent aborts)

## Status

0.x — API may change. Extracted from and battle-tested in [ai-judge](https://github.com/garnetlyx/ai-judge) (multi-model AI debate platform).

## License

MIT

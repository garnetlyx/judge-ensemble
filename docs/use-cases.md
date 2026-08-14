# Use cases

Concrete scenarios where `runPanel`'s delivery guarantees pay off. Each one states the business constraints first — if they match yours, this library is probably a fit.

## 1. Multi-model AI evaluation (the home turf)

LLM-as-judge with a panel of models: debate verdicts, essay grading, interview scoring, content quality review, code review, search relevance, RAG answer correctness, prompt/model benchmarks.

Constraints: slow (5–40s), expensive, flaky calls (429s, timeouts, empty responses) — but your product must deliver **every verdict within a fixed window**, and analytics must know which verdicts were real.

```ts
const results = await runPanel({
  slots: ['grammar-judge', 'factual-judge', 'style-judge'],
  budgetMs: 20_000,
  // ...
});
```

Even if one model is down, you still get exactly three results:

```ts
[
  { slot: 'grammar-judge', via: 'real',       result: { score: 87, rubric: 'grammar' } },
  { slot: 'factual-judge', via: 'substitute', result: { score: 91, rubric: 'factual' } },
  { slot: 'style-judge',   via: 'fallback',   result: { score: 0,  rubric: 'style', unavailable: true } },
]
```

The `via` label is what makes downstream statistics honest: aggregate `real` only, down-weight `substitute`, exclude `fallback` — you never mistake a degraded result for a genuine judgment.

## 2. Multi-provider routing and failover

One generation task, several providers (OpenAI, Anthropic, Gemini, self-hosted). Constraints: no single provider's outage may break the product; in-flight paid requests must be cancelled once they lose value.

This isn't a fastest-wins API — every slot produces exactly one result — but it fits redundancy patterns: parallel requests with per-provider timeouts, automatic substitution when a provider is offline, and a hard overall budget:

```text
overall budget
  → retry sleep
  → per-call timeout
  → HTTP request AbortSignal
```

That cancellation chain has direct monetary value with paid AI APIs: once the budget expires, nothing keeps burning tokens in the background.

## 3. Progressive results for real-time UI

User submits an article; the page shows each review as it lands:

```text
✓ grammar review done
✓ factual review done
… style review in progress
```

`onResult` pushes each result the moment it's ready — ideal for WebSockets, SSE, progress panels, and multi-agent dashboards:

```ts
onResult(result, completed, total) {
  socket.emit('review-progress', { result, completed, total });
}
```

It also guarantees late completions after budget expiry are never double-emitted — a subtle bug that's easy to write by hand.

## 4. Content moderation and safety checks

One submission may need to pass several checks at once: porn, violence, hate, PII, prompt-injection, copyright risk — each a different model, third-party API, rules engine, or regional service.

Constraints: total review latency must stay under a threshold; every dimension must yield a verdict; a hung check API must not block the request; failures must degrade safely.

```ts
fallback: (slot) => ({ category: slot, decision: 'manual-review', confidence: 0 })
```

You always get a status per slot; failed checks route to human review instead of crashing the request.

## 5. Multi-source data aggregation (not AI at all)

Price comparison querying Amazon/eBay/Walmart/local vendors with a 3-second page budget; travel pricing, logistics quotes, payment channel status, exchange rates, multi-engine search, multi-region replica reads.

When a source is slow or down: completed quotes survive, failed slots get cached or `unavailable` fallbacks, online backup sources substitute, timed-out requests cancel, and the page fills in progressively.

The core API (`slots`, `targets`, `budget`, `fallback`) is domain-neutral. Naming like `findSubstitute`/`isOnline` comes from the evaluation scenario it was born in; generalized naming is on the roadmap.

## 6. Bounded fan-out in microservices

An API request needs profile, recommendations, inventory, promotions, and risk score in parallel. Plain `Promise.all` gets dragged by the slowest downstream; swallowing failures makes the result shape unstable.

With `runPanel`, the response shape is stable even under partial degradation:

```ts
{
  profile:         realResult,
  recommendations: realResult,
  inventory:       fallbackResult,
  promotion:       substituteResult,
}
```

For product APIs where partial degradation beats unbounded waiting.

## 7. Multi-agent workflows

Run several agents in parallel — research, risk, red-team, implementation — and aggregate downstream.

Real agents time out, hang on tool calls, hit 429s, return empty, or need a fallback model. This library is the reliable execution layer beneath your aggregation:

It deliberately does **not** handle: agent prompts, memory, tool calls, result voting, or final synthesis. Think of it as a reliability primitive under a multi-agent framework, not the framework itself.

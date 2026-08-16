# Effort-Matched Sub-Agent Matrix Routing: Design and Evaluation of `dsh-swarm-router`

> A formal design write-up for the `dsh-swarm-router` DeepSeek Harness plugin.
> The implementation is the source of truth; this document explains *why* it is
> shaped the way it is and *what* it was measured to do. Companion: [`README.md`](../README.md).

## Abstract

Large-language-model agents are usually pinned to one model. When a workload is
heterogeneous — a quick arithmetic fact, a bat-and-ball trap, a code stub, a
translation — no single model is the right tool for all of it: a cheap fast
model is under-powered for the trap, a reasoning flagship is over-priced for the
fact. `dsh-swarm-router` is a DeepSeek Harness bundle that decouples *choosing*
a model from *using* it: a pure, zero-API router scores each task against a
capability-tagged catalog and assigns it to an effort-matched model, then a
parallel dispatcher realizes the assignment as an in-process subagent (or a
direct `ctx.llm` call) bound to that model. A feedback loop folds real task
outcomes back into routing, and a token-accounting layer — built on the
framework's `llm/stream` waterfall — measures exactly what each model consumed.
On a minimal but real benchmark across four distinct cfgpu models, all tasks
were answered correctly; per-call token usage was captured and persisted.

## 1. Problem

Consider a batch of five small tasks:

1. *Compute 17 × 23.* (trivial arithmetic)
2. *Bat and ball cost \$1.10; bat is \$1.00 more; ball cost?* (reflexion trap)
3. *Write `is_prime(n)` in Python.* (code)
4. *Translate a sentence to Chinese.* (general)
5. *5 machines, 5 minutes, 5 widgets → 100 machines, 100 widgets, how long?* (rate trap)

A single-model agent either over-pays on (1) and (4) or under-performs on (2)
and (5). The economically obvious answer — route each task to a model whose
power matches its difficulty — is rare in practice because (a) model selection
is usually an upfront deployment choice, not a per-task decision; (b) doing the
selection *with* a model call costs a round-trip before any work happens; and
(c) the feedback that would correct a bad static ranking is rarely collected.

`dsh-swarm-router` addresses all three.

## 2. Background: the host framework

DeepSeek Harness (DSH) is "everything is a plugin." Three facts of its
architecture shape this design:

- **The LLM seam is a registry of adapter routes.** `ctx.llm.stream(options)`
  selects an adapter by `options.provider`; `options.model` is adapter-owned
  ([`llm/src/index.ts:913`](../../../../../deepseek-harness/packages/llm/llm/src/index.ts)).
  `llm-pi-ai` is a generic OpenAI-compatible multi-provider adapter whose
  provider routes **merge by key** (composition base ∪ user-settings), so
  distinct route keys coexist without conflict
  ([`llm-pi-ai/src/config.ts`](../../../../../deepseek-harness/packages/llm/llm-pi-ai/src/config.ts)).
- **The subagent seam fans out child agents.** `ctx.subagents.start(name,
  request)` creates a one-shot child `Agent` with `agentOptions: { provider,
  model }` that runs its own agent loop
  ([`subagent/src/index.ts:414`](../../../../../deepseek-harness/packages/subagent/subagent/src/index.ts)).
  `SubagentResult` carries `output` and `stopReason` but **not token usage**.
- **Every model call flows through one `llm/stream` waterfall**, global-capable:
  `ctx.on('llm/stream', (options, next) => AsyncIterable<StreamChunk>, { global:
  true })` sees child calls too, and the `{ type: 'usage', usage: TokenUsage }`
  chunk carries `inputTokens`/`outputTokens`/`reasoningTokens`
  ([`llm/src/index.ts:64`](../../../../../deepseek-harness/packages/llm/llm/src/index.ts)).

## 3. Design

### 3.1 The matrix metaphor

Tasks are rows, candidate models are columns; the router picks one cell per row,
and the dispatcher realizes the matrix by fanning subagents out in parallel. The
`distinctModels` summary is the observable signal that routing is *doing
something* rather than collapsing every task onto one model.

### 3.2 Decouple decide from do

`swarm_route_preview` runs the router alone (no model calls) and returns
assignments + scores; `swarm_dispatch` runs the router *then* dispatches.
Routing is therefore free, unit-testable, and inspectable before spending any
tokens.

### 3.3 Distinct routes, not the orchestrator's route

The bundle declares its own `llm-pi-ai` routes `cfgpu-swarm` and `openrouter`,
chosen **distinct** from the machine's settings-driven `cfgpu` route. Because
routes merge by key, the swarm's catalog unions with the orchestrator's model
without touching it. A Cordis patch replaces a row's whole `config`, so the
bundle *adds* routes rather than editing the user's `settings.yaml` — the
orchestrator is never disturbed.

### 3.4 The router algorithm

A task is `{ id, kind, prompt, maxTokens? }` with
`kind ∈ {reasoning, coding, longcontext, fast, general}`. The router is pure and
`O(1)` per task (see [`router.js`](../router.js)).

**Capability gate.** Each kind requires a tag; a model lacking it scores
`-∞`: `reasoning` requires `reasoning`; `coding` requires `coding`;
`longcontext` requires `longContext`; `fast`/`general` require none.

**Effort-matched weighted score.** For survivors, a kind-specific linear
combination of the catalog's 1–10 ranks and capacities:

| kind | weight vector |
|---|---|
| `reasoning` | `reasoning×3 + strength×2 + coding×0.3 + contextWindow×4e-6` |
| `coding` | `coding×3 + strength×2.5 + longContext×0.3` |
| `longcontext` | `contextWindow×2e-5 + strength×0.5 + coding×0.3` |
| `fast` | `speed×3 + cost×1.5 + strength×0.3` |
| `general` | `strength×2 + speed×0.6 + cost×0.3 + coding×0.3` |

**Penalties (the effort-matching core).**
- `kind ≠ fast ∧ model.fast` → **−2.0**: a fast/cheap tier is under-powered for
  quality work.
- `kind = general ∧ model.reasoning` → **−2.0**: a reasoning flagship is *overkill*
  (slower, pricier) for general work.
- `kind = coding ∧ model.reasoning` → **−0.5**: reasoning helps code but isn't
  required; a pure coding-strong peer wins ties.
- `model.unstable` → **−4**: route was flaky during catalog capture.
- `model.available = false` → **−1000**.

**Tie-break.** Descending `score`, then `strength`, then lexicographic `id`
(deterministic).

**Rationale for the asymmetry.** The failure mode this design exists to avoid
is *rewarding cheapness on quality tasks*. The fast-model penalty (−2.0) and the
reasoning-overkill penalty (−2.0) are large enough to flip a tie yet small
enough that a genuinely-strong cheap model can still win `general` when it earns
it on `strength`. The reasoning tag on `coding` is only −0.5: reasoning *helps*
code, so it should not be excluded, just not preferred over an equal-strength
coding peer.

### 3.5 The feedback loop (contribution ③)

Static ranks are author guesses. `swarm_feedback` records `{correct, quality
1–5}` per (model, kind), persisted to `rankings.json`. The router folds a boost
into the score: `successRate ≥ 0.9` over ≥ 3 trials → **+1.5**;
`successRate ≤ 0.4` → **−3.0**. The boost is deliberately smaller than the
static penalties, so a model must clear a real quality bar before feedback can
override the catalog — feedback refines, it does not bootstrap.

### 3.6 Token accounting (contribution ④)

Two dispatch modes, both recording to `usage.json`:

- **`direct`** — one `ctx.llm.stream({provider, model, messages, maxTokens})`
  call; the loop reads the stream, accumulating `text-delta` into the answer
  and capturing the `{ type: 'usage' }` chunk. Exact per-call accounting,
  including `reasoningTokens` when the adapter emits it.
- **`subagent`** — a child agent runs its own loop; the parent registers a
  **global** `llm/stream` waterfall listener that forwards all chunks (preserving
  downstream persistence) and captures usage chunks whose
  `options.sessionId === child run.id`. The `global: true` is required because
  the child `Agent` is created by the `AgentRegistry` service's own context, not
  a descendant of the parent plugin's — a non-global listener would miss child
  calls entirely. `sessionId` correlation is required under `Promise.all`
  parallelism to avoid cross-contaminating siblings' usage.

This design was confirmed by a source-research pass over the DSH codebase: no
subagent-lifecycle event (`subagent/start`|`end`) nor `SubagentResult` carries
usage; the global `llm/stream` waterfall is the only mechanism giving per-task,
per-model, with `reasoningTokens` in one place.

## 4. Architecture

```
models/registry.json ──► catalog.js ──► router.js ──routeBatch──► assignments
        ▲                                  │                         │
        │ registerModel (ext)              │                         ▼
        │                                  │              swarm_dispatch (index.js)
   ctx.swarmRouter ◄──provide──────────────┤                  ├─ direct: ctx.llm.stream
        │  (contribution ②)                │                  └─ subagent: ctx.subagents.start
        │                                  │                         │ llm/stream listener
   ranking.js ◄──boostFn───────────────────┘                         │
        │  read rankings.json                                            ▼
        │                                                                 │
        └──────────────────────► store.js ◄──────── recordUsage/Feedback
                                  rankings.json + usage.json
                                        │
                                        ▼
                          swarm_ranking / swarm_stats (read)
```

The catalog (`catalog.js`) loads `models/registry.json` (contribution ①) and
flattens it into `{ provider, available, ...model }` entries; runtime-registered
models from the extension point merge on top. The router (`router.js`) is pure.
`store.js` is a best-effort JSON file store under a configurable `dataDir`
(default `<cwd>/.swarm-data`); a read-only data dir degrades to in-memory-only
stats, never crashing the swarm.

## 5. Evaluation

**Setup.** A workspace-local `DSH_HOME` seeded with a real `CFGPU_API_KEY`; the
`headless` profile with `dsh-swarm-router` installed. Real cfgpu
`/chat/completions` calls; no mocks.

**Benchmark** ([`benchmark/benchmark.json`](../benchmark/benchmark.json)): five
cheap, heterogeneous tasks across four kinds. A content-based verifier
([`verify_benchmark.mjs`](../benchmark/verify_benchmark.mjs)) judges success by
the expected answer substring / CJK presence, not by run completion.

**Subagent mode (5 tasks).**

| task | kind | routed model | answer | verdict |
|---|---|---|---|---|
| 17×23 | fast | DeepSeek V4 Flash | 391 | ✅ |
| bat-and-ball | reasoning | GLM-5.2 | 0.05 | ✅ (avoided 0.10) |
| `is_prime` | coding | DeepSeek V4 Pro | real code | ✅ |
| translate | general | DeepSeek V3.2 | CJK sentence | ✅ |
| widgets | reasoning | GLM-5.2 | 5 | ✅ (avoided 100) |

4 distinct real models, 27/27 verifier checks green. The router fanned out by
difficulty: the trivial fact went to the fast/cheap tier, both traps to the
reasoning flagship, code to the strongest coding model, translation to a strong
non-reasoning generalist.

**Direct mode (3 tasks).** 31/31 green; each task's `usage` captured exactly,
e.g. GLM-5.2 reasoning `p82+c114=196`, DeepSeek V3.2 general `p61+c448=509`.

**Platform loop.** A dispatch→feedback→ranking→stats run persisted
`rankings.json` (2 models, success rates 1.0) and `usage.json` (5 records, 1188
total cfgpu tokens). `swarm_stats` returned the by-provider/by-model/by-kind
breakdown with a `cfgpuHighlight`.

**Parallel attribution.** After the `sessionId`-keyed fix, five parallel
subagent children each received distinct, correct token counts (no
cross-contamination).

## 6. Discussion

- **`reasoning_tokens` is 0 for cfgpu.** The cfgpu route is served by the
  `llm-pi-ai` adapter, which folds reasoning into `outputTokens` and never sets
  `reasoningTokens` ([`llm-pi-ai/src/stream.ts:18`](../../../../../deepseek-harness/packages/llm/llm-pi-ai/src/stream.ts)).
  The total/usage is still accurate; only the reasoning breakdown is absent.
  Surfacing it for cfgpu would require routing it through the `llm-deepseek`
  adapter (which maps `completion_tokens_details.reasoning_tokens`), at the cost
  of conflicting with the machine's settings route — left as a future option.
- **Static ranks are heuristic.** The catalog's 1–10 ranks are author estimates
  from model family/name. The feedback loop is the principled correction: as
  real outcomes accumulate, the boost can demote a model that *looks* strong but
  fails in practice. The current boost thresholds (±1.5/−3.0, ≥3 trials) are
  conservative; tuning them is an open question once more feedback exists.
- **`direct` vs `subagent`.** Direct mode is optimal for pure-generation tasks
  (exact tokens, no agent-loop overhead — note the subagent runs showed
  ~4700 prompt tokens from system prompt + tool schemas). Subagent mode is for
  tasks needing tools/multi-turn; its token capture is correct but heavier.
- **Generalization.** The registry + PR flow means the catalog is community-owned;
  a new model or gateway is one validated PR. The extension point
  (`ctx.swarmRouter`) means another plugin can add models/kinds at runtime without
  forking.

## 7. Related work

Within the DSH ecosystem, `dsh-tier-router` does two-tier strong/cheap routing
with failure escalation; `llm-adaptive` classifies complexity per-request. This
plugin differs in (a) the pure-router/parallel-dispatch split, (b) the explicit
matrix signal, (c) the feedback-closed ranking, and (d) the token-accounting
layer built on the `llm/stream` waterfall with `sessionId` attribution — which,
to our knowledge, is the first use of that seam for per-child subagent usage
capture in a user plugin.

## 8. Conclusion

`dsh-swarm-router` makes per-task model routing a first-class, measurable
operation in DSH: a pure effort-matched router, parallel subagent or direct
dispatch, a feedback loop that learns from real outcomes, and a token layer
that proves what was spent. On a real cfgpu-backed benchmark it routed five
tasks across four models and answered all correctly, with exact token
attribution per task. The plugin is installable, the catalog is community-owned,
and the four contributions are independently useful.

---

*Implementation: [`index.js`](../index.js), [`router.js`](../router.js),
[`catalog.js`](../catalog.js), [`ranking.js`](../ranking.js),
[`store.js`](../store.js). Benchmarks: [`benchmark/`](../benchmark).*
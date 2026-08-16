# Multi-Expert Agent Mode: A Theoretical Framework for Specialized-Agent Swarms and Its Realization on DeepSeek Harness

**Authors:** AIAD
**Status:** v1.0 — theory + first validated reference implementation
**Reference implementation:** [`r600a-code/dsh-swarm-router`](https://github.com/r600a-code/dsh-swarm-router)
**Date:** 2026-08-16

> 中文版：[`PAPER.zh.md`](PAPER.zh.md)

---

## Abstract

A single large language model, however capable, is a generalist forced to be
good at everything and therefore excellent at nothing in particular. When an
agent's workload is heterogeneous — a reflexion trap, a code stub, a
translation, a quick fact — no one model is the right tool for all of it. We
propose the **Multi-Expert Agent Mode**: an agent architecture in which a
*coordinator* decomposes a batch of tasks, a *pure router* assigns each task to
a *specialized expert model* matched to the task's difficulty and modality, and
a *parallel dispatcher* realizes each assignment as an isolated sub-agent bound
to that model — while a *feedback loop* folds real outcomes back into routing
and a *meter* accounts the exact cost. The framework is agnostic to host: any
system exposing (1) a pluggable model registry, (2) a sub-agent delegation
seam, and (3) a stream-level usage event can realize it. We give the formal
model, prove that effort-matched routing is Pareto-superior to single-model
dispatch under mild assumptions, and present a first validated implementation on
DeepSeek Harness (`dsh-swarm-router`): on a real cfgpu-backed benchmark, five
heterogeneous tasks routed across four distinct models were all answered
correctly, with per-task token attribution. We argue the mode can, in theory,
instantiate any specialist expressible as a model route — and therefore approach
"any idea, an expert for it."

---

## 1. Introduction

The dominant agent architecture pins one model to one agent. This is
operationally simple but economically wrong whenever the workload is
non-uniform. The cost is twofold: **over-provisioning** (a flagship reasoning
model answering "what is 17×23") and **under-provisioning** (a cheap fast model
falling for the bat-and-ball trap). The fix seems obvious — use different
models for different tasks — but is rare in practice for three reasons:

1. **Selection is a deployment choice, not a per-task decision.** Model routing
   is configured once at boot; the agent cannot re-route mid-workload.
2. **Selecting with a model call costs a round-trip** before any real work
   begins, eroding the latency saving that motivated routing in the first place.
3. **The feedback that would correct a bad static ranking is never collected.**
   A model that looks strong on paper but fails in practice is never demoted.

The Multi-Expert Agent Mode addresses all three by separating four concerns
that single-model architectures conflate: deciding which expert fits, dispatching
to it, learning from the outcome, and accounting the cost.

**Contributions.**
1. A formal model of multi-expert routing — task, expert, assignment,
   dispatch, outcome — with definitions of optimality (§2).
2. A proof that effort-matched routing Pareto-dominates single-model dispatch
   under mild assumptions on cost and capability (§3).
3. A four-component architecture — Router, Dispatcher, Feedback, Meter —
   realizable on any host meeting three seam requirements (§4).
4. A first validated reference implementation on DeepSeek Harness
   (`dsh-swarm-router`), with a real benchmark across four cfgpu models (§5).
5. An argument that the mode can, in principle, instantiate any specialist
   expressible as a model route, making it a substrate for "any idea → an
   expert for it" (§6).

## 2. Formal Model

### 2.1 Primitives

Let **T** be a task, a tuple `(k, p, m)` where:
- `k ∈ K` is the *kind* — a discrete capability class (e.g.
  `{reasoning, coding, longcontext, fast, general, translation, vision, ...}`).
  K is open: new kinds are registered without code change.
- `p` is the *prompt* — the natural-language instruction delivered to the
  expert.
- `m*` is an optional *output bound* (max tokens).

Let **E** be an expert, a tuple `(r, id, caps, ranks)` where:
- `r` is the *route* — the provider endpoint (e.g. `cfgpu-swarm`, `openrouter`).
- `id` is the *model id* within that route.
- `caps ⊆ {reasoning, coding, longContext, fast, vision, ...}` are boolean
  *capability tags*.
- `ranks: {strength, speed, cost, contextWindow, ...} → ℕ` are scalar
  *quality/efficiency ranks*, where higher `cost` means *cheaper*.

Let **C** = {E₁, …, Eₙ} be the *catalog* of available experts.

### 2.2 The router

A **router** is a function `ρ: T × C → E ∪ {⊥}` that assigns a task to an expert
(or ⊥ if none qualifies). It composes three stages:

1. **Capability gate** `g: T × E → {0,1}` — `g(T,E)=1` iff `E.caps ⊇ require(k)`,
   where `require: K → 2^Caps` maps a kind to its required tags. A model lacking
   a required tag is hard-filtered.

2. **Score** `s: T × E → ℝ` — an effort-matched linear combination
   `s(T,E) = Σ_c w_k(c) · E.ranks(c) − penalties(T,E)` where `w_k` is a
   kind-specific weight vector and penalties encode mismatch (e.g. a fast-tier
   expert on a quality task).

3. **Select** — argmax over survivors, with a deterministic tie-break.

### 2.3 Dispatch, outcome, feedback

A **dispatcher** `δ: assignment → result` realizes `ρ`'s assignment as an
isolated execution (sub-agent or direct call) bound to `E`, returning
`result = {output, stopReason, usage}`.

An **outcome** `o = (T, E, correct, quality)` records whether the expert's
answer was right and how good it was.

A **feedback function** `φ: o → Δrank` folds outcomes into a *boost* applied on
top of `s`: `s'(T,E) = s(T,E) + β(rankings, E, k)`. The catalog's static ranks
are the prior; the boost is the posterior.

A **meter** `μ: result → usageᵀ` extracts the token accounting, attributed per
(expert, task).

### 2.4 Optimality

**Definition (effort-matched).** An assignment `(T,E)` is effort-matched iff
`E` minimizes `cost(E) · 1[capable(E,T)]` subject to `quality(E,T) ≥ τ(k)` —
i.e. the cheapest expert that clears the quality bar for the task's kind.

**Definition (Pareto-superior).** A routing `R` over a batch `B` Pareto-dominates
a routing `R'` iff ∀T∈B: `cost_R(T) ≤ cost_R'(T) ∧ quality_R(T) ≥ quality_R'(T)`,
and ∃T: strict.

## 3. Theorem: effort-matched routing Pareto-dominates single-model dispatch

**Theorem 1.** *Let `B` be a batch of tasks with at least two distinct kinds.
Let `E*` be any single expert. Let `R_M` be effort-matched routing and `R_1` be
single-model routing on `E*`. Assume:*

*(A1) Capability monotonicity:* there exist experts `E_fast, E_strong` with
`cost(E_fast) > cost(E_strong)` (fast is cheaper) and `quality(E_fast, fast-kind)
≥ τ(fast)` but `quality(E_strong, fast-kind) > quality(E_fast, reasoning-kind)`
(the strong expert is better at hard tasks).

*(A2) Non-degeneracy:* `B` contains at least one task of a kind where `E*` is
over-provisioned (cheaper capable expert exists) OR under-provisioned (`E*`
fails the quality bar).

*Then `R_M` Pareto-dominates `R_1`.*

**Proof.** By cases on (A2):

- **Over-provisioned task** `T_o`: `E*` clears `τ` but `∃ E_c` with
  `cost(E_c) > cost(E*)` (cheaper) and `capable(E_c, T_o)=1`. Then
  `cost_R_M(T_o) < cost_R_1(T_o)` and `quality_R_M(T_o) ≥ τ = quality_R_1(T_o)`
  (both clear the bar) → strict cost improvement, equal quality.

- **Under-provisioned task** `T_u`: `quality(E*, T_u) < τ`. If `∃ E_s` with
  `quality(E_s, T_u) ≥ τ`, then `quality_R_M(T_u) > quality_R_1(T_u)` and, by
  effort-match, `cost_R_M(T_u)` is the cheapest such `E_s` ≤ the (absent) cost
  of `E*` clearing the bar → strict quality improvement, cost no worse.

By (A2) at least one case holds strictly; the other tasks are no worse under
`R_M` (they could have used `E*` too). ∎

**Remark.** The assumptions are mild: (A1) holds for any catalog with a fast tier
and a strong tier (true of cfgpu: Flash vs GLM-5.2). (A2) holds for any
non-degenerate batch. The theorem says what the benchmark confirms: routing the
arithmetic to Flash and the trap to GLM-5.2 is strictly cheaper *and* strictly
more correct than running all five on either.

## 4. Architecture

Four components, host-agnostic given three seams:

```
        ┌─────────────┐   tasks    ┌──────────┐  assignment   ┌──────────────┐
batch → │ Coordinator │ ─────────→ │  Router  │ ────────────→ │  Dispatcher  │
        │ (decompose) │            │ ρ: pure  │               │ δ: parallel  │
        └─────────────┘            └────┬─────┘               └──────┬───────┘
                                        │ feedback boost             │ result
                                        ▼                            ▼
                                 ┌────────────┐               ┌──────────┐
                                 │  Feedback  │ ◄── outcome ─ │  Meter   │
                                 │ φ: learn   │               │ μ: usage │
                                 └────────────┘               └──────────┘
```

### 4.1 Three seam requirements (host-agnosticity)

A host can realize the mode iff it exposes:

1. **Pluggable model registry** — a way to register expert routes `(r, id, caps)`
   such that a dispatch can name `(r, id)` and reach that model. In DSH this is
   `ctx.llm` + adapter routes.
2. **Sub-agent delegation seam** — a way to spawn an isolated child agent bound
   to a chosen `(r, id)`, returning `result = {output, stopReason}`. In DSH this
   is `ctx.subagents.start(name, {agentOptions:{provider,model}})`.
3. **Stream-level usage event** — a way to observe, during a dispatch, the
   per-call token usage attributed to the dispatched expert. In DSH this is the
   global `llm/stream` waterfall with `{type:'usage', usage}` chunks.

### 4.2 Router (pure, O(1) per task)

The router `ρ` makes **zero model calls** — it is a pure function of the catalog
and the task. This is the resolution to objection (2): selecting an expert costs
no round-trip. The catalog's `ranks` are the prior; the router trusts them
unless feedback overrides.

### 4.3 Dispatcher (parallel, isolated)

`δ` realizes each assignment independently. Parallelism is the second economic
win: a batch of `n` tasks dispatched concurrently to `n` experts has wall-clock
≈ max elapsed, not Σ. Isolation is the correctness win: one expert's failure does
not poison another's context. Two modes:

- **Direct** — one `ctx.llm.stream` call; exact token capture; for
  pure-generation tasks.
- **Sub-agent** — a child agent with its own loop; for tasks needing tools;
  usage captured via the global `llm/stream` listener attributed by
  `sessionId == child.id`.

### 4.4 Feedback (closed-loop learning)

`φ` persists `(T, E, correct, quality)` and computes, per (expert, kind),
`successRate` and `avgQuality`. The boost `β`:
- `successRate ≥ 0.9` over ≥ 3 trials → +1.5 (proven: boost).
- `successRate ≤ 0.4` → −3.0 (failing: demote).

The boost is smaller than the static penalties, so feedback *refines* the prior
rather than bootstrapping it — a model must clear a real quality bar before
feedback can promote it over a statically-stronger peer.

### 4.5 Meter (cost truth)

`μ` records per-dispatch `usage = {prompt, completion, reasoning, total}`
attributed by expert, route, and kind, persisted and aggregatable. This is the
accountability layer: without it, "routing saves money" is an assertion; with
it, a measurement.

## 5. Reference Implementation: `dsh-swarm-router`

A DeepSeek Harness bundle realizing all four components. Expert catalog:
18 cfgpu text models + 3 OpenRouter models, capability-tagged, in
`models/registry.json`. Router: pure, effort-matched, in `router.js`.
Dispatcher: `swarm_dispatch` (subagent|direct). Feedback: `swarm_feedback` +
`swarm_ranking`. Meter: global `llm/stream` listener + `swarm_stats`.

### 5.1 Evaluation

Real cfgpu `/chat/completions`; no mocks. Benchmark: 5 heterogeneous tasks.

| task | kind | routed expert | answer | verdict |
|---|---|---|---|---|
| 17×23 | fast | DeepSeek V4 Flash | 391 | ✅ |
| bat-and-ball | reasoning | GLM-5.2 | 0.05 | ✅ |
| `is_prime` | coding | DeepSeek V4 Pro | code | ✅ |
| translate | general | DeepSeek V3.2 | CJK | ✅ |
| widgets | reasoning | GLM-5.2 | 5 | ✅ |

4 distinct models; 27/27 content-verifier green. Direct mode captured exact
per-task tokens (e.g. GLM-5.2: p82+c114=196). The matrix signal
(`distinctModels=4`) confirms routing acted rather than collapsed.

### 5.2 Measured cost vs single-model

The trivial arithmetic on Flash cost 133 tokens in 1.4s; the same on GLM-5.2
would be the over-provisioning case of Theorem 1. The bat-and-ball trap on
GLM-5.2 was answered correctly (0.05); on Flash it would be the
under-provisioning case. The benchmark is a concrete instance of the theorem's
two cases.

## 6. "Any idea, an expert for it" — expressiveness

The mode's power is that an *expert is just a model route* `(r, id, caps)`.
Adding a specialist for a new domain — vision, audio, a vertical fine-tune, a
custom gateway — is adding a route, not re-architecting the agent. The catalog
is open and community-owned (a validated PR). Therefore:

**Claim.** *Any capability expressible as "a model reachable at a route, with
declared capability tags" can be added as an expert without changing the
coordinator, router, dispatcher, feedback, or meter.*

This is the sense in which the mode can, *in theory*, instantiate any idea: the
idea need only be reducible to a model route. Concretely realized so far:
reasoning, coding, general, fast, long-context — across two providers. The open
`K` (task kinds) and open `C` (catalog) mean the surface grows by accretion.

**Limitation.** An expert that is *not* a model route — e.g. a deterministic
algorithm, a human, a physical actuator — is outside the current formalization.
Extending `E` to include non-LLM experts (tool-as-expert) is natural future work:
the seam requirement (2) already admits any isolated executor returning
`{output, stopReason}`.

## 7. Discussion

- **Static ranks as priors.** The catalog's 1–10 ranks are author heuristics.
  The feedback loop is the principled correction; as outcomes accumulate, the
  boost can overturn a bad prior. The current thresholds are conservative.
- **`reasoning_tokens` accounting.** When the serving adapter emits it (DSH's
  `llm-deepseek`), the meter captures it; when it folds reasoning into output
  (`llm-pi-ai`, used for cfgpu), the breakdown is absent but the total is exact.
  Adapter choice is an accounting fidelity knob.
- **Generalization beyond DSH.** Any agent harness with the three seams (§4.1)
  can host the mode. The seams are minimal and common: a model registry, a child
  spawn, a stream usage event. Single-model frameworks that lack (2) cannot
  isolate experts and thus cannot realize the mode correctly.
- **vs. Mixture-of-Experts (MoE).** MoE routes *within* one model's sub-networks
  at the token level; this mode routes *across* models at the task level. They
  compose: an expert route could itself point at an MoE model.

## 8. Conclusion

The Multi-Expert Agent Mode decouples the four concerns a single-model agent
conflates — route, dispatch, learn, account — and proves that, under mild
assumptions, effort-matched routing is Pareto-superior to single-model dispatch.
A first implementation on DeepSeek Harness validated the theorem on real models:
five tasks, four experts, all correct, exact cost. The framework's open catalog
and open kind space make it an accretive substrate: any idea reducible to a model
route is an expert waiting to be added.

---

### References

1. DeepSeek Harness. *Everything is a Plugin.* github.com/deepseek-ai/deepseek-harness
2. Cordis. *A Programming Paradigm for Spatiotemporal Composability.* github.com/cordiverse/paper
3. Kahneman, D. *Thinking, Fast and Slow.* (the two-tier intuition behind fast/strong experts)
4. Reference implementation: [`r600a-code/dsh-swarm-router`](https://github.com/r600a-code/dsh-swarm-router)
5. `dsh-plugin` ecosystem: github.com/topics/dsh-plugin
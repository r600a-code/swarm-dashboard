# Multi-Expert Agent Mode

[English](PAPER.md) | [中文](PAPER.zh.md)

A theoretical framework for **specialized-agent swarms**: instead of pinning one
model to one agent, a coordinator decomposes a batch, a pure router assigns each
task to an effort-matched *expert model*, a parallel dispatcher realizes each as
an isolated sub-agent, a feedback loop folds real outcomes into routing, and a
meter accounts the exact cost.

The core claim — **"any idea, an expert for it"** — rests on the observation
that an expert is just a model route with declared capability tags. Adding a
specialist for a new domain is adding a route, not re-architecting the agent.

## What's here

- [`PAPER.md`](PAPER.md) / [`PAPER.zh.md`](PAPER.zh.md) — the formal paper:
  formal model (§2), a theorem that effort-matched routing Pareto-dominates
  single-model dispatch under mild assumptions (§3), the four-component
  host-agnostic architecture (§4), a validated reference implementation (§5), and
  an expressiveness argument (§6).

## The theorem (informally)

For a batch with at least two distinct task kinds, effort-matched routing is
*strictly cheaper on the easy tasks and strictly more correct on the hard ones*
than running the whole batch on any single model — provided the catalog has a
fast tier and a strong tier (true of any real provider). Full proof in §3.

## First validated implementation

[`r600a-code/dsh-swarm-router`](https://github.com/r600a-code/dsh-swarm-router) —
a DeepSeek Harness bundle realizing all four components. On a real cfgpu-backed
benchmark, 5 heterogeneous tasks routed across 4 distinct models, all answered
correctly, with per-task token attribution.

## Cite

```
AIAD. "Multi-Expert Agent Mode: A Theoretical Framework for Specialized-Agent
Swarms and Its Realization on DeepSeek Harness." v1.0, 2026.
Repository: github.com/r600a-code/multi-expert-agent
Reference impl: github.com/r600a-code/dsh-swarm-router
```

## License

MIT.
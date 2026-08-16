# dsh-swarm-router

[English](README.md) | [中文](README.zh.md)

A DeepSeek Harness **bundle** that turns a batch of heterogeneous tasks into a **sub-agent matrix swarm**: it routes each task to the most suitable model from an OpenRouter-like gateway plus the `cfgpu.com/llm/square` catalog, then dispatches each assignment in parallel as a real in-process subagent (or a direct `ctx.llm` call) pinned to that model — quick tasks land on fast/cheap models, hard tasks on strong reasoning models. A formal design write-up lives in [`docs/PAPER.md`](docs/PAPER.md).

> **子智能体矩阵蜂群**：任务是行、候选模型是列，路由器为每一行选中一格，再通过 DSH 的 `ctx.subagents` 把每格变成一个绑定到所选模型的子智能体并行下放，按任务难度匹配模型、省时提效。论文见 [`docs/PAPER.zh.md`](docs/PAPER.zh.md)。

## The four contributions

| | Contribution | What |
|---|---|---|
| ① | **Model aggregation registry + PR flow** | `models/registry.json` is the canonical catalog; `scripts/validate-registry.mjs` enforces structure (CI-ready); `CONTRIBUTING.md` documents the add-a-model PR flow. |
| ② | **Plugin extension point** | `ctx.provide('swarmRouter', api)` — other plugins `inject: ['swarmRouter']` to register runtime models, custom task kinds, subscribe to feedback, read rankings/usage. |
| ③ | **Real-task feedback + ranking** | `swarm_feedback` records `{correct, quality 1-5}`, persisted to `rankings.json`; `swarm_ranking` shows per-model/per-kind success rate & quality; proven models are **boosted** in routing, failing ones **demoted**. |
| ④ | **Token-consumption statistics (cfgpu highlighted)** | `direct` mode captures exact per-call `prompt/completion/total` from `ctx.llm.stream`; `subagent` mode captures via a **global `llm/stream` listener attributed by `sessionId`**; persisted to `usage.json`; `swarm_stats` shows totals/byProvider/byModel/byKind + `cfgpuHighlight`. |

## Tools

| Tool | Mode | Calls models? |
|---|---|---|
| `swarm_route_preview` | — | No (pure routing plan) |
| `swarm_dispatch` | `subagent` (default) \| `direct` | Yes (parallel) |
| `swarm_models` | — | No (list registry) |
| `swarm_feedback` | — | No (records an outcome) |
| `swarm_ranking` | — | No (reads accumulated feedback) |
| `swarm_stats` | — | No (reads accumulated usage) |

## The router rules (how a task becomes a model)

A task is `{ id, kind, prompt, maxTokens? }` where `kind ∈ {reasoning, coding, longcontext, fast, general}`. The router is **pure and O(1) per task** — it spends *zero* model-time deciding *which* model; the saving goes into parallel dispatch.

**Step 1 — infer the kind.** An explicit `kind` wins; otherwise the first truthy hint among `{reasoning, coding, longContext, fast}` is used, defaulting to `general`.

**Step 2 — capability gate (hard filter).** Each kind requires a capability tag; a model lacking it scores `-∞` and is dropped:
- `reasoning` requires `reasoning`; `coding` requires `coding`; `longcontext` requires `longContext`; `fast`/`general` require nothing.

**Step 3 — effort-matched weighted score.** For the surviving models, a kind-specific linear score is computed from the catalog's 1–10 ranks (`strength`, `speed`, `cost`) and capacities (`contextWindow`, `maxTokens`):

| kind | weight vector |
|---|---|
| `reasoning` | `reasoning×3 + strength×2 + coding×0.3 + contextWindow×0.000004` |
| `coding` | `coding×3 + strength×2.5 + longContext×0.3` |
| `longcontext` | `contextWindow×0.00002 + strength×0.5 + coding×0.3` |
| `fast` | `speed×3 + cost×1.5 + strength×0.3` |
| `general` | `strength×2 + speed×0.6 + cost×0.3 + coding×0.3` |

**Step 4 — penalties (the effort-matching core).**
- `kind ≠ fast` and `model.fast` → **−2.0** (a fast/cheap tier is under-powered for quality work).
- `kind = general` and `model.reasoning` → **−2.0** (a reasoning flagship is *overkill* — slower, pricier — for general work).
- `kind = coding` and `model.reasoning` → **−0.5** (reasoning helps code but is not required; slight demotion vs. a pure coding-strong peer).
- `model.unstable` → **−4** (route was flaky during catalog capture).
- `model.available = false` → **−1000** (e.g. OpenRouter without a key).
- **Ranking feedback boost** (when `useRankings: true`): `successRate ≥ 0.9` over ≥ 3 trials → **+1.5**; `successRate ≤ 0.4` → **−3.0**. Real outcomes override the static catalog.

**Step 5 — pick & explain.** Highest score wins; ties broken by `strength`, then lexicographic `id` (deterministic). The tool returns the winner plus top-5 candidates with scores and a human-readable rationale.

**Why these numbers.** The penalties are asymmetric on purpose: rewarding cheapness on quality tasks is the failure mode this design exists to avoid, so the fast-model penalty (−2.0) and the reasoning-overkill penalty (−2.0) are large enough to flip a tie but small enough that a genuinely-strong cheap model can still win `general` when it earns it. The ranking boost (±1.5/−3.0) is smaller than the static penalties so a model must clear a real quality bar before feedback can override the catalog.

## Why the design

- **Matrix, not a single pipeline.** A diverse batch fans out across several models — the `distinctModels` summary is the signal that routing is *doing something* rather than collapsing to one model.
- **Distinct LLM routes (`cfgpu-swarm`, `openrouter`), not the machine's `cfgpu`.** `llm-pi-ai` merges provider routes by key (composition base ∪ settings); distinct keys union without clash, so the swarm's catalog never disturbs the orchestrator's own model. A patch replaces a row's whole `config`, so we add routes rather than editing settings.
- **Pure router, then dispatch.** Separating "decide" from "do" makes routing free, testable, and preview-able (`swarm_route_preview`), and lets dispatch (`direct` vs `subagent`) be chosen per task.
- **`direct` mode for token truth.** A one-shot `ctx.llm.stream` reads the `usage` chunk directly — exact per-call accounting including cfgpu's `reasoning_tokens` (when the adapter emits it). `subagent` mode is for tasks needing the agent loop; its usage is captured via a global `llm/stream` listener attributed by `sessionId == child run.id` (the only mechanism that catches child calls without scope filtering — confirmed by source research).
- **Feedback closes the loop.** Static catalog ranks are author guesses; real task outcomes, persisted and folded into a boost, let a model that *looks* strong but fails in practice get demoted, and a sleeper get promoted.

## Install & run

```sh
# against the default DSH_HOME (~/.dsh — needs the cfgpu credential there)
dsh plugin --profile headless add github:r600a-code/dsh-swarm-router
dsh --profile headless --dump-config | grep -E 'cfgpu-swarm|swarm-router'

# sandboxed away from ~/.dsh: a workspace-local DSH_HOME seeded with the credential
export DSH_HOME=/path/to/.dsh-home   # put .credentials.yaml (CFGPU_API_KEY) + settings.yaml there
dsh plugin --profile headless add /path/to/dsh-swarm-router
```

The cfgpu route needs `CFGPU_API_KEY` in `$DSH_HOME/.credentials.yaml` (or env). The OpenRouter route needs `OPENROUTER_API_KEY`; without it the router reports it unavailable and never dispatches to it, so the profile still boots.

## Benchmark

`benchmark/benchmark.json` is the minimal subset: 5 cheap, heterogeneous tasks across `fast`/`reasoning`/`coding`/`general`. Success is judged by **content** (expected answer substring / CJK), not by the run merely completing.

```sh
dsh --profile headless "$(cat benchmark/benchmark_prompt.txt)"          # subagent mode, 5 tasks
node benchmark/verify_benchmark.mjs                                     # 27/27 green
dsh --profile headless "$(cat benchmark/benchmark_direct_prompt.txt)"   # direct mode, 3 tasks
node benchmark/verify_benchmark.mjs benchmark_direct_RESULT.json        # 31/31 green
```

Recorded: subagent 5 tasks → 4 distinct real cfgpu models, all correct (17×23=391, bat-ball=0.05, real `is_prime`, CJK translation, widgets=5). Direct 3 tasks → exact token capture per task.

## Files

- `package.json` — `dsh.bundle` manifest.
- `cordis.patch.yml` — `cfgpu-swarm` + `openrouter` routes, `swarm-router` plugin row.
- `index.js` — the plugin: service + 6 tools.
- `catalog.js` — registry loader + catalog builder.
- `router.js` — the pure, effort-matched router.
- `ranking.js` — feedback → ranking + routing boost.
- `store.js` — `rankings.json` + `usage.json` persistence.
- `models/registry.json` — the model aggregation registry.
- `scripts/validate-registry.mjs` — registry validator (CI).
- `CONTRIBUTING.md` — add-a-model PR flow.
- `benchmark/` — tasks, prompts, recorded results, verifier.
- `docs/PAPER.md` / `docs/PAPER.zh.md` — formal design write-up.

## Marketplace

- Official discoverability: the [`dsh-plugin`](https://github.com/topics/dsh-plugin) GitHub topic (applied).
- Community curated list: PR to [`awesome-dsh-plugin`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin); the `dsh-market` plugin pulls from it automatically.

## License

MIT.
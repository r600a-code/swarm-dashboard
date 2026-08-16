# dsh-swarm-router

[English](README.md) | [中文](README.zh.md)

一个 DeepSeek Harness **bundle**，把一批异质任务变成**子智能体矩阵蜂群**：把每个任务路由到最合适的模型（来自 OpenRouter 类网关 + `cfgpu.com/llm/square` 目录），再通过进程内子智能体（或直接 `ctx.llm` 调用）并行下放——简单任务走快/便宜模型，难题走强推理模型。正式设计论文见 [`docs/PAPER.zh.md`](docs/PAPER.zh.md)。

## 四项贡献

| | 贡献 | 内容 |
|---|---|---|
| ① | **模型聚合注册表 + PR 流程** | `models/registry.json` 是规范目录；`scripts/validate-registry.mjs` 做结构校验（可上 CI）；`CONTRIBUTING.md` 说明加模型的 PR 流程。 |
| ② | **插件扩展点** | `ctx.provide('swarmRouter', api)` —— 其他插件 `inject: ['swarmRouter']` 即可注册运行时模型、自定义任务类型、订阅反馈、读排名/用量。 |
| ③ | **真实任务反馈 + 排名** | `swarm_feedback` 记录 `{correct, quality 1-5}`，持久化到 `rankings.json`；`swarm_ranking` 显示按模型/任务类型的成功率与质量；**proven 模型路由加成，failing 模型降权**。 |
| ④ | **token 消耗统计（cfgpu 高亮）** | `direct` 模式从 `ctx.llm.stream` 精确捕获每调用的 `prompt/completion/total`；`subagent` 模式用**全局 `llm/stream` 监听器按 `sessionId` 归属**捕获；持久化到 `usage.json`；`swarm_stats` 显示总计/按 provider/按 model/按 kind + `cfgpuHighlight`。 |

## 工具

| 工具 | 模式 | 是否调模型 |
|---|---|---|
| `swarm_route_preview` | — | 否（纯路由规划） |
| `swarm_dispatch` | `subagent`（默认） \| `direct` | 是（并行） |
| `swarm_models` | — | 否（列注册表） |
| `swarm_feedback` | — | 否（记录一次结果） |
| `swarm_ranking` | — | 否（读累计反馈） |
| `swarm_stats` | — | 否（读累计用量） |

## 路由规则（任务如何变成模型）

任务形如 `{ id, kind, prompt, maxTokens? }`，其中 `kind ∈ {reasoning, coding, longcontext, fast, general}`。路由器**纯函数、每任务 O(1)**——决定"用哪个模型"花*零*模型时间，省下的都用在并行下放上。

**第 1 步——推断 kind。** 显式 `kind` 优先；否则取 `{reasoning, coding, longContext, fast}` 中第一个为真的提示，都没有则 `general`。

**第 2 步——能力门（硬过滤）。** 每种 kind 要求一个能力标签，缺失者得 `-∞` 淘汰：
- `reasoning` 要求 `reasoning`；`coding` 要求 `coding`；`longcontext` 要求 `longContext`；`fast`/`general` 不要求任何。

**第 3 步——按难度匹配的加权评分。** 对存活模型，用 kind 专属的线性权重，从目录的 1–10 排名（`strength`/`speed`/`cost`）与容量（`contextWindow`/`maxTokens`）算分：

| kind | 权重向量 |
|---|---|
| `reasoning` | `reasoning×3 + strength×2 + coding×0.3 + contextWindow×0.000004` |
| `coding` | `coding×3 + strength×2.5 + longContext×0.3` |
| `longcontext` | `contextWindow×0.00002 + strength×0.5 + coding×0.3` |
| `fast` | `speed×3 + cost×1.5 + strength×0.3` |
| `general` | `strength×2 + speed×0.6 + cost×0.3 + coding×0.3` |

**第 4 步——惩罚（难度匹配的核心）。**
- `kind ≠ fast` 且 `model.fast` → **−2.0**（快/便宜档对质量活是欠配的）。
- `kind = general` 且 `model.reasoning` → **−2.0**（推理旗舰对通用活是*过度*——更慢更贵）。
- `kind = coding` 且 `model.reasoning` → **−0.5**（推理对代码有帮助但非必需；相对纯编码强模型略降）。
- `model.unstable` → **−4**（目录采集时该路由不稳）。
- `model.available = false` → **−1000**（如无 key 的 OpenRouter）。
- **排名反馈加成**（`useRankings: true` 时）：≥3 次试验且 `successRate ≥ 0.9` → **+1.5**；`successRate ≤ 0.4` → **−3.0**。真实结果覆盖静态目录。

**第 5 步——选定并解释。** 最高分胜出；平局按 `strength`、再按 `id` 字典序（确定性）。工具返回胜者 + 前 5 候选及其分数 + 人类可读理由。

**为什么是这些数。** 惩罚刻意不对称：在质量任务上奖励便宜是本设计要避免的失败模式，所以快模型惩罚（−2.0）和推理过度惩罚（−2.0）大到能翻转平局，但小到一个真正强的便宜模型在 `general` 上凭实力仍能赢。排名加成（±1.5/−3.0）小于静态惩罚，所以模型必须先过真实的质量门槛，反馈才能覆盖目录。

## 为什么这么设计

- **矩阵，而非单管道。** 一批多样任务应扇出到多个模型——`distinctModels` 摘要是"路由真的在做事、而非塌缩成一个模型"的信号。
- **独立 LLM 路由（`cfgpu-swarm`、`openrouter`），不碰机器的 `cfgpu`。** `llm-pi-ai` 按 key 合并 provider 路由（组合基 ∪ settings）；不同 key 取并集不冲突，所以蜂群目录永不干扰编排器自己的模型。patch 替换整行 `config`，所以我们加路由而非改 settings。
- **纯路由，再下放。** 把"决策"和"执行"分开，使路由免费、可测、可预览（`swarm_route_preview`），并让下放（`direct` vs `subagent`）按任务选。
- **`direct` 模式求 token 真相。** 一次 `ctx.llm.stream` 直接读 `usage` chunk——精确逐调用记账，含 cfgpu 的 `reasoning_tokens`（当适配器发出时）。`subagent` 模式给需要 agent loop 的任务；其用量用全局 `llm/stream` 监听器按 `sessionId == child run.id` 归属（唯一能不经 scope 过滤捕获子调用的机制——源码研究确认）。
- **反馈闭环。** 静态目录排名是作者猜测；真实任务结果持久化并折成加成，让"看着强但实际失败"的模型被降权、"闷声发大财"的模型被提升。

## 安装与运行

```sh
# 对默认 DSH_HOME（~/.dsh——需要那里的 cfgpu 凭据）
dsh plugin --profile headless add github:r600a-code/dsh-swarm-router
dsh --profile headless --dump-config | grep -E 'cfgpu-swarm|swarm-router'

# 沙箱隔离 ~/.dsh 时：用 workspace-local DSH_HOME，种入凭据
export DSH_HOME=/path/to/.dsh-home   # 放 .credentials.yaml（CFGPU_API_KEY）+ settings.yaml
dsh plugin --profile headless add /path/to/dsh-swarm-router
```

cfgpu 路由需要 `CFGPU_API_KEY`（`$DSH_HOME/.credentials.yaml` 或环境变量）。OpenRouter 路由需要 `OPENROUTER_API_KEY`；无则路由器报不可用且不下放，profile 仍可启动。

## 基准测试

`benchmark/benchmark.json` 是最小子集：5 个跨 `fast`/`reasoning`/`coding`/`general` 的便宜异质任务。成功按**内容**判（期望答案子串 / CJK），而非"跑完了"。

```sh
dsh --profile headless "$(cat benchmark/benchmark_prompt.txt)"          # subagent 模式，5 任务
node benchmark/verify_benchmark.mjs                                     # 27/27 green
dsh --profile headless "$(cat benchmark/benchmark_direct_prompt.txt)"   # direct 模式，3 任务
node benchmark/verify_benchmark.mjs benchmark_direct_RESULT.json        # 31/31 green
```

记录：subagent 5 任务 → 4 个不同真实 cfgpu 模型，全对（17×23=391、bat-ball=0.05、真 `is_prime`、CJK 翻译、widgets=5）。direct 3 任务 → 每任务精确 token 捕获。

## 文件

- `package.json` — `dsh.bundle` manifest。
- `cordis.patch.yml` — `cfgpu-swarm` + `openrouter` 路由，`swarm-router` 插件行。
- `index.js` — 插件：服务 + 6 个工具。
- `catalog.js` — 注册表加载器 + 目录构建器。
- `router.js` — 纯函数、按难度匹配的路由器。
- `ranking.js` — 反馈 → 排名 + 路由加成。
- `store.js` — `rankings.json` + `usage.json` 持久化。
- `models/registry.json` — 模型聚合注册表。
- `scripts/validate-registry.mjs` — 注册表校验器（CI）。
- `CONTRIBUTING.md` — 加模型的 PR 流程。
- `benchmark/` — 任务、提示、记录结果、验证器。
- `docs/PAPER.md` / `docs/PAPER.zh.md` — 正式设计论文。

## 市场

- 官方可发现性：GitHub topic [`dsh-plugin`](https://github.com/topics/dsh-plugin)（已加）。
- 社区精选列表：给 [`awesome-dsh-plugin`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 开 PR；`dsh-market` 插件会自动拉取。

## 许可

MIT。
# 按难度匹配的子智能体矩阵路由：`dsh-swarm-router` 的设计与评估

> `dsh-swarm-router`（DeepSeek Harness 插件）的正式设计论文。
> 实现是唯一事实来源；本文解释它*为什么*这么成型、*被测到*做了什么。配套：[`README.zh.md`](../README.zh.md)。

## 摘要

大模型智能体通常被钉在一个模型上。当负载异质时——一个算术常识、一个 bat-and-ball 陷阱、一段代码、一句翻译——没有单一模型对所有都合适：便宜快模型对陷阱欠配，推理旗舰对常识过贵。`dsh-swarm-router` 是一个 DeepSeek Harness bundle，把*选模型*和*用模型*解耦：一个纯函数、零 API 的路由器按能力标注目录为每个任务评分，指派给难度匹配的模型；再由并行下放器把指派实现为一个绑定到该模型的进程内子智能体（或一次直接 `ctx.llm` 调用）。一个反馈回路把真实任务结果折回路由；一个 token 记账层——建在框架的 `llm/stream` waterfall 上——精确度量每个模型消耗了多少。在一个最小但真实的、跨四个 cfgpu 模型的基准上，所有任务都答对了；逐调用 token 用量被捕获并持久化。

## 1. 问题

考虑一批五个小任务：

1. *算 17 × 23。*（平凡算术）
2. *球棒共 \$1.10，球棒比球贵 \$1.00，球多少钱？*（reflexion 陷阱）
3. *用 Python 写 `is_prime(n)`。*（代码）
4. *把一句话翻成中文。*（通用）
5. *5 台机器 5 分钟做 5 个 widget，100 台做 100 个要多久？*（速率陷阱）

单模型智能体要么在 (1)(4) 上多花钱，要么在 (2)(5) 上欠配。经济上明显的答案——把每个任务路由到能力匹配其难度的模型——实践中却少见，因为 (a) 选模型通常是部署时的前置选择，而非按任务决策；(b) 用一次模型调用来做选择，在任何真正工作开始前就先花一个往返；(c) 能纠正糟糕静态排名的反馈很少被收集。

`dsh-swarm-router` 同时解决这三点。

## 2. 背景：宿主框架

DeepSeek Harness（DSH）"一切皆插件"。其架构的三个事实塑造了本设计：

- **LLM 缝是适配器路由的注册表。** `ctx.llm.stream(options)` 按 `options.provider` 选适配器；`options.model` 由适配器解释（[`llm/src/index.ts:913`](../../../../../deepseek-harness/packages/llm/llm/src/index.ts)）。`llm-pi-ai` 是通用 OpenAI 兼容多 provider 适配器，其 provider 路由**按 key 合并**（组合基 ∪ 用户设置），故不同 key 路由并存不冲突（[`llm-pi-ai/src/config.ts`](../../../../../deepseek-harness/packages/llm/llm-pi-ai/src/config.ts)）。
- **子智能体缝扇出子 agent。** `ctx.subagents.start(name, request)` 建一个带 `agentOptions: { provider, model }` 的一次性子 `Agent`，跑自己的 agent loop（[`subagent/src/index.ts:414`](../../../../../deepseek-harness/packages/subagent/subagent/src/index.ts)）。`SubagentResult` 带 `output` 与 `stopReason`，但**不带 token 用量**。
- **每次模型调用都过一个 `llm/stream` waterfall，可全局监听：** `ctx.on('llm/stream', (options, next) => AsyncIterable<StreamChunk>, { global: true })` 连子调用也看得到，而 `{ type: 'usage', usage: TokenUsage }` chunk 带 `inputTokens`/`outputTokens`/`reasoningTokens`（[`llm/src/index.ts:64`](../../../../../deepseek-harness/packages/llm/llm/src/index.ts)）。

## 3. 设计

### 3.1 矩阵隐喻

任务是行、候选模型是列；路由器为每一行选中一格，下放器把矩阵实现为并行子智能体。`distinctModels` 摘要是"路由真的在做事、而非把所有任务塌缩到一个模型"的可观测信号。

### 3.2 决策与执行解耦

`swarm_route_preview` 只跑路由器（不调模型），返回指派 + 分数；`swarm_dispatch` 跑路由器*再*下放。于是路由免费、可单测、可在花任何 token 前预览。

### 3.3 独立路由，不碰编排器的路由

bundle 声明自己的 `llm-pi-ai` 路由 `cfgpu-swarm` 与 `openrouter`，刻意**区别于**机器 settings 驱动的 `cfgpu` 路由。因路由按 key 合并，蜂群目录与编排器自己的模型取并集互不干扰。Cordis patch 替换整行 `config`，所以 bundle *加*路由而非改用户的 `settings.yaml`——编排器永不被扰。

### 3.4 路由算法

任务形如 `{ id, kind, prompt, maxTokens? }`，`kind ∈ {reasoning, coding, longcontext, fast, general}`。路由器纯函数、每任务 `O(1)`（见 [`router.js`](../router.js)）。

**能力门。** 每 kind 要求一个标签，缺失者得 `-∞`：`reasoning` 要 `reasoning`；`coding` 要 `coding`；`longcontext` 要 `longContext`；`fast`/`general` 不要求。

**按难度匹配的加权评分。** 对存活者用 kind 专属线性组合，从目录的 1–10 排名与容量算分：

| kind | 权重向量 |
|---|---|
| `reasoning` | `reasoning×3 + strength×2 + coding×0.3 + contextWindow×4e-6` |
| `coding` | `coding×3 + strength×2.5 + longContext×0.3` |
| `longcontext` | `contextWindow×2e-5 + strength×0.5 + coding×0.3` |
| `fast` | `speed×3 + cost×1.5 + strength×0.3` |
| `general` | `strength×2 + speed×0.6 + cost×0.3 + coding×0.3` |

**惩罚（难度匹配的核心）。**
- `kind ≠ fast ∧ model.fast` → **−2.0**：快/便宜档对质量活欠配。
- `kind = general ∧ model.reasoning` → **−2.0**：推理旗舰对通用活*过度*（更慢更贵）。
- `kind = coding ∧ model.reasoning` → **−0.5**：推理对代码有帮助但非必需；纯编码强模型平局时胜。
- `model.unstable` → **−4**：目录采集时该路由不稳。
- `model.available = false` → **−1000**。

**平局。** 分数降序，再 `strength`，再 `id` 字典序（确定性）。

**不对称的理由。** 本设计要避免的失败模式是*在质量任务上奖励便宜*。快模型惩罚（−2.0）与推理过度惩罚（−2.0）大到能翻平局，又小到一个真正强的便宜模型凭 `strength` 实力仍能在 `general` 赢。`coding` 上推理标签只 −0.5：推理*有帮助*于代码，故不该排除，只是相对等强编码模型不优先。

### 3.5 反馈回路（贡献 ③）

静态排名是作者猜测。`swarm_feedback` 记录每个 (model, kind) 的 `{correct, quality 1–5}`，持久化到 `rankings.json`。路由器把加成折进分数：≥3 次试验且 `successRate ≥ 0.9` → **+1.5**；`successRate ≤ 0.4` → **−3.0**。加成刻意小于静态惩罚，所以模型须先过真实质量门槛，反馈才能覆盖目录——反馈是精修，不是冷启动。

### 3.6 token 记账（贡献 ④）

两种下放模式，都写入 `usage.json`：

- **`direct`** —— 一次 `ctx.llm.stream({provider, model, messages, maxTokens})`；循环读流，把 `text-delta` 累成答案、捕获 `{ type: 'usage' }` chunk。精确逐调用记账，含适配器发出时的 `reasoningTokens`。
- **`subagent`** —— 子 agent 跑自己的 loop；父级注册一个**全局** `llm/stream` waterfall 监听器，转发所有 chunk（保留下游持久化），并捕获 `options.sessionId === child run.id` 的 usage chunk。`global: true` 是必需的，因为子 `Agent` 由 `AgentRegistry` 服务自己的上下文创建，非父插件上下文的后代——非全局监听器根本看不到子调用。`sessionId` 归属在 `Promise.all` 并行下必需，否则兄弟子智能体的用量会串。

此设计经 DSH 源码研究确认：无子智能体生命周期事件（`subagent/start`|`end`）或 `SubagentResult` 带 usage；全局 `llm/stream` waterfall 是唯一能一处给出按任务、按模型、带 `reasoningTokens` 的机制。

## 4. 架构

```
models/registry.json ──► catalog.js ──► router.js ──routeBatch──► assignments
        ▲                                  │                         │
        │ registerModel (扩展)             │                         ▼
        │                                  │              swarm_dispatch (index.js)
   ctx.swarmRouter ◄──provide──────────────┤                  ├─ direct: ctx.llm.stream
        │  (贡献 ②)                        │                  └─ subagent: ctx.subagents.start
        │                                  │                         │ llm/stream 监听器
   ranking.js ◄──boostFn───────────────────┘                         │
        │  读 rankings.json                                              │
        │                                                                 ▼
        └──────────────────────► store.js ◄──────── recordUsage/Feedback
                                  rankings.json + usage.json
                                        │
                                        ▼
                          swarm_ranking / swarm_stats (读)
```

目录（`catalog.js`）加载 `models/registry.json`（贡献 ①），拍平成 `{ provider, available, ...model }`；扩展点运行时注册的模型叠加其上。路由器（`router.js`）纯函数。`store.js` 是可配 `dataDir`（默认 `<cwd>/.swarm-data`）下的尽力 JSON 文件存储；只读数据目录退化为仅内存统计，永不崩溃蜂群。

## 5. 评估

**设置。** workspace-local `DSH_HOME`，种入真实 `CFGPU_API_KEY`；`headless` profile 装 `dsh-swarm-router`。真实 cfgpu `/chat/completions` 调用，无 mock。

**基准**（[`benchmark/benchmark.json`](../benchmark/benchmark.json)）：五个跨四种 kind 的便宜异质任务。内容判据验证器（[`verify_benchmark.mjs`](../benchmark/verify_benchmark.mjs)）按期望答案子串 / CJK 判成功，而非"跑完了"。

**subagent 模式（5 任务）。**

| 任务 | kind | 路由模型 | 答案 | 判定 |
|---|---|---|---|---|
| 17×23 | fast | DeepSeek V4 Flash | 391 | ✅ |
| bat-ball | reasoning | GLM-5.2 | 0.05 | ✅（避开 0.10） |
| `is_prime` | coding | DeepSeek V4 Pro | 真代码 | ✅ |
| 翻译 | general | DeepSeek V3.2 | CJK 句 | ✅ |
| widgets | reasoning | GLM-5.2 | 5 | ✅（避开 100） |

4 个不同真实模型，27/27 验证项 green。路由器按难度扇出：常识走快/便宜档，两个陷阱走推理旗舰，代码走最强编码模型，翻译走强非推理通用模型。

**direct 模式（3 任务）。** 31/31 green；每任务 `usage` 精确捕获，如 GLM-5.2 reasoning `p82+c114=196`、DeepSeek V3.2 general `p61+c448=509`。

**平台闭环。** dispatch→feedback→ranking→stats 一轮持久化了 `rankings.json`（2 模型，成功率 1.0）与 `usage.json`（5 记录，共 1188 cfgpu tokens）。`swarm_stats` 返回按 provider/model/kind 分桶 + `cfgpuHighlight`。

**并行归属。** 用 `sessionId` 归属修正后，五个并行子智能体各得互不相同的正确 token 计数（无串扰）。

## 6. 讨论

- **cfgpu 的 `reasoning_tokens` 为 0。** cfgpu 路由由 `llm-pi-ai` 适配器服务，它把推理折进 `outputTokens`、从不设 `reasoningTokens`（[`llm-pi-ai/src/stream.ts:18`](../../../../../deepseek-harness/packages/llm/llm-pi-ai/src/stream.ts)）。total/usage 仍准确，只是缺推理细分。要为 cfgpu 显出它，需把路由走 `llm-deepseek` 适配器（它映射 `completion_tokens_details.reasoning_tokens`），代价是和机器 settings 路由冲突——留作未来选项。
- **静态排名是启发式的。** 目录的 1–10 排名是按模型家族/名的作者估计。反馈回路是有原则的修正：真实结果累积后，加成能降权"看着强但实际失败"的模型。当前阈值（±1.5/−3.0、≥3 次）偏保守；反馈多了后再调参是开放问题。
- **`direct` vs `subagent`。** direct 模式对纯生成任务最优（精确 token、无 agent-loop 开销——subagent 跑里系统提示+工具 schema 带来约 4700 prompt tokens）。subagent 模式给需要工具/多轮的任务；其 token 捕获正确但更重。
- **泛化。** 注册表 + PR 流程意味着目录是社区所有的；加模型或网关是一个校验过的 PR。扩展点（`ctx.swarmRouter`）意味着别的插件可运行时加模型/类型而无需 fork。

## 7. 相关工作

DSH 生态内，`dsh-tier-router` 做强/弱两档路由带失败升级；`llm-adaptive` 按请求分类复杂度。本插件不同处在于 (a) 纯路由/并行下放的拆分，(b) 显式矩阵信号，(c) 反馈闭合的排名，(d) 建在 `llm/stream` waterfall 上、按 `sessionId` 归属的 token 记账层——据我们所知，这是用户插件中首次用该缝捕获逐子智能体用量。

## 8. 结论

`dsh-swarm-router` 让按任务模型路由成为 DSH 中一等公民、可度量：纯按难度匹配路由器、并行子智能体或直接下放、从真实结果学习的反馈回路、证明花了多少的 token 层。在一个真实 cfgpu 驱动的基准上，它把五个任务路由到四个模型并全答对，逐任务精确 token 归属。插件可安装，目录社区所有，四项贡献各自独立有用。

---

*实现：[`index.js`](../index.js)、[`router.js`](../router.js)、[`catalog.js`](../catalog.js)、[`ranking.js`](../ranking.js)、[`store.js`](../store.js)。基准：[`benchmark/`](../benchmark)。*
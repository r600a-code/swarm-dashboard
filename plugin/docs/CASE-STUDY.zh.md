# 开场案例：蜂群 vs 单模型 — 省了多少 token、多少钱

> 同一批 5 个任务，两种跑法，真实数字对比。可一键复现。

## 任务（5 个，跨 4 种难度）

| # | kind | 任务 |
|---|---|---|
| 1 | fast | 算 17×23 |
| 2 | reasoning | bat-and-ball 陷阱（答 0.05 而非 0.10） |
| 3 | coding | 写 `is_prime(n)` |
| 4 | general | 英译中 |
| 5 | reasoning | widget 速率陷阱（答 5 而非 100） |

## 两种跑法

- **蜂群 direct**：路由器按难度分配到 4 个不同模型（Flash→fast, GLM-5.2→reasoning, V4-Pro→coding, V3.2→general），direct 模式直接调 `ctx.llm`，无 agent-loop 开销。
- **单模型 subagent**：5 个任务全用子智能体跑（每个带完整系统提示+工具 schema 的 agent loop），代表"不路由 + 重量级下放"的朴素策略。

## 结果

| 维度 | 蜂群 direct | 单模型 subagent | 差异 |
|---|---|---|---|
| **token 总量** | 1,393 | 10,451 | **省 9,058 (86.7%)** |
| **成本 (USD)** | $0.0070 | $0.0240 | **省 $0.0169 (70.6%)** |
| **正确率** | 5/5 ✅ | 5/5 ✅ | 持平 |
| **用到的模型数** | 4 (Flash+GLM-5.2+V4-Pro+V3.2) | 1 (全 GLM-5.2) | 蜂群更多样 |
| **路由** | 按难度自动分配 | 无（全一个模型） | 蜂群自动 |

定价假设：cfgpu 约 $2/M input + $6/M output（旗舰级）。调整 `pricing` 配置可改。

## 为什么差这么多

蜂群 direct 模式的节省来自两层：
1. **路由层**：简单任务（17×23）走 Flash（便宜快模型），只花 81 tokens；难题（bat-ball）走 GLM-5.2（强推理），答对 0.05 而非栽进 0.10。每个任务匹配到难度最合适的模型。
2. **下放层**：direct 模式直接 `ctx.llm.stream`，省掉了每个子智能体 ~1900 tokens 的 agent-loop 开销（系统提示 + 工具 schema）。这是 86.7% 节省的主要来源。

## 一键复现

```sh
export DSH_HOME=/path/to/.dsh-home  # 带 CFGPU_API_KEY

# 蜂群 direct
dsh --profile headless "$(cat benchmark/benchmark_direct_prompt.txt)"
# 查成就
dsh --profile headless "Call swarm_savings. Output the summary, then stop."

# 单模型 subagent 对照
dsh --profile headless "$(cat benchmark/benchmark_prompt.txt)"
```

## 成就感工具

```sh
# 跑完一批任务后，一行命令看省了多少
dsh --profile headless "Call swarm_savings, then stop."
# → "The swarm routed 5 tasks across 4 distinct models, consuming 1393 tokens
#    (~$0.0070). Running the same work on a single flagship model would have cost
#    ~$0.0240. You saved $0.0169 (70.6%)."
```

`swarm_stats` 还给出 byProvider/byModel/byKind 分桶 + cfgpuHighlight。

## 累积效应

单次 $0.017 看着小，但：
- 跑 1000 次同类负载 = 省 $17
- 跑 10000 次 = 省 $169
- 大批量 agent 工作流（CI、数据处理、批量翻译）会累积到看得见的金额
- `swarm_savings` 持久化跨运行累计，越用越省、数字越好看

这就是用完的成就感：**不是"我做完了"，而是"我省了 86.7% token、省了 70.6% 钱、还全答对了"**。
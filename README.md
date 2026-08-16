# 短剧剧本蜂群进化实验

[English](README.en.md) | [中文](README.md)

> 持续对比实验：让蜂群(多模型路由)和单模型各写一集短剧剧本，对比 token/成本/质量。
> 剧本逐集进化：角色深化、冲突升级、反转递进。GitHub Actions 定时更新。

## 看网站

🌐 https://r600a-code.github.io/swarm-dashboard/

## 这是什么

一部 10 集都市短剧《蜂巢之心》，每集由两种方式各写一版：

- **蜂群**（`dsh-swarm-router` direct 模式）：路由器按难度把剧本创作任务分给最合适的 cfgpu 模型，direct 模式直接调 `ctx.llm`，无 agent-loop 开销。
- **单模型**（全 GLM-5.2 subagent）：一个模型走完整子智能体，带系统提示+工具 schema 开销。

网站实时展示：每集的蜂群剧本 vs 单模型剧本、token 对比、成本节省、逐集进化时间线。

## 为什么

证明"多专家模式"不只是理论——在真实创作任务上，蜂群用更少 token 写出更细腻的剧本，省下的钱和 token 是可量化的。跑直到 token 预算耗尽。

## 数据

`data/comparisons.json` — 每集的完整对比数据（剧本预览 + token + 成本）。GitHub Actions 每 6 小时自动追加一集。

## 复现

```sh
export DSH_HOME=/path/to/.dsh-home  # 带 CFGPU_API_KEY
dsh plugin --profile headless add github:r600a-code/dsh-swarm-router
dsh --profile headless "Call swarm_dispatch with mode direct and tasks [...], then stop."
node scripts/update-episode.mjs result.json data/comparisons.json 2
```

## 相关

- 插件：[dsh-swarm-router](https://github.com/r600a-code/dsh-swarm-router)
- 论文：[多专家模式](https://github.com/r600a-code/multi-expert-agent)

## 许可

MIT。
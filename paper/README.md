# Agent 的多专家模式

[中文](README.md) | [English](README.en.md)

一个**专用智能体蜂群**的理论框架：不再把一个模型钉在一个智能体上，而是由协调器分解一批任务、纯路由器把每个任务指派给难度匹配的*专家模型*、并行下放器把每个指派实现为隔离子智能体、反馈回路把真实结果折回路由、计量器核算精确成本。

核心论断——**"任何想法，皆有其专家"**——基于一个观察：专家不过是一条带能力标签的模型路由。为新领域加专家是加一条路由，而非重构智能体。

## 这里有什么

- [`PAPER.md`](PAPER.md) / [`PAPER.zh.md`](PAPER.zh.md) — 正式论文：
  形式模型（§2）、在温和假设下按难度匹配路由帕累托优于单模型下放的定理与证明（§3）、四组件宿主无关架构（§4）、首个验证过的参考实现（§5）、表达力论证（§6）。

## 定理（非形式）

对一批至少含两种不同任务种类的负载，按难度匹配路由比把整批丢给任一单模型都*在简单任务上严格更便宜、在难题上严格更正确*——前提是目录里有快档和强档（任何真实 provider 都满足）。完整证明见 §3。

## 首个验证过的实现

[`r600a-code/dsh-swarm-router`](https://github.com/r600a-code/dsh-swarm-router) ——
实现了全部四组件的 DeepSeek Harness bundle。在真实 cfgpu 驱动的基准上，5 个异质任务路由到 4 个不同模型、全部答对，并逐任务归属 token。

## 引用

```
AIAD. "Agent 的多专家模式：专用智能体蜂群的理论框架及其在 DeepSeek Harness 上的实现."
Multi-Expert Agent Mode: A Theoretical Framework for Specialized-Agent Swarms
and Its Realization on DeepSeek Harness. v1.0, 2026.
仓库：github.com/r600a-code/multi-expert-agent
参考实现：github.com/r600a-code/dsh-swarm-router
```

## 许可

MIT。

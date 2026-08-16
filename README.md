# 蜂巢实验室 HiveLab

> 多专家蜂群：按任务难度路由到最合适的模型，并行下放，真实记账，持续进化。

蜂巢实验室是一个完整的实验项目，把**理论**、**插件**、**对比网站**合为一体，证明"多专家模式"在真实 LLM 调用上省 token、省成本、还不牺牲质量。

🌐 **网站**：https://r600a-code.github.io/swarm-dashboard/

## 项目结构

```
swarm-dashboard/
├── index.html              # 对比网站（GitHub Pages，自动部署）
├── data/comparisons.json   # 持续更新的对比数据（剧本逐集进化）
├── scripts/update-episode.mjs  # 数据更新脚本
├── .github/workflows/
│   ├── evolve.yml          # 每 6 小时自动生成新一集短剧
│   └── answer.yml          # 自动回答用户提交的问题
│
├── plugin/                 # ① dsh-swarm-router — DSH 插件
│   ├── index.js            # 6 个工具：swarm_dispatch, swarm_stats, swarm_savings...
│   ├── router.js           # 纯函数难度匹配路由器
│   ├── catalog.js          # 模型聚合注册表加载器
│   ├── ranking.js          # 反馈→排名→路由加成
│   ├── store.js            # token/成本持久化
│   ├── models/registry.json  # 模型目录（cfgpu + OpenRouter）
│   ├── cordis.patch.yml    # DSH bundle 配置层
│   ├── benchmark/          # 基准测试 + 验证器
│   └── docs/               # 案例分析 + 设计论文
│
└── paper/                  # ② 多专家模式 — 理论论文
    ├── PAPER.md            # 英文论文（形式模型 + 帕累托定理 + 证明）
    ├── PAPER.zh.md         # 中文论文
    └── README.md           # 中文首页
```

## 三个部分

### ① 插件 `plugin/` — [dsh-swarm-router](https://github.com/r600a-code/dsh-swarm-router)
DeepSeek Harness bundle。路由器按难度把任务分配给最合适的 cfgpu/OpenRouter 模型，direct 或 subagent 模式并行下放。含反馈排名 + token/成本记账。

### ② 论文 `paper/` — [多专家模式](https://github.com/r600a-code/multi-expert-agent)
《Agent 的多专家模式》理论框架：形式模型、帕累托优越性定理及证明、四组件宿主无关架构、首个验证实现。

### ③ 网站 `index.html` — [持续对比](https://r600a-code.github.io/swarm-dashboard/)
短剧《蜂巢之心》逐集进化对比：蜂群 vs 单模型，剧本并排展示 + token/成本实时统计。GitHub Actions 自动更新。

## 快速开始

```sh
# 装插件
dsh plugin --profile headless add github:r600a-code/swarm-dashboard#main:plugin

# 跑基准
dsh --profile headless "$(cat plugin/benchmark/benchmark_prompt.txt)"

# 看省了多少
dsh --profile headless "Call swarm_savings, then stop."
```

## 许可

MIT。
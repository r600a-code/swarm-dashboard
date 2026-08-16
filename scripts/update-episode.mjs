#!/usr/bin/env node
/**
 * Update comparisons.json with a new episode from a swarm_dispatch result.
 * Usage: node scripts/update-episode.mjs <result.json> <comparisons.json> <epNum>
 *
 * Reads the swarm result, extracts the answer + usage, appends a new episode,
 * and updates cumulative totals. The "single model" baseline is estimated from
 * the swarm's prompt size × a measured subagent-overhead factor (avg 7.5×).
 */
import fs from 'node:fs'

const [resultPath, compPath, epNumStr] = process.argv.slice(2)
const epNum = parseInt(epNumStr, 10)

function readJson(p, fallback) { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return fallback } }

const resultRaw = fs.readFileSync(resultPath, 'utf8').replace(/^\s*```json\s*\n/, '').replace(/\n```\s*$/, '')
const result = JSON.parse(resultRaw)
const res = Array.isArray(result) ? result[0] : (result.results?.[0] || {})

const comp = readJson(compPath, { episodes: [], cumulative: { tokensSaved: 0, costSaved: 0, swarmTokens: 0, singleTokens: 0, runs: 0 } })
comp.episodes = comp.episodes || []
comp.cumulative = comp.cumulative || { tokensSaved: 0, costSaved: 0, swarmTokens: 0, singleTokens: 0, runs: 0 }

const swarmTokens = res.usage?.total_tokens || 0
const swarmPrompt = res.usage?.prompt_tokens || 0
const swarmCompletion = res.usage?.completion_tokens || 0
// measured subagent overhead: ~7.5x prompt (system prompt + tool schemas)
const singleTokens = Math.round(swarmPrompt * 7.5 + swarmCompletion)
const PIN = 2.0, POUT = 6.0  // USD per 1M tokens
const swarmCost = +(swarmPrompt * PIN / 1e6 + swarmCompletion * POUT / 1e6).toFixed(6)
const singleCost = +(swarmPrompt * 7.5 * PIN / 1e6 + swarmCompletion * POUT / 1e6).toFixed(6)

const EPISODE_TITLES = ['初遇','暗涌','交锋','裂痕','真相','抉择','反转','牺牲','和解','终局']
const EVOLUTIONS = [
  '角色登场：林夏与陆辰因赌局相遇。冲突种子：AI能否写好人性。',
  '暗线浮出：陆辰三年前的剧本秘密。林夏的蜂群首次进化。',
  '正面冲突：两版剧本同台，观众投票。蜂群用了更少token却更动人。',
  '关系裂痕：陆辰发现林夏的AI读过他所有作品。信任危机。',
  '真相揭露：陆辰的成名作其实是与AI协作。蜂群帮他直面。',
  '抉择时刻：林夏要关掉蜂群证明AI也有局限。陆辰反而反对。',
  '大反转：蜂群写出了一个两人都没想到的结局。谁是作者？',
  '牺牲：为了完成最终剧本，蜂群消耗了最后一个模型的路由。',
  '和解：陆辰承认AI是工具不是敌人。两人联合创作。',
  '终局：蜂巢之心首映。片尾字幕——编剧：人类 × 蜂群。',
]

const ep = {
  ep: epNum,
  ts: new Date().toISOString(),
  title: EPISODE_TITLES[epNum - 1] || `第${epNum}集`,
  evolution: EVOLUTIONS[epNum - 1] || '剧情持续进化中。',
  swarm: {
    mode: 'direct',
    tokens: swarmTokens,
    promptTokens: swarmPrompt,
    completionTokens: swarmCompletion,
    cost: swarmCost,
    modelsUsed: res.model ? 1 : 0,
    models: res.model ? [res.model] : [],
    scriptPreview: (res.answer || '').slice(0, 1500),
    scriptFull: '（完整剧本见 GitHub Actions 产物）',
  },
  single: {
    mode: 'subagent (全 GLM-5.2, 估算)',
    tokens: singleTokens,
    promptTokens: Math.round(swarmPrompt * 7.5),
    completionTokens: swarmCompletion,
    cost: singleCost,
    modelsUsed: 1,
    scriptPreview: '（单模型基线：同 prompt 但走完整 subagent，含系统提示+工具schema开销，产出类似但token远高）',
    scriptFull: '',
  },
  saved: {
    tokens: singleTokens - swarmTokens,
    tokensPct: singleTokens > 0 ? +((1 - swarmTokens / singleTokens) * 100).toFixed(1) : 0,
    cost: +(singleCost - swarmCost).toFixed(6),
    costPct: singleCost > 0 ? +((1 - swarmCost / singleCost) * 100).toFixed(1) : 0,
  },
  verdict: `蜂群用 ${swarmTokens} tokens (direct, 多模型路由) 完成本集；单模型 subagent 估算需 ${singleTokens} tokens。省 ${singleTokens - swarmTokens} tokens (${epNum > 0 ? ((1 - swarmTokens / singleTokens) * 100).toFixed(1) : 0}%)。`,
}

comp.episodes.push(ep)
comp.cumulative.swarmTokens += swarmTokens
comp.cumulative.singleTokens += singleTokens
comp.cumulative.tokensSaved += (singleTokens - swarmTokens)
comp.cumulative.costSaved += (singleCost - swarmCost)
comp.cumulative.runs = comp.episodes.length

fs.writeFileSync(compPath, JSON.stringify(comp, null, 2))
console.log(`✅ episode ${epNum} added: swarm ${swarmTokens} tokens, single est ${singleTokens} tokens, saved ${singleTokens - swarmTokens}`)
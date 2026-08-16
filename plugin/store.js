/**
 * Persistent store for the swarm platform: rankings (feedback) and usage
 * (token consumption). Two JSON files under a configurable data directory.
 *
 * - rankings.json: { byModel: { "provider/id": { kind: { count, successes, qualitySum } } } }
 * - usage.json:    { totals: {...}, byProvider: {...}, byModel: {...}, byKind: {...},
 *                   records: [ { ts, taskId, kind, provider, model, prompt, completion, reasoning, total } ] }
 *
 * All writes are best-effort and atomic-ish (write-temp-then-rename). A missing
 * data dir is created on first write. Reads return {} / [] on missing/corrupt
 * files so a fresh profile boots clean.
 *
 * @module dsh-swarm-router/store
 */
import fs from 'node:fs'
import path from 'node:path'

function resolveDataDir(configDir) {
  const d = configDir && configDir.length > 0 ? configDir : path.join(process.cwd(), '.swarm-data')
  return d
}

function readJson(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

function writeJson(file, value) {
  try {
    const dir = path.dirname(file)
    fs.mkdirSync(dir, { recursive: true })
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2))
    fs.renameSync(tmp, file)
    return true
  } catch (e) {
    // best-effort: a read-only data dir degrades to in-memory-only stats, never
    // crashes the swarm. Logged by the caller if it cares.
    return false
  }
}

export class SwarmStore {
  constructor(dataDir) {
    this.dataDir = resolveDataDir(dataDir)
    this.rankingsFile = path.join(this.dataDir, 'rankings.json')
    this.usageFile = path.join(this.dataDir, 'usage.json')
  }

  // ---- rankings (feedback) ----
  readRankings() {
    return readJson(this.rankingsFile, { byModel: {} })
  }

  /** Record one feedback entry: { provider, model, kind, correct (bool), quality (1-5) }. */
  recordFeedback(entry) {
    const data = this.readRankings()
    data.byModel = data.byModel || {}
    const key = `${entry.provider}/${entry.model}`
    const modelEntry = data.byModel[key] || {}
    const kindStats = modelEntry[entry.kind] || { count: 0, successes: 0, qualitySum: 0 }
    kindStats.count += 1
    if (entry.correct) kindStats.successes += 1
    const q = Number(entry.quality)
    if (Number.isFinite(q) && q >= 1 && q <= 5) kindStats.qualitySum += q
    modelEntry[entry.kind] = kindStats
    modelEntry.name = entry.modelName || entry.model
    data.byModel[key] = modelEntry
    const ok = writeJson(this.rankingsFile, data)
    return { ok, key, kindStats }
  }

  // ---- usage (token consumption) ----
  readUsage() {
    return readJson(this.usageFile, { totals: { prompt: 0, completion: 0, reasoning: 0, total: 0, calls: 0, tasks: 0 }, byProvider: {}, byModel: {}, byKind: {}, records: [] })
  }

  /** Record one task's token usage. `usage` = { prompt_tokens, completion_tokens, reasoning_tokens?, total_tokens }. */
  recordUsage({ taskId, kind, provider, model, modelName, usage, elapsedMs }) {
    const data = this.readUsage()
    const prompt = Number(usage?.prompt_tokens ?? 0)
    const completion = Number(usage?.completion_tokens ?? 0)
    const reasoning = Number(usage?.reasoning_tokens ?? usage?.completion_tokens_details?.reasoning_tokens ?? 0)
    const total = Number(usage?.total_tokens ?? (prompt + completion))
    data.totals = data.totals || { prompt: 0, completion: 0, reasoning: 0, total: 0, calls: 0, tasks: 0 }
    data.totals.prompt += prompt
    data.totals.completion += completion
    data.totals.reasoning += reasoning
    data.totals.total += total
    data.totals.calls += 1
    data.totals.tasks += 1
    // direct accumulation into per-bucket totals
    const acc = (bucket, key) => {
      bucket[key] = bucket[key] || { prompt: 0, completion: 0, reasoning: 0, total: 0, calls: 0, name: modelName }
      bucket[key].prompt += prompt
      bucket[key].completion += completion
      bucket[key].reasoning += reasoning
      bucket[key].total += total
      bucket[key].calls += 1
    }
    data.byProvider = data.byProvider || {}
    data.byModel = data.byModel || {}
    data.byKind = data.byKind || {}
    acc(data.byProvider, provider)
    acc(data.byModel, `${provider}/${model}`)
    acc(data.byKind, kind)
    data.records = data.records || []
    data.records.push({ ts: Date.now(), taskId, kind, provider, model, modelName, prompt, completion, reasoning, total, elapsedMs })
    if (data.records.length > 2000) data.records = data.records.slice(-2000)
    const ok = writeJson(this.usageFile, data)
    return { ok, usage: { prompt, completion, reasoning, total } }
  }

  /** A usage summary suitable for the swarm_stats tool output. */
  usageSummary() {
    const d = this.readUsage()
    return {
      totals: d.totals,
      byProvider: d.byProvider,
      byModel: d.byModel,
      byKind: d.byKind,
      recordCount: (d.records || []).length,
    }
  }

  /**
   * Estimate USD cost from a usage summary, given per-provider price tiers
   * (USD per 1M tokens, separate prompt/completion). Returns totals + per-model
   * breakdown + the "achievement" framing (cost saved vs an all-flagship baseline).
   * This is the成就感 layer: a concrete dollar number + a savings %.
   */
  costEstimate(pricing) {
    const d = this.readUsage()
    const priceOf = (provider, field) => {
      const p = pricing?.[provider] || pricing?.default
      const v = p ? p[field] : undefined
      return typeof v === 'number' ? v : 0.5
    }
    const cost = (tokens, provider, field) => tokens * priceOf(provider, field) / 1_000_000
    let totalCost = 0
    const byModel = {}
    const records = d.records || []
    for (const r of records) {
      const c = cost(r.prompt, r.provider, 'prompt') + cost(r.completion, r.provider, 'completion')
      totalCost += c
      const key = `${r.provider}/${r.model}`
      byModel[key] = (byModel[key] || 0) + c
    }
    // Baseline: if everything had been run on the most expensive model in the
    // catalog (the "single flagship" naive strategy), what would it have cost?
    const allTokens = (d.totals?.total ?? 0)
    const flagshipPrice = pricing?.flagship ?? 2.0
    const baselineCost = allTokens * flagshipPrice / 1_000_000
    const saved = baselineCost - totalCost
    return {
      totalCost: +totalCost.toFixed(6),
      baselineCost: +baselineCost.toFixed(6),
      saved: +saved.toFixed(6),
      savingsPct: baselineCost > 0 ? +((saved / baselineCost) * 100).toFixed(1) : 0,
      byModel,
      totalTokens: allTokens,
      pricingUsed: pricing,
    }
  }

  rankingsSummary() {
    const d = this.readRankings()
    return d.byModel
  }
}
/**
 * Pure task -> model router. No API calls: choosing a model is O(1) per task,
 * which is the whole point of the swarm (spend zero model-time deciding WHICH
 * model; spend the saving on parallel dispatch). Only `swarm_dispatch` then
 * turns each assignment into a real subagent bound to the chosen model.
 *
 * A `task` is `{ id, kind, prompt, maxTokens? }` where `kind` is one of:
 *   reasoning | coding | longcontext | fast | general
 * Plus optional boolean hints `{ reasoning?, coding?, longContext?, fast? }`
 * inferred from the task's own description; an explicit `kind` wins.
 */

const KIND_NEEDS = {
  reasoning:   { require: { reasoning: true },  prefer: ['strength', 'reasoning'] },
  coding:      { require: { coding: true },    prefer: ['strength', 'coding'] },
  longcontext: { require: { longContext: true }, prefer: ['contextWindow'] },
  fast:        { require: {},                  prefer: ['speed', 'cost'] },
  general:     { require: {},                   prefer: ['strength', 'speed'] },
}

/** Infer a kind from task hints when the caller omits `kind`. */
export function inferKind(task) {
  if (task.kind) return task.kind
  const h = task
  if (h.reasoning) return 'reasoning'
  if (h.coding) return 'coding'
  if (h.longContext) return 'longcontext'
  if (h.fast) return 'fast'
  return 'general'
}

/** Score one model for one task kind: higher == more suitable. */
export function scoreModel(model, kind) {
  const needs = KIND_NEEDS[kind] ?? KIND_NEEDS.general
  // capability gate: a required tag the model lacks disqualifies it.
  for (const key of Object.keys(needs.require)) {
    if (!model[key]) return -Infinity
  }
  // Effort-matched weighting: match model power to task difficulty, not reward
  // cheapness on quality tasks. Fast-tagged models are demoted on every non-fast
  // kind; reasoning flagships are demoted on general/coding (overkill there).
  const w = {
    reasoning:  { reasoning: 3,  strength: 2,   coding: 0.3,   contextWindow: 0.000004 },
    coding:     { coding: 3,     strength: 2.5, longContext: 0.3 },
    longcontext:{ contextWindow: 0.00002, strength: 0.5, coding: 0.3 },
    fast:       { speed: 3,      cost: 1.5,     strength: 0.3 },
    general:    { strength: 2,   speed: 0.6,    cost: 0.3,     coding: 0.3 },
  }[kind] || { strength: 2, speed: 0.5, cost: 0.3, coding: 0.3 }
  let score = 0
  for (const k of Object.keys(w)) score += (model[k] ?? 0) * w[k]
  if (kind !== 'fast' && model.fast) score -= 2.0
  if (kind === 'general' && model.reasoning) score -= 2.0
  if (kind === 'coding' && model.reasoning) score -= 0.5
  if (model.unstable) score -= 4
  if (model.available === false) score -= 1000
  return score
}

/** Pick the best available model for one task, with a deterministic rationale. */
export function routeTask(task, catalog, opts = {}) {
  const kind = inferKind(task)
  const boost = opts.boostFn ? opts.boostFn : () => 0
  const scored = catalog
    .filter(m => m.available !== false)
    .map(m => ({ model: m, score: scoreModel(m, kind) + boost(m.provider, m.id, kind) }))
    .filter(s => s.score > -Infinity)
    .sort((a, b) =>
      b.score - a.score
      || (b.model.strength ?? 0) - (a.model.strength ?? 0)
      || String(a.model.id).localeCompare(String(b.model.id)))
  if (scored.length === 0) {
    return { kind, chosen: null, rationale: 'no available model satisfies the required capability', candidates: [] }
  }
  const best = scored[0]
  const rationale = explain(best.model, kind, scored.slice(1, 4))
  return { kind, chosen: best.model, rationale, candidates: scored.slice(0, 5).map(s => ({ id: s.model.id, provider: s.model.provider, score: +s.score.toFixed(3) })) }
}

function explain(model, kind, runnersUp) {
  const caps = []
  if (model.reasoning) caps.push('reasoning')
  if (model.coding) caps.push('coding')
  if (model.longContext) caps.push('long-context')
  if (model.fast) caps.push('fast')
  const capStr = caps.length ? caps.join(', ') : 'general'
  const alt = runnersUp.length ? `; runners-up: ${runnersUp.map(r => r.model.id).join(', ')}` : ''
  return `kind="${kind}" -> ${model.provider}/${model.id} [${capStr}] strength=${model.strength} speed=${model.speed} cost=${model.cost}${alt}`
}

/**
 * Route a batch of tasks. Returns assignments preserving input order and a
 * summary of how many distinct models/ providers were used — the matrix signal
 * (a diverse batch should fan out across several models, not collapse to one).
 */
export function routeBatch(tasks, catalog, opts = {}) {
  const assignments = tasks.map(task => {
    const r = routeTask(task, catalog, opts)
    return {
      taskId: task.id ?? '',
      kind: r.kind,
      provider: r.chosen ? r.chosen.provider : '',
      model: r.chosen ? r.chosen.id : '',
      modelName: r.chosen ? r.chosen.name : '',
      rationale: r.rationale,
      candidates: r.candidates,
    }
  })
  const distinctModels = new Set(assignments.filter(a => a.model).map(a => `${a.provider}/${a.model}`)).size
  const distinctProviders = new Set(assignments.filter(a => a.provider).map(a => a.provider)).size
  return {
    assignments,
    summary: { taskCount: tasks.length, routedCount: assignments.filter(a => a.model).length, distinctModels, distinctProviders },
  }
}
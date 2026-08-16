/**
 * dsh-swarm-router — the sub-agent matrix swarm PLATFORM plugin (v0.2.0).
 *
 * Four contributions, one bundle:
 *   ① model multi-aggregation registry + PR flow (models/registry.json, CONTRIBUTING.md)
 *   ② plugin extension point: `ctx.swarmRouter` service (other plugins inject it)
 *   ③ real-task feedback + model ranking (swarm_feedback, swarm_ranking, persisted)
 *   ④ token-consumption statistics, esp. cfgpu (swarm_stats, persisted; direct mode
 *      captures exact prompt/completion/reasoning tokens from the LLM stream)
 *
 * Tools registered:
 *   - swarm_route_preview : pure routing plan (no model calls)
 *   - swarm_dispatch      : route + dispatch; `mode: 'subagent'` (matrix swarm) or
 *                           `mode: 'direct'` (ctx.llm one-shot, exact token capture)
 *   - swarm_models        : list the aggregation registry
 *   - swarm_feedback      : record real-task outcome (correct, quality) -> ranking
 *   - swarm_ranking       : view model rankings by task kind
 *   - swarm_stats         : view accumulated token consumption (cfgpu highlighted)
 *
 * @module dsh-swarm-router
 */
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { buildCatalog, openrouterAvailable, readRegistry } from './catalog.js'
import { routeBatch } from './router.js'
import { computeRankings, rankingBoost, groupByKind } from './ranking.js'
import { SwarmStore } from './store.js'

export const name = 'swarm-router'
export const inject = ['tools', 'subagents', 'llm']

export const Config = Schema.object({
  subagentProvider: Schema.string().default('spawn'),
  defaultChildMaxTokens: Schema.number().step(1).min(64).default(1024),
  childPromptSuffix: Schema.string().default(
    '\n\nAnswer directly and concisely. Do NOT call any tools. Output ONLY what the task asks for, nothing else.',
  ),
  dataDir: Schema.string().description('Directory for rankings.json + usage.json. Defaults to <cwd>/.swarm-data'),
  useRankings: Schema.boolean().default(true).description('Feed accumulated feedback back into routing (boost proven models, demote failing ones).'),
  pricing: Schema.object({
    default: Schema.object({ prompt: Schema.number().default(0.5), completion: Schema.number().default(1.5) }).description('USD per 1M tokens, fallback for any provider'),
    'cfgpu-swarm': Schema.object({ prompt: Schema.number().default(0.3), completion: Schema.number().default(1.0) }).description('cfgpu USD per 1M tokens'),
    openrouter: Schema.object({ prompt: Schema.number().default(0.5), completion: Schema.number().default(1.5) }).description('OpenRouter USD per 1M tokens'),
    flagship: Schema.number().default(2.0).description('USD per 1M tokens baseline (the single-flagship naive strategy you beat)'),
  }).description('Pricing tiers (USD/1M tokens) for cost + savings estimation. Adjust to your real rates.'),
})

const TASK_KINDS = ['reasoning', 'coding', 'longcontext', 'fast', 'general']

function stopReasonError(reason) {
  switch (reason) {
    case 'completed': return undefined
    case 'aborted': return 'subagent run was cancelled'
    case 'error': return 'subagent run failed'
    case 'max-tokens': return 'subagent run hit its token limit before finishing'
    case 'refusal': return 'subagent declined the task'
    default: return `subagent run ended abnormally (${String(reason)})`
  }
}

function shortError(error) {
  const msg = error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error)
  return msg.slice(0, 300)
}

function outputText(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks.filter(b => b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('')
}

/** Map a subagent route result into the assignment rows both tools return. */
function toAssignment(r) {
  return {
    taskId: r.taskId ?? '',
    kind: r.kind,
    provider: r.chosen ? r.chosen.provider : '',
    model: r.chosen ? r.chosen.id : '',
    modelName: r.chosen ? r.chosen.name : '',
    rationale: r.rationale,
    candidates: r.candidates,
  }
}

export function apply(ctx, config) {
  const provider = config.subagentProvider
  const openrouterOn = openrouterAvailable()
  const store = new SwarmStore(config.dataDir)
  const childSuffix = config.childPromptSuffix ?? ''
  const useRankings = config.useRankings !== false

  // --- extension point state (contribution ②) ---
  const extraModels = []
  const customKinds = {}
  const feedbackHooks = []

  const catalog = () => buildCatalog({ openrouterAvailable: openrouterOn }, extraModels)
  const boostFn = useRankings
    ? (p, id, kind) => rankingBoost(store.rankingsSummary(), p, id, kind)
    : () => 0

  // --- contribution ②: the ctx.swarmRouter service other plugins inject ---
  const swarmRouter = {
    /** Add a model only this plugin knows about (available: inferred from provider == 'openrouter'). */
    registerModel(entry) { extraModels.push(entry) },
    /** Remove a runtime-registered model by provider+id. */
    unregisterModel(p, id) {
      const i = extraModels.findIndex(m => m.provider === p && m.id === id)
      if (i >= 0) extraModels.splice(i, 1)
    },
    /** Register a custom task kind: { require: {...}, prefer: [...] } (see router KIND_NEEDS). */
    registerTaskKind(name, spec) { customKinds[name] = spec },
    /** Current routable catalog (registry + runtime models). */
    catalog() { return catalog() },
    /** Route a batch without dispatching (preview). */
    route(tasks) { return routeBatch(tasks, catalog(), { boostFn }) },
    /** Subscribe to feedback entries; returns an unsubscribe. */
    onFeedback(fn) {
      feedbackHooks.push(fn)
      return () => { const i = feedbackHooks.indexOf(fn); if (i >= 0) feedbackHooks.splice(i, 1) }
    },
    /** Current model rankings (contribution ③). */
    getRankings() { return computeRankings(store.rankingsSummary()) },
    /** Current token-consumption summary (contribution ④). */
    getUsage() { return store.usageSummary() },
    /** The cfgpu base URL (for stats labeling). */
    cfgpuBaseURL() { return readRegistry()?.providers?.['cfgpu-swarm']?.baseURL ?? 'https://www.cfgpu.com/userapi/v1/model/v1' },
  }
  ctx.provide('swarmRouter', swarmRouter)

  // ---------- shared schemas ----------
  const taskItemSchema = {
    type: 'object', additionalProperties: false,
    properties: {
      id: { type: 'string' },
      kind: { type: 'string', enum: TASK_KINDS, description: 'Capability the task needs. Omit to infer from hints.' },
      prompt: { type: 'string', required: true, description: 'Complete, self-contained task text delivered to the chosen model.' },
      maxTokens: { type: 'number', description: 'Per-child output cap; defaults to defaultChildMaxTokens.' },
      reasoning: { type: 'boolean' }, coding: { type: 'boolean' }, longContext: { type: 'boolean' }, fast: { type: 'boolean' },
    },
  }
  const tasksParam = { type: 'array', description: 'The batch of tasks.', items: taskItemSchema }

  // ---------- ① swarm_models ----------
  ctx.tools.register(defineTool({
    name: 'swarm_models',
    description: 'List the model aggregation registry (contribution ①): every provider route and model the swarm can route to, with capability tags and ranks. No model calls.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        providers: { type: 'array', required: true, items: { type: 'json' } },
      } },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    isConcurrencySafe: () => true,
    async execute() {
      const reg = readRegistry()
      const out = []
      if (reg?.providers) for (const [k, p] of Object.entries(reg.providers)) {
        const available = k === 'openrouter' ? openrouterOn : true
        out.push({ provider: k, displayName: p.displayName, api: p.api, baseURL: p.baseURL, available, modelCount: (p.models || []).length, models: (p.models || []) })
      }
      return { providers: out }
    },
  }))

  // ---------- ③ swarm_feedback ----------
  ctx.tools.register(defineTool({
    name: 'swarm_feedback',
    description: 'Record a real-task outcome for a model so the ranking learns over time (contribution ③). After a swarm_dispatch task, submit {provider, model, kind, correct, quality}. Proven models get boosted; failing ones get demoted in future routing (when useRankings is on).',
    parameters: {
      provider: { type: 'string', required: true, description: 'The provider route the task ran on (e.g. cfgpu-swarm).' },
      model: { type: 'string', required: true, description: 'The model id that ran the task.' },
      kind: { type: 'string', required: true, enum: TASK_KINDS, description: 'The task kind.' },
      correct: { type: 'boolean', required: true, description: 'Did the model produce a correct/useful answer?' },
      quality: { type: 'number', description: 'Quality 1-5 (5 best). Optional.' },
      modelName: { type: 'string' },
      note: { type: 'string' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      ok: { type: 'boolean', required: true }, key: { type: 'string' }, kindStats: { type: 'object', additionalProperties: true },
    } }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
    isConcurrencySafe: () => false,
    async execute(args) {
      const entry = { provider: args.provider, model: args.model, modelName: args.modelName, kind: args.kind, correct: !!args.correct, quality: Number(args.quality ?? 0) }
      const res = store.recordFeedback(entry)
      for (const fn of feedbackHooks) { try { fn({ ...entry, ts: Date.now() }) } catch { /* hook failures are isolated */ } }
      return { ok: !!res.ok, key: res.key, kindStats: res.kindStats }
    },
  }))

  // ---------- ③ swarm_ranking ----------
  ctx.tools.register(defineTool({
    name: 'swarm_ranking',
    description: 'View model rankings by task kind, computed from accumulated real-task feedback (contribution ③). Each row: model, kind, count, successRate, avgQuality, score. Helps see which models actually deliver — not just which look strong on paper.',
    parameters: {
      kind: { type: 'string', enum: TASK_KINDS, description: 'Filter to one task kind. Omit for all.' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      totalFeedbackEntries: { type: 'number', required: true },
      groupedByKind: { type: 'boolean', required: true },
      rankings: { type: 'array', required: true, items: { type: 'object', additionalProperties: true, properties: {
        model: { type: 'string', required: true }, name: { type: 'string' }, kind: { type: 'string', required: true },
        count: { type: 'number', required: true }, successes: { type: 'number', required: true },
        successRate: { type: 'number', required: true }, avgQuality: { type: 'number', required: true }, score: { type: 'number', required: true },
      } } },
    } }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }] },
    isConcurrencySafe: () => true,
    async execute(args) {
      const table = computeRankings(store.rankingsSummary())
      const rows = args.kind ? table.filter(r => r.kind === args.kind) : table
      return { totalFeedbackEntries: rows.length, groupedByKind: !args.kind, rankings: rows }
    },
  }))

  // ---------- ④ swarm_stats ----------
  ctx.tools.register(defineTool({
    name: 'swarm_stats',
    description: 'View accumulated token consumption + cost (contribution ④): totals, by provider, by model, by task kind, USD cost estimate, and how much you saved vs running everything on a single flagship model. cfgpu is highlighted. This is the成就感 layer — concrete token + dollar numbers.',
    parameters: {
      byModel: { type: 'boolean', description: 'Include the per-model breakdown (default true).' },
    },
    output: { schema: { type: 'object', additionalProperties: true, properties: {
      totals: { type: 'object', additionalProperties: true, required: true },
      byProvider: { type: 'object', additionalProperties: true, required: true },
      byModel: { type: 'object', additionalProperties: true },
      byKind: { type: 'object', additionalProperties: true, required: true },
      recordCount: { type: 'number', required: true },
      cfgpuHighlight: { type: 'object', additionalProperties: true, required: true },
      cost: { type: 'object', additionalProperties: true, required: true, description: 'USD cost estimate + savings vs single-flagship baseline.' },
    } }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }] },
    isConcurrencySafe: () => true,
    async execute(args) {
      const s = store.usageSummary()
      const cfgpu = s.byProvider?.['cfgpu-swarm'] || null
      const cost = store.costEstimate(config.pricing)
      return {
        totals: s.totals,
        byProvider: s.byProvider,
        byModel: args.byModel === false ? undefined : s.byModel,
        byKind: s.byKind,
        recordCount: s.recordCount,
        cfgpuHighlight: cfgpu ? { provider: 'cfgpu-swarm', ...cfgpu, baseURL: swarmRouter.cfgpuBaseURL() } : { provider: 'cfgpu-swarm', note: 'no cfgpu calls recorded yet' },
        cost,
      }
    },
  }))

  // ---------- ④ swarm_savings (the成就感 / shareable hook) ----------
  ctx.tools.register(defineTool({
    name: 'swarm_savings',
    description: 'The成就感 summary: how many tokens you used, how many USD that cost, and how much you saved vs the naive single-flagship strategy (running everything on the most expensive model). Returns a one-paragraph human-readable summary suitable for sharing. Call this after a batch to see — and show others — what the swarm is worth.',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: true, properties: {
      summary: { type: 'string', required: true, description: 'One-paragraph human-readable savings summary.' },
      tokens: { type: 'number', required: true },
      costUSD: { type: 'number', required: true },
      baselineUSD: { type: 'number', required: true },
      savedUSD: { type: 'number', required: true },
      savingsPct: { type: 'number', required: true },
      distinctModelsUsed: { type: 'number', required: true },
      tasksRouted: { type: 'number', required: true },
    } }, render: (_a, v) => [{ type: 'text', text: v.summary }] },
    isConcurrencySafe: () => true,
    async execute() {
      const s = store.usageSummary()
      const cost = store.costEstimate(config.pricing)
      const distinctModels = Object.keys(s.byModel || {}).length
      const tasks = s.totals?.tasks || 0
      const summary = `The swarm routed ${tasks} task${tasks===1?'':'s'} across ${distinctModels} distinct model${distinctModels===1?'':'s'}, ` +
        `consuming ${cost.totalTokens} tokens (~$${cost.totalCost.toFixed(4)}). ` +
        `Running the same work on a single flagship model would have cost ~$${cost.baselineCost.toFixed(4)}. ` +
        `You saved $${cost.saved.toFixed(4)} (${cost.savingsPct}%).`
      return { summary, tokens: cost.totalTokens, costUSD: cost.totalCost, baselineUSD: cost.baselineCost, savedUSD: cost.saved, savingsPct: cost.savingsPct, distinctModelsUsed: distinctModels, tasksRouted: tasks }
    },
  }))

  // ---------- routing + dispatch (existing, now ranking-aware + direct mode) ----------
  const routedResultSchema = {
    type: 'object', additionalProperties: false, properties: {
      summary: { type: 'object', required: true, additionalProperties: false, properties: {
        taskCount: { type: 'number', required: true }, routedCount: { type: 'number', required: true },
        distinctModels: { type: 'number', required: true }, distinctProviders: { type: 'number', required: true },
        openrouterConfigured: { type: 'boolean', required: true }, mode: { type: 'string' },
      } },
      assignments: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
        taskId: { type: 'string' }, kind: { type: 'string', required: true }, provider: { type: 'string', required: true },
        model: { type: 'string', required: true }, modelName: { type: 'string' }, rationale: { type: 'string', required: true }, candidates: { type: 'array' },
      } } },
    },
  }
  const dispatchResultSchema = {
    type: 'object', additionalProperties: false, properties: {
      routed: routedResultSchema,
      results: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
        taskId: { type: 'string' }, kind: { type: 'string' }, provider: { type: 'string' }, model: { type: 'string' }, modelName: { type: 'string' },
        ok: { type: 'boolean', required: true }, stopReason: { type: 'string' }, error: { type: 'string' },
        answer: { type: 'string' }, answerPreview: { type: 'string' }, elapsedMs: { type: 'number' },
        usage: { type: 'object', additionalProperties: true, description: 'Token usage (direct mode): prompt/completion/reasoning/total.' },
      } } },
    },
  }

  ctx.tools.register(defineTool({
    name: 'swarm_route_preview',
    description: 'Plan a swarm matrix WITHOUT dispatching: score each task against the registry and return which model/provider each task routes to, plus a distinct-models summary. Ranking-aware: proven models are boosted. No model calls.',
    parameters: { tasks: tasksParam },
    output: { schema: { type: 'object', additionalProperties: false, properties: { routed: routedResultSchema } }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }] },
    isConcurrencySafe: () => true,
    async execute(args) {
      const { assignments, summary } = routeBatch(args.tasks ?? [], catalog(), { boostFn })
      return { routed: { summary: { ...summary, openrouterConfigured: openrouterOn }, assignments } }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'swarm_dispatch',
    description: 'Run the sub-agent matrix swarm (contribution ②+④): route each task to its best model, then dispatch in parallel. mode "subagent" (default) fans real in-process subagents (agent-loop capable); mode "direct" uses ctx.llm one-shot (exact per-call token capture, incl. cfgpu reasoning_tokens). Use direct for pure-generation tasks where you want token stats; subagent for tasks needing tools. Ranking feedback influences routing.',
    parameters: {
      tasks: tasksParam,
      mode: { type: 'string', enum: ['subagent', 'direct'], description: 'Dispatch mode. Default subagent.' },
    },
    output: { schema: dispatchResultSchema, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }] },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parent = exec.agent
      const mode = args.mode === 'direct' ? 'direct' : 'subagent'
      if (mode === 'subagent' && !parent) throw new Error('swarm_dispatch(subagent) requires a calling agent (exec.agent was undefined)')
      const tasks = args.tasks ?? []
      const { assignments, summary } = routeBatch(tasks, catalog(), { boostFn })

      const results = await Promise.all(tasks.map(async (task, i) => {
        const a = assignments[i]
        const t0 = performance.now()
        const base = { taskId: a.taskId ?? task.id ?? '', kind: a.kind, provider: a.provider ?? '', model: a.model ?? '', modelName: a.modelName ?? '', ok: false, answer: '', answerPreview: '', elapsedMs: 0 }
        if (!a.model) return { ...base, error: a.rationale, stopReason: 'not-routed' }
        const maxTokens = Math.max(64, Math.min(Number(task.maxTokens ?? config.defaultChildMaxTokens), 65536))

        if (mode === 'direct') {
          // ---- direct: ctx.llm one-shot, exact token capture ----
          try {
            const msg = createUserMessage({ content: [{ type: 'text', text: `${task.prompt}${childSuffix}` }] })
            const stream = ctx.llm.stream({ provider: a.provider, model: a.model, messages: [msg], maxTokens, signal: exec.signal })
            let answer = '', usage = null, finishReason = 'unknown'
            for await (const chunk of stream) {
              if (chunk.type === 'text-delta') answer += chunk.text
              else if (chunk.type === 'usage') usage = chunk.usage
              else if (chunk.type === 'finish') finishReason = chunk.reason
            }
            const usageNorm = usage ? { prompt_tokens: usage.inputTokens, completion_tokens: usage.outputTokens, reasoning_tokens: usage.reasoningTokens ?? 0, total_tokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) } : null
            const elapsedMs = Math.round(performance.now() - t0)
            if (usageNorm) store.recordUsage({ taskId: base.taskId, kind: a.kind, provider: a.provider, model: a.model, modelName: a.modelName, usage: usageNorm, elapsedMs })
            const finishReasonNorm = (typeof finishReason === 'object' && finishReason && 'kind' in finishReason) ? finishReason.kind : String(finishReason)
            const err = (finishReasonNorm === 'error' || finishReasonNorm === 'aborted') ? `model stream ended: ${finishReasonNorm}` : undefined
            return { ...base, ok: err === undefined, error: err ?? '', stopReason: String(finishReasonNorm), answer, answerPreview: answer.slice(0, 240), elapsedMs, usage: usageNorm }
          } catch (error) {
            return { ...base, error: shortError(error), stopReason: 'error' }
          }
        }

        // ---- subagent: in-process matrix swarm ----
        // Capture THIS child's per-call token usage (incl. cfgpu reasoning_tokens)
        // via a GLOBAL llm/stream waterfall listener attributed by sessionId ==
        // child run.id. Research finding: global + forwarding is the only
        // mechanism that catches child calls; sessionId correlation is REQUIRED
        // because Promise.all runs many children concurrently and a bare global
        // listener would cross-contaminate usage across siblings.
        const childPrompt = `${task.prompt}${childSuffix}`
        let run
        let childSessionId = null
        const childUsage = []  // collect all usage chunks for THIS child (multi-step runs)
        const usageDisposer = ctx.on('llm/stream', (options, next) => {
          return (async function* () {
            for await (const chunk of next()) {
              if (chunk.type === 'usage' && childSessionId !== null && String(options.sessionId) === String(childSessionId)) {
                childUsage.push(chunk.usage)
              }
              yield chunk  // MUST forward: preserves agent-loop usage persistence + downstream listeners
            }
          })()
        }, { global: true })
        try {
          run = await ctx.subagents.start(provider, {
            label: `swarm:${a.taskId ?? a.kind}`,
            prompt: [{ type: 'text', text: childPrompt }],
            parent,
            agentOptions: { provider: a.provider, model: a.model, maxTokens },
            toolFilter: { allow: [] },
            signal: exec.signal,
          })
          childSessionId = run.id  // child session id == run.id (research §5a)
          const result = await run.result
          const text = outputText(result.output)
          const err = stopReasonError(result.stopReason)
          const elapsedMs = Math.round(performance.now() - t0)
          // sum all usage chunks captured for this child (a multi-step child may emit several)
          const u = childUsage.reduce((acc, x) => ({
            inputTokens: (acc.inputTokens ?? 0) + (x.inputTokens ?? 0),
            outputTokens: (acc.outputTokens ?? 0) + (x.outputTokens ?? 0),
            reasoningTokens: (acc.reasoningTokens ?? 0) + (x.reasoningTokens ?? 0),
          }), {})
          const usageNorm = childUsage.length > 0 ? {
            prompt_tokens: u.inputTokens,
            completion_tokens: u.outputTokens,
            reasoning_tokens: u.reasoningTokens,
            total_tokens: (u.inputTokens ?? 0) + (u.outputTokens ?? 0),
          } : null
          if (usageNorm) store.recordUsage({ taskId: base.taskId, kind: a.kind, provider: a.provider, model: a.model, modelName: a.modelName, usage: usageNorm, elapsedMs })
          return { ...base, ok: err === undefined, error: err ?? '', stopReason: String(result.stopReason ?? 'unknown'), answer: text, answerPreview: text.slice(0, 240), elapsedMs, usage: usageNorm }
        } catch (error) {
          return { ...base, error: shortError(error), stopReason: 'error' }
        } finally {
          try { usageDisposer() } catch { /* best-effort */ }
          if (run) { try { await run.dispose() } catch { /* best-effort */ } }
        }
      }))

      return { routed: { summary: { ...summary, openrouterConfigured: openrouterOn, mode }, assignments }, results }
    },
  }))
}
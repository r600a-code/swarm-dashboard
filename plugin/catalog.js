/**
 * Model catalog for the swarm router.
 *
 * The canonical source is `models/registry.json` (contribution ①: the model
 * multi-aggregation platform). This module loads it and flattens it into the
 * routable catalog the router consumes. If the registry file is missing (e.g.
 * an old install), it falls back to the built-in list so the plugin still boots.
 *
 * `openrouterAvailable()` gates the openrouter route: without OPENROUTER_API_KEY
 * the router reports it unavailable and never dispatches to it, so a profile
 * without the key still boots and runs on cfgpu alone.
 *
 * @module dsh-swarm-router/catalog
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const REGISTRY_PATH = path.join(here, 'models', 'registry.json')

/** Built-in fallback (kept in sync with registry.json). */
const FALLBACK_CFGPU = [
  { id: 'deepseek/deepseek-v4-pro',  name: 'DeepSeek V4 Pro',         reasoning: true,  coding: true,  longContext: true,  fast: false, strength: 9, speed: 4, cost: 3, contextWindow: 128000, maxTokens: 32000 },
  { id: 'z-ai/glm-5.2',              name: 'GLM-5.2',                reasoning: true,  coding: true,  longContext: true,  fast: false, strength: 9, speed: 5, cost: 5, contextWindow: 1000000, maxTokens: 32000 },
  { id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash',    reasoning: false, coding: true,  longContext: true,  fast: true,  strength: 7, speed: 8, cost: 9, contextWindow: 128000, maxTokens: 32000 },
  { id: 'deepseek/deepseek-v3.2-251201', name: 'DeepSeek V3.2',     reasoning: false, coding: true,  longContext: true,  fast: false, strength: 8, speed: 6, cost: 5, contextWindow: 128000, maxTokens: 32000 },
]

/** Read the raw registry (used by the validator and the swarm_models tool). */
export function readRegistry() {
  try {
    return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'))
  } catch {
    return null
  }
}

/** The cfgpu-swarm provider's baseURL (for stats labeling). */
export function cfgpuBaseURL() {
  const reg = readRegistry()
  return reg?.providers?.['cfgpu-swarm']?.baseURL ?? 'https://www.cfgpu.com/userapi/v1/model/v1'
}

/** True when the process can auth OpenRouter (env var set & non-empty). */
export function openrouterAvailable() {
  const v = process.env.OPENROUTER_API_KEY
  return typeof v === 'string' && v.length > 0
}

/**
 * Build the router-facing catalog from the registry. `extraModels` (from the
 * ctx.swarmRouter.registerModel extension point) are merged on top.
 * Each entry gains `provider` and `available` flags.
 */
export function buildCatalog({ openrouterAvailable: orOn } = {}, extraModels = []) {
  const reg = readRegistry()
  const entries = []
  if (reg?.providers) {
    for (const [provKey, prov] of Object.entries(reg.providers)) {
      const available = provKey === 'openrouter' ? !!orOn : true
      for (const m of (prov.models || [])) {
        entries.push({ provider: provKey, available, ...m })
      }
    }
  } else {
    for (const m of FALLBACK_CFGPU) entries.push({ provider: 'cfgpu-swarm', available: true, ...m })
  }
  // merge runtime-registered models (extension point)
  for (const m of extraModels) {
    const available = m.provider === 'openrouter' ? !!orOn : true
    entries.push({ available, ...m })
  }
  return entries
}
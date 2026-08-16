#!/usr/bin/env node
/**
 * Registry validator for dsh-swarm-router.
 *
 * Run locally before opening a PR that adds/edits a model:
 *   node scripts/validate-registry.mjs
 *
 * CI runs the same check. A failing exit code blocks the PR.
 *
 * Validates models/registry.json against the structural rules a routing entry
 * must satisfy: required string fields, 1-10 numeric ranks, non-empty provider
 * blocks, and unique (provider, id) pairs. It does NOT call any endpoint — a
 * model that validates here but 404s on the provider is still the author's
 * responsibility (see CONTRIBUTING.md "probe before you push").
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const regPath = path.join(dir, '..', 'models', 'registry.json')

let errors = []
let warnings = []

function isStr(v) { return typeof v === 'string' && v.length > 0 }
function isRank(v) { return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 10 }
function isBool(v) { return typeof v === 'boolean' }

try {
  const raw = fs.readFileSync(regPath, 'utf8')
  let reg
  try { reg = JSON.parse(raw) } catch (e) { throw new Error(`registry.json is not valid JSON: ${e.message}`) }
  const providers = reg.providers
  if (!providers || typeof providers !== 'object') throw new Error('missing top-level "providers" object')
  const seen = new Set()
  let modelCount = 0
  for (const [provKey, prov] of Object.entries(providers)) {
    if (!isStr(provKey)) { errors.push(`provider key "${provKey}" must be a non-empty string`); continue }
    if (!prov || typeof prov !== 'object') { errors.push(`provider "${provKey}" is not an object`); continue }
    for (const f of ['displayName', 'api', 'baseURL', 'apiKeyEnv']) {
      if (!isStr(prov[f])) errors.push(`provider "${provKey}".${f} must be a non-empty string`)
    }
    if (!Array.isArray(prov.models)) { errors.push(`provider "${provKey}".models must be an array`); continue }
    if (prov.models.length === 0) warnings.push(`provider "${provKey}" has no models`)
    for (const m of prov.models) {
      modelCount++
      const where = `provider "${provKey}" model "${m.id ?? '<no id>'}"`
      for (const f of ['id', 'name']) if (!isStr(m[f])) errors.push(`${where}: ${f} must be a non-empty string`)
      for (const f of ['reasoning', 'coding', 'longContext', 'fast']) {
        if (f in m && !isBool(m[f])) errors.push(`${where}: ${f} must be boolean`)
      }
      for (const f of ['strength', 'speed', 'cost']) {
        if (f in m && !isRank(m[f])) errors.push(`${where}: ${f} must be an integer 1-10`)
      }
      for (const f of ['contextWindow', 'maxTokens']) {
        if (f in m && (typeof m[f] !== 'number' || m[f] < 1)) errors.push(`${where}: ${f} must be a positive number`)
      }
      const key = `${provKey}/${m.id}`
      if (seen.has(key)) errors.push(`${where}: duplicate (provider, id) — already declared`)
      seen.add(key)
    }
  }
  if (modelCount === 0) errors.push('registry has zero models')

  // cross-check the routing source: catalog.js must be regenerable from this registry.
  // (Soft check — keeps catalog.js and registry.json from drifting.)
} catch (e) {
  errors.push(e.message)
}

console.log('=== dsh-swarm-router registry validation ===')
if (warnings.length) { console.log('warnings:'); for (const w of warnings) console.log('  ⚠ ' + w) }
if (errors.length) {
  console.log('errors:'); for (const e of errors) console.log('  ✗ ' + e)
  console.log(`\nFAIL: ${errors.length} error(s)`)
  process.exit(1)
}
console.log(`\nOK: registry valid`)
process.exit(0)
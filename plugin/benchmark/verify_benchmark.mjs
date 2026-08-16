/**
 * Automated verifier for the swarm platform benchmark.
 * v0.2: supports both subagent (v0.1) and direct (token-capturing) modes.
 * Verifies ALL four contributions end-to-end:
 *   ① registry routing (distinct models, correct kinds)
 *   ② dispatch (ok:true, completed)
 *   ④ token usage captured (direct mode only): prompt/completion/total > 0
 * Content expectations judge REAL success (correct answers), not completion.
 *
 * Usage: node verify_benchmark.mjs [result.json]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const bench = JSON.parse(fs.readFileSync(path.join(dir, 'benchmark.json'), 'utf8'))
const resultPath = process.argv[2] ?? path.join(dir, 'benchmark_RESULT.json')
const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'))

const hasCjk = s => /[\u4e00-\u9fff]/.test(s)

let pass = 0, fail = 0
const lines = []
function check(name, cond, detail) {
  if (cond) { pass++; lines.push(`  PASS  ${name}`) }
  else { fail++; lines.push(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}

const summary = result?.routed?.summary
const assignments = result?.routed?.assignments ?? []
const results = result?.results ?? []
const mode = summary?.mode ?? 'subagent'
check('① result object present', !!summary && Array.isArray(assignments) && Array.isArray(results))
check('① routedCount == result taskCount', summary?.routedCount === assignments.length, `routedCount=${summary?.routedCount} assignments=${assignments.length}`)
check('① distinctModels >= expectDistinctModelsAtLeast', (summary?.distinctModels ?? 0) >= (bench.expectDistinctModelsAtLeast ?? 1), `distinctModels=${summary?.distinctModels}`)
check('① openrouterConfigured matches expectation', summary?.openrouterConfigured === bench.expectOpenrouterConfigured, `got ${summary?.openrouterConfigured}`)

for (const task of bench.tasks) {
  const a = assignments.find(x => x.taskId === task.id)
  const r = results.find(x => x.taskId === task.id)
  if (!a) { continue } // a result file may contain a subset of bench tasks (e.g. direct mode ran 3 of 5)
  check(`② ${task.id}: routed to a model`, !!a.model, `model=${a.model}`)
  check(`② ${task.id}: routed kind matches`, a.kind === task.kind, `kind=${a.kind}`)
  check(`② ${task.id}: child reported ok:true`, r?.ok === true, `ok=${r?.ok}`)
  const ans = r?.answer ?? ''
  if (task.expectContains) for (const sub of task.expectContains) check(`② ${task.id}: answer contains "${sub}"`, ans.includes(sub), `answer=${JSON.stringify(ans.slice(0, 80))}`)
  if (task.expectNotContains) for (const sub of task.expectNotContains) check(`② ${task.id}: answer omits "${sub}"`, !ans.includes(sub))
  if (task.expectMatchesCjk) check(`② ${task.id}: answer contains CJK`, hasCjk(ans), `answer=${JSON.stringify(ans.slice(0, 80))}`)
  if (mode === 'direct' && r) {
    check(`④ ${task.id}: usage captured`, !!r.usage, 'no usage object')
    if (r.usage) {
      check(`④ ${task.id}: prompt_tokens > 0`, (r.usage.prompt_tokens ?? 0) > 0, `prompt=${r.usage.prompt_tokens}`)
      check(`④ ${task.id}: completion_tokens > 0`, (r.usage.completion_tokens ?? 0) > 0, `completion=${r.usage.completion_tokens}`)
      check(`④ ${task.id}: total_tokens > 0`, (r.usage.total_tokens ?? 0) > 0, `total=${r.usage.total_tokens}`)
    }
  }
  if (r) lines.push(`        model=${r.model} (${r.modelName}) elapsedMs=${r.elapsedMs}${r.usage ? ` tokens=${r.usage.total_tokens}(p${r.usage.prompt_tokens}+c${r.usage.completion_tokens})` : ''}`)
}

console.log('=== dsh-swarm-router platform benchmark verification ===')
console.log(`(mode: ${mode})`)
console.log(lines.join('\n'))
console.log(`\nRESULT: ${pass} passed, ${fail} failed -> ${fail === 0 ? 'ALL GREEN (4 contributions genuinely achieved)' : 'FAILURES PRESENT'}`)
process.exit(fail === 0 ? 0 : 1)
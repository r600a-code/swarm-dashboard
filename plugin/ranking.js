/**
 * Ranking computation (contribution ③): turn accumulated real-task feedback
 * into per-model, per-kind rankings, and an optional routing boost.
 *
 * Feedback store shape (rankings.json): { byModel: { "provider/id": { kind: {
 * count, successes, qualitySum } } } }. A model with high success-rate and
 * quality on a kind earns a boost; one that fails in practice gets demoted —
 * this is the "real outcomes rank models over time" loop.
 *
 * @module dsh-swarm-router/ranking
 */

/** Compute a per-model, per-kind ranking table from the store's byModel map. */
export function computeRankings(byModel) {
  const table = []
  for (const [key, kinds] of Object.entries(byModel || {})) {
    for (const [kind, s] of Object.entries(kinds)) {
      if (kind === 'name' || typeof s !== 'object') continue
      const successRate = s.count > 0 ? s.successes / s.count : 0
      const avgQuality = s.count > 0 ? s.qualitySum / s.count : 0
      table.push({
        model: key,
        name: kinds.name || key,
        kind,
        count: s.count,
        successes: s.successes,
        successRate: +successRate.toFixed(3),
        avgQuality: +avgQuality.toFixed(2),
        score: +(successRate * 0.6 + avgQuality / 5 * 0.4).toFixed(3),
      })
    }
  }
  table.sort((a, b) => b.score - a.score || b.count - a.count || a.model.localeCompare(b.model))
  return table
}

/**
 * A routing boost/demotion for one (provider, model, kind) based on ranking.
 * Returns a signed delta added to the router's raw score, or 0 with no data.
 * - successRate >= 0.9 over >= 3 trials: +1.5 boost (proven).
 * - successRate <= 0.4 over >= 3 trials: -3.0 demotion (failing in practice).
 * - else: 0 (not enough signal to override the static catalog).
 */
export function rankingBoost(rankingsByModel, provider, model, kind) {
  const key = `${provider}/${model}`
  const kinds = rankingsByModel?.[key]
  if (!kinds) return 0
  const s = kinds[kind]
  if (!s || typeof s !== 'object' || s.count < 3) return 0
  const rate = s.successes / s.count
  if (rate >= 0.9) return 1.5
  if (rate <= 0.4) return -3.0
  return 0
}

/** Group a ranking table by kind for the swarm_ranking tool. */
export function groupByKind(table) {
  const out = {}
  for (const row of table) {
    (out[row.kind] ||= []).push(row)
  }
  return out
}
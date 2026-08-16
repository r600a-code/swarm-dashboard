# Contributing models to dsh-swarm-router

The swarm routes tasks across a **model aggregation registry**. Anyone can add a
model — a new cfgpu model, a new OpenRouter id, or a whole new OpenAI-compatible
gateway — by opening a PR against `models/registry.json`. This is contribution
**①: the model multi-aggregation platform PR**.

## The 30-second flow

1. Edit `models/registry.json` — add your model entry under an existing
   `providers` block, or add a new provider block.
2. Run the validator:
   ```sh
   node scripts/validate-registry.mjs
   ```
3. Commit and open a PR. CI runs the same validator.

## What a model entry looks like

```jsonc
{
  "id": "deepseek/deepseek-v4-pro",   // provider model id; sent verbatim to /chat/completions
  "name": "DeepSeek V4 Pro",           // human label shown in tools + stats
  "reasoning": true,                   // benefits from deliberation?
  "coding": true,                      // good at code?
  "longContext": true,                 // large context window?
  "fast": false,                       // a fast/cheap tier model?
  "strength": 9,                       // 1-10 overall quality
  "speed": 4,                          // 1-10 latency (higher = faster)
  "cost": 3,                           // 1-10 (higher = CHEAPER)
  "contextWindow": 128000,             // max input tokens
  "maxTokens": 32000,                  // max output tokens
  "unstable": false                    // optional: demote in routing (flaky route)
}
```

Only `id` and `name` are strictly required; the validator enforces types and
ranges. The capability booleans (`reasoning`/`coding`/`longContext`/`fast`) are
**routing gates**: a task of `kind: reasoning` will never be sent to a model
without `reasoning: true`, etc. The 1-10 ranks drive effort-matched scoring.

## Adding a whole new provider (gateway)

Append a new key under `providers`:

```jsonc
"my-gateway": {
  "displayName": "My Gateway",
  "api": "openai-completions",
  "baseURL": "https://gateway.example/v1",
  "apiKeyEnv": "MY_GATEWAY_API_KEY",
  "defaultContextWindow": 128000,
  "defaultMaxTokens": 32000,
  "models": [ /* entries */ ]
}
```

The swarm's `llm-pi-ai` routes are keyed by this provider name, so a new gateway
becomes a new route that coexists with `cfgpu-swarm` and `openrouter` (union
merge; no clash with the machine's own `cfgpu` settings route).

## Probe before you push

The validator checks structure only — it does **not** call the endpoint. Before
opening a PR, confirm your model actually answers:

```sh
curl -sS https://<baseURL>/chat/completions \
  -H "Authorization: Bearer $<apiKeyEnv>" \
  -H "Content-Type: application/json" \
  -d '{"model":"<id>","messages":[{"role":"user","content":"hi"}],"max_tokens":8}'
```

A model that 404s on the provider helps no one. The registry entries for cfgpu
were all probed live (`/models` + per-model `/chat/completions`) before landing.

## Routing, feedback, and ranking (the platform loop)

- **Routing** is pure and zero-API: `scoreModel(model, kind)` picks the best
  model per task. Adding a model here immediately makes it routable.
- **Feedback** (contribution ③): after a real task, call the `swarm_feedback`
  tool (`correct`, `quality` 1-5). Feedback accumulates in `.swarm-data/rankings.json`
  and feeds `swarm_ranking`, so the community's real outcomes rank models over
  time — a model that wins on `strength` but fails in practice gets demoted.
- **Stats** (contribution ④): every dispatched task records token usage
  (prompt/completion/total/reasoning) to `.swarm-data/usage.json`, viewable via
  `swarm_stats` — this is how you measure "这玩意儿到底有多少作用".

## Extending the plugin (contribution ②)

Other DSH plugins can extend the swarm at runtime by injecting its service:

```js
export const inject = ['swarmRouter']
export function apply(ctx) {
  // add a model only this plugin knows about
  ctx.swarmRouter.registerModel({ provider: 'my-gateway', id: 'acme-x', name: 'Acme X', coding: true, strength: 8, speed: 7, cost: 7, contextWindow: 128000, maxTokens: 32000 })
  // register a custom task kind
  ctx.swarmRouter.registerTaskKind('translation', { prefer: ['strength'] })
  // hook feedback
  ctx.swarmRouter.onFeedback((entry) => { console.log(entry) })
}
```

See `service.js` for the full `ctx.swarmRouter` API.
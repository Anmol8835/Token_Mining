# Relay — LLM router console

Next.js dashboard for the LLM API server in `../` (the Express router at `index.js`).

## Pages

| Route | What it shows |
|---|---|
| `/` | Cost saved vs fixed-model baselines, tokens, requests, per-model and per-mode charts, cache and compaction accounting, router benchmark, recent requests |
| `/models` | Enable or disable models in the auto-routing candidate pool (persisted in `data/dashboard-prefs.json`) |
| `/routing` | Default cost vs quality preference (cost / fast / balanced / quality), router policy rules, model score averages |
| `/activity` | Full session request table with pagination, classifier eval results |

## Run

Backend first:

```bash
cd ..            # repo root
node index.js    # serves http://localhost:8002
```

Then the console:

```bash
pnpm install
pnpm dev         # http://localhost:3000
```

The dashboard talks to the backend through a rewrite in `next.config.ts`
(`/api/server/*` to `http://localhost:8002/*`), so there is no CORS setup.
Point it elsewhere with `BACKEND_URL=http://host:port pnpm dev`.

To see every panel populate without calling a provider, hit
"Generate demo traffic" on the Overview page (it runs the real classifier
and router, then simulates provider results).

# Testing and evaluation

## Automated checks

```bash
pnpm test
pnpm exec tsc --ignoreConfig --noEmit --module NodeNext --moduleResolution NodeNext --target ES2023 --esModuleInterop --skipLibCheck server/index.ts
pnpm build
```

The automated tests cover ownership, conversational sequencing, objectives, evidence/report linking, bounded worker tools, repair admission, cancellation, publication, version artifacts, and interview departure notifications. The repair tests use controlled worker responses; they do not call Tavus or establish real-model quality.

The GitHub Actions workflow runs the same test and type/build commands on Node 22. It has no deployment step and requires no application credentials.

## Publication checks

Every accepted change must pass source-scope checks, TypeScript, and a production build. The worker can make one correction after a verification failure. Enable `LOOP_WORKER_BEHAVIOR_CHECK=1` for additional universal browser checks; install Chromium first:

```bash
pnpm exec playwright install chromium
```

These checks test code validity and basic journey regressions. They do not prove accessibility, design quality, complete behavioral correctness, or that a requested change solved the participant's problem. The retry interview supplies that last form of evidence.

## Real-worker evaluation

```bash
node --import tsx scripts/eval-shopper-changes.ts
# Or select cases:
node --import tsx scripts/eval-shopper-changes.ts favorites size-guide
```

See [the evaluation guide](../evals/README.txt) and [case definitions](../evals/shopper-changes.json). These runs require authenticated worker access, invoke real model calls, and can consume paid usage. Run them when no interview is active. They replay synthetic statements/tool arguments through planning, implementation, verification, and publication; they do not test facial perception or live conversation timing.

Worker prompts, responses, and timestamped traces are written under ignored `data/worker-logs/`. Timing should be broken down into queue wait, workspace preparation, planning, coding, checks, correction, and publication. A historical benchmark is not a latency guarantee.

## Manual checks

Live Tavus tests are needed for mic input, screen perception, natural turn taking, knowledge retrieval, media capture, and retest feedback. Tab-close behavior has automated event tests and a live API lifecycle check; browser shutdown delivery is still best effort, backed by server heartbeat expiry.

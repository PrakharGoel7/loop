Loop shopper-change evaluation
==============================

Run from the app directory:
  node --import tsx scripts/eval-shopper-changes.ts
Optional case IDs select a subset, for example:
  node --import tsx scripts/eval-shopper-changes.ts favorites size-guide

The suite is in evals/shopper-changes.json. Each case defines:
- A synthetic shopper statement, contextual website event, and simulated Mira tool arguments.
- A checkout timing policy, either while-building or after-verification.
- Outcome criteria written before the run and NOT sent to the workers.

The runner uses the real production state/repair modules, planner, coding worker,
verification and publication functions against disposable copies. The live store
and live study data are not edited. Two independent case processes run concurrently;
inside each session, coding jobs remain sequential. Timings therefore include
normal model startup and possible contention between the two test sessions.

Results: data/evaluations/<run timestamp>/<case>/result.json
Saved statement/event evidence and complete worker logs: <case>/baseline/data/
Published code patch: <case>/revision.patch
Published website retained for functional review: <case>/site/
The case's original baseline is restored at the end of the test.

Timing definitions:
- Recording-to-queue: saved utterance event to job admission. Tool arguments are
  supplied by the fixture; this does NOT measure Mira deciding to invoke the tool.
- Queue wait: job admission to workspace preparation starting.
- Planning: live planner invocation to parsed/accepted plan.
- Coding: coding-worker invocation to returned summary.
- Verification: source-scope check, TypeScript, production build, and any correction.
- Publication: applying the verified diff to the disposable website.
- Statement-to-publication: wall time spanning all stages and explicit queue gates.

Effectiveness rubric:
- PASS: all predefined user-visible outcome checks pass in the published site.
- PARTIAL: meaningful improvement but at least one requested behavior is missing.
- FAIL: the main user problem remains, or the change breaks required behavior.
- NOT TESTED: no browser verification; a build pass alone is not effectiveness.

Review the plan separately for faithfulness, limited scope, and use of existing
catalog/business data. Check functional behavior in the browser, not just code
presence. Record exact observations, check results, and limitations in a review.json
beside result.json. Never rewrite a failed result into a success after manual repair.

The initial run is one trial per case, so it is a baseline and not a statistically
reliable latency or success-rate estimate. This suite does not test Tavus speech
recognition, camera perception, interview timing, or spontaneous repair-tool choice.
Those need a separate live call using the same statements. The future_adversarial_cases
list contains interview admission cases for that live test; it is not auto-executed.

Repeated live Favorites → sizing replay
--------------------------------------
  node --import tsx scripts/eval-shopper-changes.ts --live-replay
  node --import tsx scripts/eval-shopper-changes.ts --live-replay --repeats 3
  node --import tsx scripts/summarize-live-replay.ts data/evaluations/<run timestamp>

This uses evals/live-favorites-sizing.json, copied from recorded study 1f3801f6-ed4.
Exact shopper statements, injected observation text, issues, evidence, suggestions,
and later unrelated remarks are retained. Event timing is compressed: both requests
are admitted immediately, then later remarks and checkout are replayed. This tests
queue ordering and statement snapshot isolation, not the original conversation's pacing.
Three independent sessions run sequentially to avoid introducing cross-session
CPU/model contention. Within each session, each job plans, codes and verifies
before the next job plans; the next plan sees the previous verified code. No prepared patches are provided to the worker.
Each result includes all production job fields plus shell command counts/output
sizes from saved JSONL. Browser acceptance is separately recorded in review.json;
missing review remains NOT TESTED. Use the saved site folder with a dedicated local
preview server for browser review, without replacing the live storefront.

Remote worker replay
--------------------
  LOOP_WORKER_SSH_HOST=loop-worker LOOP_WORKER_REMOTE_ROOT=/opt/loop-worker LOOP_EVAL_STOP_ON_FAILURE=1 node --import tsx scripts/eval-shopper-changes.ts --live-replay

Explicit remote environment variables keep the test target unambiguous. The optional
stop-on-failure switch preserves the failing trial and marks remaining trials not_run
so an infrastructure error can be fixed before starting a separately timestamped run.
Remote coder diagnostics include MCP call counts, text-result character counts,
read/list/review output totals, individual failures, and any unexpected shell calls.
MCP output totals are response sizes, not input token usage or edit payload size.

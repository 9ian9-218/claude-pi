# Evaluation protocol

`npm run eval:reliability` repeats deterministic runtime failure probes three times, records every attempt, and exits nonzero on any failure or missing report. It uses temporary repositories and local HTTP mocks. Artifacts in `.agent/evals/` include source SHA, working diff hash (including untracked source), lockfile hash, Node/platform, durations and pass/fail counts. `CLAUDE_PI_EVAL_REPETITIONS` controls 1–20 repetitions.

These probes measure error reporting, preservation of edits, permission enforcement, cancellation, bounded output, edit conflicts, request budgets, stream timeouts, CLI behavior and extension lifecycle. They do not measure model coding ability. API keys and runtime data are excluded from the npm package.

For coding benchmarks, pin source SHA/diff, lockfile, task IDs and dataset revision, container digest, provider/model ID, reasoning level, prompt, tool face, request/token/cost/time budgets and concurrency. Store first attempts and all reruns independently. Record F2P/P2P test IDs and actual exit codes; missing test IDs, environment failures and timeouts must never count as passes. Compare agent configurations using the same model and environment, and model changes using the same harness. Report success rate with sample size, cost per passing task (unknown when prices are unavailable), elapsed time and rerun count.

The historical `.scratch/bench` results remain historical evidence for a different model/configuration. They are not a current-model score. The small live smoke test documented in `docs/reliability-validation.md` only establishes real API/tool integration.

`npm run eval:coding-smoke` is a reproducible **live API** integration task using the configured default model. It consumes up to 10 model requests / 24 tools / 300,000 token reservation / 180 seconds. An independent original 23-test suite must fail before and pass after; its hash must remain unchanged. All run logs and outcomes are kept in `.agent/evals/coding-*`. It is separate from the offline probes and is not run by CI.

# Replay V8.2 recovery

The original exception came from passing one golden object to the array-based
`evaluateGolden` function. Commit b464d63 fixed that call. Commit 8724da5 has
the same tree as its parent and did not add another fix.

The retry button used PUT `/api/jobs/:id`, but that Next route accepted only
completed jobs. Failed replays never reached the worker, leaving the previous
error visible. Shared understanding/vision stages also wrote V8.1 metadata;
automatic recovery and the generic resume endpoint could run `processJob`
instead of replaying saved data.

The fix separates single-golden evaluation from list evaluation, allows failed
replays through the Next route, persists `result.replayPending`, preserves V8.2
stage metadata, and routes manual/automatic recovery to replay. Recovery errors
keep the saved progress. No migration or transcript rewrite is required.

## Deployment and retry

1. Confirm Railway and Vercel have deployed the fix commit. The worker's public
   `/health` must report `V8.2-evidence-2` and its `RAILWAY_GIT_COMMIT_SHA`.
2. Refresh the existing analysis and select **Retomar replay V8.2**. Do not create
   another analysis. Legacy failed jobs with the exact golden-map error also
   qualify even if their stage label was overwritten.
3. The replay reads `vod_chunks` and `clip_candidates`, recalculates semantic
   understanding/ranking/visual evidence, appends candidate traces, and updates
   the existing result. It does not call audio transcription or replace/delete
   transcript chunks. Previous result/checkpoint fields remain present.
4. A successful retry clears the error, sets progress to 100, and marks
   `replayPending` false. A failed retry retains replay identity for another try.

Existing `candidate_trace` rows are diagnostics, not full resumable stage
snapshots: their payload omits some candidate fields. This fix does not pretend
to reuse them as complete checkpoints; understanding/ranking/vision can run
again. Saved transcription is reused throughout.

## Validation

Run `node --test worker/replay.test.js` (or add `--test-isolation=none` where child
process creation is restricted). Tests execute actual worker functions and Next
PUT routing with simulated Supabase/model/video responses. They cover golden
hits/misses, completion to 100%, failed replay retry, generic resume, automatic
recovery, failure preservation, and health identity. Network requests are
allowlisted by the test fixture; transcript writes and candidate deletion fail
the tests. These tests do not execute the user's production VOD.

## Evidence preservation update

Ranking now normalizes both flat visual responses and frame arrays. Missing or failed vision is unavailable, and numeric zero scores remain zero. Understanding requests a chronological evidence sequence; only quotes found in the claimed saved transcript segment enter that sequence. Segment times are not word-level timestamps. Ranking receives at most two nearby candidate contexts within ten minutes, explicitly marked as unconfirmed relationships, without merging candidates or forcing benchmark hits. Trace payloads now retain ranking reasons and candidate boundaries.

Nine isolated regression tests pass. An offline check against the user-provided export confirms that nested video/reaction evidence now reaches the ranking input. No production replay or paid model evaluation was run for this update; ranking quality and quote recall still require a subsequent controlled evaluation. Longer evidence inputs can increase ranking token usage.

# 23 - Upgrade Roadmap After LM Studio Hardening

Status: current planning surface for the next LSATLab waves after the LM
Studio/provider-readiness hardening pass. This document is intentionally shorter
than [22-grand-roadmap.md](22-grand-roadmap.md): it names the next executable
tracks and the release-trust rule that should govern them.

## Release Contract

- Treat `scripts/release_local.py` and `dist/release_trust.json` as the shipping
  proof, not a courtesy report.
- A "ready to ship" claim requires fresh local release evidence with
  `release_trust.status == "ok"` and no blockers.
- Provider readiness stays provider-neutral: UI can warn about LM Studio URL
  shape, but the backend firewall remains authoritative.
- Keep backward-compatible `ollama_reachable` and `ollama` fields until older
  consumers are removed deliberately.

## Landed On This Branch

- LM Studio/provider readiness is provider-neutral in doctor, `/api/ready`,
  release trust, Settings, onboarding, and explanation fallback copy.
- Release trust now blocks stale release-local evidence, head mismatches, and
  real dirty tracked files while explicitly ignoring generated `AGENTS.md` /
  `CLAUDE.md` policy files for this wave.
- Runtime evidence, backup freshness, scheduler evidence, and release trust are
  visible in Diagnostics and enforced by the local release gate.
- Ability Engine readiness now exposes an explicit exam-day simulation checklist
  and Analytics passes its selected evidence window into both readiness and
  forecast queries.
- Ability Engine V2 now emits one shared utility packet from the selector
  (`ability_engine_v2_utility_v1`) and threads it through adaptive next
  questions, vNext daily plan, `/study/today`, SRS due review, drill selection,
  and readiness metadata.
- Socratic Tutor turns now surface the retrieval evidence behind a nudge:
  similar prior misses plus relevant Notebook context, while keeping answer keys
  hidden.
- Generation hardening now includes property tests for fail-closed malformed
  candidates, expanded EXPLAIN-plan budgets for release-sensitive list queries,
  and a production-on distractor-quality gate that requires every wrong answer
  to be a plausible, explainable LSAT trap.
- Benchmark smoke and the scheduled `generation_gate_eval` now record
  deterministic generation-quality gate probes, and release trust blocks
  release/package tiers unless those probes prove clean candidates pass while
  trap-metadata and weak-distractor mutations fail.
- Content Trust now has an approved-AI revalidation rail: `/api/content`
  exposes the queue and run endpoint, the scheduler records
  `content_revalidation` evidence, and Content Ops can run due/all approved AI
  items while surfacing stale, failed, and passage-aware validator reasons.
- Content Ops now has a first one-click remediation action for failed approved-AI
  revalidation rows: quarantine the failed item, revoke approval, snapshot the
  pre-remediation question version, and annotate the failed validator run.
- Content Ops can now resolve duplicate clusters with an audited canonical
  decision: keep the recommended row, snapshot the decision, and soft-retire /
  quarantine duplicate rows so the active duplicate finding clears.
- Source policy edits now have a review gate: risky official/non-commercial or
  loosened cloud/training/export changes return a structured review packet until
  Content Ops acknowledges the exact risks, then the accepted policy is
  version-snapshotted for audit.
- Content Ops version history now has audit filters for remediation/source
  policy/source key views and renders source-policy field diffs plus
  remediation metadata from stored snapshots.
- Content Ops can now restore or roll back source-policy versions from trusted
  snapshots, persists reviewer notes with source-policy acknowledgements, and
  re-runs the backend risk review before risky restores are accepted.
- Native Reliability Console work has a first operational slice in Settings:
  sidecar/backend status, provider readiness, runtime logs, last crash, backup
  freshness, scheduler runs, and release trust are summarized with recovery
  actions.
- Dashboard, Analytics, and `ReadinessCard` now prefer live backend
  `ReadinessStatus` evidence while treating offline sample readiness as absent
  so the old client heuristic remains the fallback instead of a fake backend
  score.
- Dashboard and Today now expose Ability Engine V2 task ranking evidence:
  priority chips and compact tradeoff reasons show why the top daily-plan work
  outranks the alternatives without adding another query.
- Today now persists completion/reopen feedback for utility-ranked tasks as
  `daily_plan_task_feedback` activity events, preserving score, model, target
  difficulty, time budget, q type, and tradeoff reasons for the next selector
  learning loop.
- Ability Engine V2 now reads those daily-plan feedback events back into the
  shared selector: completion/skip/reopen rates adjust utility scores within a
  small clamp, expose task-specific feedback chips, and report mastery,
  cadence, and readiness impact signals.
- Analytics now exposes longer-horizon daily-plan feedback cohorts by q type and
  task type, and Today uses those 90-day cohort multipliers to tune per-type
  drill sequencing instead of relying only on same-day task feedback.
- Ability Engine feedback cohorts now include a transparent selector policy and
  later-attempt outcome evidence, so Analytics can show why a q type is being
  sequenced forward and whether accepted drill work is followed by better
  attempts.
- Ability Engine outcome evidence now also has a standalone
  `/api/analytics/feedback-outcomes` endpoint with source filters, outcome
  windows, and minimum-sample thresholds; Analytics uses it to show which
  feedback cohorts are ready for future planner weighting.

## Immediate Wave

1. **RAG-Socratic Tutor OS**
   - Passage-aware explanations for RC and cited miss retrieval for LR/RC.
   - Trap-similar miss retrieval injected into explanations and coach turns.
   - Persisted Socratic turns per question: nudge, eliminate, predict, explain.

2. **Ability Engine V2**
   - One theta/ZPD selector powering drills, daily plan, SRS, readiness, and
     Analytics.
   - Shared evidence model for ability, uncertainty, cadence, and mastery slope.
   - Daily-plan utility scoring that balances due SRS, weak types, and time.
   - Next: let planner weights consume only `planner_weight_eligible` lift,
     with audit-visible before/after utility deltas and rollback controls.

3. **RC Parity Sprint**
   - Passage maps, RC tagging, passage-first generation, and RC validator depth.
   - RC import quality checks for multi-column parse and answer-key reconcile.
   - RC-specific semantic validators before generated RC enters review queues.

4. **Content Trust Cockpit**
   - Expand source registry, audit/version history, duplicate detection,
     validator runs, revalidation history, and provenance scoring into a single
     remediation workflow.
   - Near-duplicate clusters, length-tell checks, tag-confidence health, and
     per-source trust summaries.
   - Next: revalidation history drill-down, source-scoped validator timelines,
     and provenance trend deltas after remediation.

5. **Native Reliability Console**
   - Sidecar health, logs, crash capture, model readiness, backup/restore, and
     release trust status in one UX.
   - Scheduler evidence and backup freshness surfaced as first-class readiness
     indicators, not hidden artifacts.
   - Clear recovery actions: open logs, rerun doctor, create backup, restore,
     refresh provider health.

## Later Wave

1. **Generation Quality Moat**
   - Remaining work: mutation testing, larger golden eval corpus, per-type
     distractor probes, and deeper RC semantic validators.
   - Gate traces persisted so quarantine review shows the critic's reason, not
     just pass/fail.

2. **Notebook as Knowledge Base**
   - DB-backed notes, artifact workflows, search, backlinks, and tutor/study-plan
     context integration.
   - Personal rule/tell library linked to q types, trap types, passages, and
     repeated miss clusters.

3. **Native Companion Depth**
   - Always-on-top timer, tray SRS badge, local notifications, deep links, update
     channels, and multi-window coach.
   - Packaged Win11 smoke evidence required for native-only features.

4. **Scale and Privacy Hardening**
   - Keyset pagination, EXPLAIN-plan budgets, restore UX, self-heal audits,
     optional SQLCipher, and CI matrix expansion.
   - Migration dry-run and old-DB upgrade tests before non-additive schema work.

## Upgrade Sequencing

The next wave should start with release trust and reliability visibility, then
Tutor OS and Ability Engine work can build on clean provider/model readiness.
RC parity and content trust should advance together because the RC generator is
only useful if the passage corpus, validators, and provenance scores are visible
to the user.

# 00 — Vision

## What problem this solves
Most LSAT apps are quiz engines: they show questions and tally a percentage. They
do not encode a *method*, and they do not tell you *why* you missed something or
*what to do next*. LSAT Lab is built around the study techniques top scorers
actually use, and uses a local LLM to do the two things software historically
couldn't: explain any question on demand, and diagnose patterns across hundreds of
attempts.

## Who it's for
A single, serious self-studier (the owner). Not multi-user, not a SaaS.
Privacy and offline operation are features, not constraints — Tier-A realtime
explanation, diagnosis, scoring, and all study-loop work run entirely on the
local machine and GPU, like the Jarvis project. Tier-B (offline batch
generation) has an opt-in cloud path shipped in R7 (`GEN_PROVIDER=cloud` with a
budget ledger), kept off by default; no other surface is allowed to hit the
network for an LLM call.

## The pedagogy it encodes
1. **Blind Review (BR).** Take a section timed, flagging anything uncertain. Then,
   *before revealing answers*, redo the questions untimed and commit to a "BR
   answer." Only then reveal. The gap between timed score and BR score is the
   single most diagnostic number in LSAT prep:
   - timed-wrong / BR-right  → a **timing/pressure** problem (drill speed)
   - timed-wrong / BR-wrong  → an **understanding** gap (concept review + SRS)
   - timed-right / BR-wrong  → you **got lucky** (don't trust it; flag it)
2. **Question-type taxonomy.** Every question is tagged by type so analytics are
   diagnostic ("61% on Parallel Reasoning") not vague ("62% overall").
3. **Error log / wrong-answer journal.** Every miss is captured with a *reason*
   (misread, trap, concept, timing, careless) and an AI diagnosis.
4. **Spaced repetition (FSRS).** Missed questions resurface on schedule as drills.
5. **Timing analytics.** Per-question timing (not just per-section) finds the
   questions that bleed the clock.

## The AI-quality truth (read this before trusting generation)
Generating genuinely LSAT-quality Logical Reasoning is extraordinarily hard for an
LLM — even large cloud models produce subtly broken stimuli (two defensible
answers, a fake logical gap, an answer-length tell). An 8B local model will not do
it reliably. We therefore split AI work into trust tiers:

| Tier | Task | Trust | Where it runs |
|---|---|---|---|
| **A** | Explain *your real* questions, tag, diagnose, summarize errors | High | `qwen3:8b` (Tier A default), realtime, **local only** |
| **B** | Generate type-targeted *drill variations*, RC passages | Medium — validation gate required | bigger local model (`qwen3:14b`) **offline/batch**, cached; opt-in cloud Tier-B available via `GEN_PROVIDER=cloud` with a hard monthly budget |
| **C** | Generate novel full scored LR sections that mimic real difficulty | Low | deferred past v1 |

Key consequence: **Tier-B generation is offline and cached**, never in the study
loop. So we can run a slow, bigger model for it (14B/32B) and bank good output,
instead of being limited to a fast small model. Real imported questions remain the
quality anchor and the only content used for score prediction.

The bank-expansion roadmap is **local-default**: every new generation/validation
feature targets the local Ollama stack first. Cloud Tier-B is preserved as the
R7-shipped opt-in path but no new feature in the roadmap depends on it, and
score prediction stays strictly local.

## Non-goals (v1)
- Logic Games / Analytical Reasoning (retired 2024).
- Multi-user, accounts, cloud sync.
- Mobile.
- Cloud LLM in the realtime/Tier-A study loop (Tier-B has an opt-in cloud path,
  off by default).
- Cloud TTS/ASR.
- Writing-sample practice (low ROI).

# Content licensing & data handling (StudyVault)

> Scope: **personal use only.** StudyVault is a local-first study app for the
> owner's own exam prep. It is **never distributed or sold** (merge decision
> §8.3 of `LSAT-LAB-MERGE-PLAN.md`). This document records the content rules
> that keep that posture clean.

## Hard rules

1. **No copyrighted content in the git repo, ever.**
   - Official LSAT PrepTests are LSAC property. They are **user-owned imports
     only** — parsed locally from PDFs the user already owns, into the
     app-data SQLite bank. They are never bundled in the installer and never
     committed to this repository.
   - The LSAT question bank (`lsatlab.db` / any `*.db` under
     `services/lsat-backend/`) is gitignored and lives in app-data at runtime,
     not in the tree.

2. **Research datasets are personal-use only.**
   - ReClor is non-commercial / research-only. AGIEval, tasksource and similar
     follow their upstream licenses. They are fine for personal study but must
     not be redistributed. They are not committed to the repo; they are
     imported locally through the quarantine/approval pipeline.

3. **Provenance stays visible.**
   - Every imported item carries its `PrepTest.source`
     (`official | ai_generated | sample | research | reclor`). The bank UI
     surfaces this so the user always knows what an item is and where it came
     from.

4. **Bundled = open only.**
   - The only content shipped in the installer is the non-copyrighted sample
     bank seeded by `services/lsat-backend/app/bank_bootstrap.py` on first run.

## If distribution is ever reconsidered

This posture would have to change materially: commercial licensing gates
(exclude ReClor/AGIEval from any build, never touch official content), a
content-source allowlist by build flavor, and legal review. None of that is
implemented today because the app is personal-use only. Revisit
`LSAT-LAB-MERGE-PLAN.md` §8.3 before changing the distribution model.

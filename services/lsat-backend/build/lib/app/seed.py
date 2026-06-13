"""Seed the database with ORIGINAL LSAT-style sample content + a prior session.

Run with:  uv run python -m app.seed

Creates one PrepTest "Sample Diagnostic (original practice content)":
  - LR section: 8 original questions across varied q_types.
  - RC section: 1 passage + 5 questions.
All questions are source="sample", with correct answers, per-choice trap_type tags,
and pre-written Explanations so review/explain works fully offline.

Also seeds one completed StudySession with realistic Attempts (right/wrong, varied
timing, some flagged, some with blind-review answers) plus a few SRSCards so the
dashboard and analytics render against real data.

ALL stems/choices below are original content written for this project. They imitate
the *style* of LSAT questions but are not copied from any real test.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlmodel import Session, delete, select

from .db import engine, init_db
from .models import (
    AnswerChoice,
    Attempt,
    AttemptMode,
    Confidence,
    Explanation,
    ExplanationSource,
    Passage,
    PrepTest,
    Question,
    QuestionSource,
    SectionType,
    Section,
    SessionType,
    SRSCard,
    StudySession,
)
from . import srs

SAMPLE_NAME = "Sample Diagnostic (original practice content)"


# Each LR item: (q_type, difficulty, stem, prompt, choices, correct, body)
# choices: list of (label, text, trap_type)  -- correct choice trap_type = "none"
LR_ITEMS = [
    (
        "Weaken", 3,
        "Editorial: The city council claims that installing speed cameras has made "
        "Elm Street safer, pointing out that reported collisions there fell by 30 "
        "percent in the year after the cameras were installed.",
        "Which one of the following, if true, most weakens the editorial's argument?",
        [
            ("A", "Speed cameras were also installed on several other streets in the city.", "irrelevant_comparison"),
            ("B", "In the same year, the city rerouted most through-traffic away from Elm Street onto a new bypass.", "none"),
            ("C", "Some drivers have complained that the speed cameras are an invasion of privacy.", "out_of_scope"),
            ("D", "The cameras occasionally fail to record vehicles traveling at night.", "out_of_scope"),
            ("E", "Collisions across the city as a whole fell by 5 percent that year.", "half_right"),
        ],
        "B", None,
    ),
    (
        "NecessaryAssumption", 4,
        "Manager: Our new scheduling software will reduce overtime costs. After all, "
        "the software automatically distributes shifts evenly, and evenly distributed "
        "shifts mean no employee works enough extra hours to earn overtime pay.",
        "The manager's argument depends on assuming which one of the following?",
        [
            ("A", "The scheduling software is the cheapest option available.", "out_of_scope"),
            ("B", "Overtime pay is the largest single expense the company faces.", "too_strong"),
            ("C", "The total number of shifts that must be covered does not exceed what can be distributed without any employee reaching overtime.", "none"),
            ("D", "Employees prefer evenly distributed shifts to irregular ones.", "irrelevant_comparison"),
            ("E", "The software will never malfunction.", "too_strong"),
        ],
        "C", None,
    ),
    (
        "Flaw", 3,
        "Critic: This novel cannot be considered great literature. Its author wrote it "
        "in only six weeks, and no work produced so quickly could have the depth that "
        "great literature requires.",
        "The reasoning in the critic's argument is most vulnerable to criticism on the "
        "grounds that it",
        [
            ("A", "takes for granted that speed of composition determines literary depth", "none"),
            ("B", "relies on the testimony of a source that is likely to be biased", "out_of_scope"),
            ("C", "confuses a cause with an effect", "reversal"),
            ("D", "generalizes from a sample that is too small to be representative", "irrelevant_comparison"),
            ("E", "fails to define the term 'literature'", "out_of_scope"),
        ],
        "A", None,
    ),
    (
        "Strengthen", 3,
        "Botanist: The unusually thick leaves of the desert shrub Larrea help it survive "
        "drought. Therefore, Larrea plants with thicker leaves should survive longer "
        "during a drought than those with thinner leaves.",
        "Which one of the following, if true, most strengthens the botanist's argument?",
        [
            ("A", "Larrea plants are found only in arid regions.", "out_of_scope"),
            ("B", "Among Larrea plants in a prolonged drought, those with thicker leaves retained water longer and died later than those with thinner leaves.", "none"),
            ("C", "Thicker leaves require more nutrients to grow.", "opposite"),
            ("D", "Some desert shrubs other than Larrea also have thick leaves.", "irrelevant_comparison"),
            ("E", "Larrea plants grow more slowly than many other desert shrubs.", "out_of_scope"),
        ],
        "B", None,
    ),
    (
        "Inference", 4,
        "Every member of the hiking club has summited at least one peak above 4,000 "
        "meters. No one who has summited a peak above 4,000 meters is permitted to join "
        "the club's beginner training program, which is only for those who have never "
        "climbed above 2,000 meters.",
        "If the statements above are true, which one of the following must also be true?",
        [
            ("A", "No member of the hiking club is in the beginner training program.", "none"),
            ("B", "Everyone in the beginner training program will eventually join the hiking club.", "out_of_scope"),
            ("C", "Some members of the hiking club have climbed above 2,000 meters but not above 4,000.", "opposite"),
            ("D", "The beginner training program has no members.", "too_strong"),
            ("E", "Anyone who has climbed above 2,000 meters is a member of the hiking club.", "reversal"),
        ],
        "A", None,
    ),
    (
        "Paradox", 3,
        "When the museum lowered its admission price last year, total revenue from "
        "admissions rose. Yet the number of people visiting the museum each year has "
        "remained essentially unchanged.",
        "Which one of the following, if true, most helps to resolve the apparent "
        "discrepancy?",
        [
            ("A", "The museum's operating costs increased last year.", "out_of_scope"),
            ("B", "Before the price change, many visitors used free passes; after it, far fewer free passes were issued, so more visitors paid.", "none"),
            ("C", "The museum added a new exhibit last year.", "out_of_scope"),
            ("D", "Admission prices at comparable museums also fell last year.", "irrelevant_comparison"),
            ("E", "The museum is open the same number of days as before.", "out_of_scope"),
        ],
        "B", None,
    ),
    (
        "Parallel", 4,
        "If the bridge is repainted this summer, traffic will be diverted for weeks. "
        "Traffic will not be diverted for weeks. So the bridge will not be repainted "
        "this summer.",
        "Which one of the following arguments is most similar in its reasoning to the "
        "argument above?",
        [
            ("A", "If the recipe calls for saffron, the dish will be expensive. The dish is expensive. So the recipe calls for saffron.", "reversal"),
            ("B", "If the seeds were planted late, the harvest will be small. The seeds were planted late. So the harvest will be small.", "half_right"),
            ("C", "If the alarm is working, it will sound during the drill. The alarm did not sound during the drill. So the alarm is not working.", "none"),
            ("D", "If the store is open, the lights are on. The lights are on. So the store is open.", "reversal"),
            ("E", "Either the train is late or the schedule is wrong. The train is not late. So the schedule is wrong.", "out_of_scope"),
        ],
        "C", None,
    ),
    (
        "Role", 4,
        "Some argue that the proposed tax should be rejected because it is unpopular. "
        "But popularity is no guide to sound policy: many necessary measures are "
        "initially resented. The tax should be judged on its economic merits alone.",
        "The claim that many necessary measures are initially resented plays which one "
        "of the following roles in the argument?",
        [
            ("A", "It is the main conclusion the argument seeks to establish.", "half_right"),
            ("B", "It is offered as support for the view that popularity is not a reliable guide to sound policy.", "none"),
            ("C", "It is a position the argument ultimately rejects.", "opposite"),
            ("D", "It is an assumption that the argument leaves unstated.", "out_of_scope"),
            ("E", "It is evidence that the proposed tax is economically sound.", "scope_shift"),
        ],
        "B", None,
    ),
]

# RC passage + 5 questions (all original).
RC_PASSAGE = (
    "For most of the twentieth century, ecologists assumed that a mature ecosystem "
    "tends toward a stable 'climax' state: a fixed assemblage of species that, once "
    "reached, persists indefinitely unless disturbed from outside. On this view, "
    "disturbances such as fires or floods were aberrations that set an ecosystem back, "
    "and the proper baseline for conservation was the undisturbed climax community.\n\n"
    "Recent work has unsettled this picture. Long-term studies of forests and "
    "grasslands reveal that many ecosystems are shaped by recurring disturbance rather "
    "than threatened by it. Certain pine forests, for example, depend on periodic fire "
    "to release seeds and clear competing undergrowth; suppressing fire does not "
    "preserve such a forest but gradually converts it into a different, more "
    "flammable one. Some ecologists now argue that there is no single climax state at "
    "all, only a shifting mosaic of patches at different stages of recovery.\n\n"
    "This reframing carries a practical sting. If disturbance is part of how an "
    "ecosystem maintains itself, then a conservation policy aimed at freezing a "
    "landscape in one configuration may be self-defeating. Yet the older ideal retains "
    "appeal precisely because it offers a clear target. Critics of the newer view worry "
    "that, without a fixed baseline, 'natural' becomes whatever currently exists, and "
    "any change can be rationalized as merely another turn of the mosaic."
)

RC_ITEMS = [
    (
        "MainPoint", 3,
        "",
        "Which one of the following most accurately expresses the main point of the "
        "passage?",
        [
            ("A", "Periodic fire is necessary for the survival of all pine forests.", "too_strong"),
            ("B", "The traditional 'climax' model of ecosystems has been challenged by evidence that disturbance is often integral to how ecosystems persist, complicating conservation.", "none"),
            ("C", "Conservation policy should aim to freeze landscapes in their current configuration.", "opposite"),
            ("D", "Ecologists in the twentieth century ignored the effects of fires and floods.", "scope_shift"),
            ("E", "There is no meaningful distinction between natural and artificial change in ecosystems.", "too_strong"),
        ],
        "B", None,
    ),
    (
        "Attitude", 4,
        "",
        "The author's attitude toward the newer 'shifting mosaic' view can best be "
        "described as",
        [
            ("A", "enthusiastic endorsement free of reservation", "too_strong"),
            ("B", "qualified interest that acknowledges a genuine objection to it", "none"),
            ("C", "dismissive skepticism", "opposite"),
            ("D", "complete indifference", "out_of_scope"),
            ("E", "alarm at its practical consequences", "degree"),
        ],
        "B", None,
    ),
    (
        "Detail", 2,
        "",
        "According to the passage, suppressing fire in certain pine forests has which "
        "one of the following effects?",
        [
            ("A", "It preserves the forest in its climax state.", "opposite"),
            ("B", "It gradually converts the forest into a different, more flammable type.", "none"),
            ("C", "It immediately destroys the forest.", "too_strong"),
            ("D", "It has no measurable effect on the forest.", "opposite"),
            ("E", "It increases the diversity of competing undergrowth permanently.", "scope_shift"),
        ],
        "B", None,
    ),
    (
        "Inference", 4,
        "",
        "The passage suggests that critics of the newer view are most concerned that it "
        "may",
        [
            ("A", "underestimate the frequency of natural disturbances", "scope_shift"),
            ("B", "leave conservation without a clear standard for what should be preserved", "none"),
            ("C", "exaggerate the role of fire in grassland ecosystems", "out_of_scope"),
            ("D", "rely too heavily on short-term observations", "scope_shift"),
            ("E", "discourage all forms of human intervention in ecosystems", "too_strong"),
        ],
        "B", None,
    ),
    (
        "Function", 3,
        "",
        "The author mentions pine forests that depend on periodic fire primarily in "
        "order to",
        [
            ("A", "prove that all ecosystems require disturbance to survive", "too_strong"),
            ("B", "give a concrete example supporting the claim that disturbance can be integral to an ecosystem", "none"),
            ("C", "argue that fire suppression should always be avoided", "degree"),
            ("D", "illustrate the appeal of the traditional climax model", "opposite"),
            ("E", "show that conservation policy has generally succeeded", "out_of_scope"),
        ],
        "B", None,
    ),
]


# Single source of truth for how many sample questions the seeded "Sample
# Diagnostic" produces. Tests, analytics, and any future tooling should read
# this constant instead of hard-coding the literal count so adding a sample
# item does not silently break the suite (Wave 4.9 of the bank-expansion plan).
SEED_QUESTION_COUNT: int = len(LR_ITEMS) + len(RC_ITEMS)


def _explanation_body(stem: str, prompt: str, choices, correct: str) -> tuple[str, dict]:
    """Build a pre-written explanation body + per-choice notes for offline review."""
    per: dict[str, str] = {}
    correct_text = next(t for (l, t, _tt) in choices if l == correct)
    for (label, text, trap) in choices:
        if label == correct:
            per[label] = "Correct. This choice directly does what the prompt asks."
        else:
            reason = {
                "reversal": "reverses the logical relationship (affirms the consequent or swaps necessary/sufficient).",
                "out_of_scope": "introduces a consideration outside the scope of the argument.",
                "degree": "overstates or misstates the degree/strength involved.",
                "scope_shift": "subtly shifts the scope away from what is actually claimed.",
                "half_right": "is partly right but fails on a crucial detail.",
                "opposite": "states the opposite of what is needed.",
                "too_strong": "is too strong to be supported by the text.",
                "irrelevant_comparison": "draws an irrelevant comparison.",
                "premise_restatement": "merely restates a premise without doing the needed work.",
                "none": "is a distractor.",
            }.get(trap or "none", "is a distractor.")
            per[label] = f"Incorrect — {reason}"
    body = (
        f"The correct answer is ({correct}): \"{correct_text}\" "
        f"This is a {prompt.lower().strip()} The right choice satisfies exactly what "
        f"the prompt requires, while each other choice fails in a characteristic way "
        f"(see per-choice notes). Trap types are tagged so the analytics can track "
        f"which patterns trip you up."
    )
    return body, per


def seed(reset: bool = True) -> int:
    """Create the sample test + prior session. Returns the PrepTest id."""
    init_db()
    with Session(engine) as session:
        if reset:
            # Remove any prior sample PrepTest (idempotent re-seed).
            existing = session.exec(
                select(PrepTest).where(PrepTest.name == SAMPLE_NAME)
            ).all()
            for pt in existing:
                secs = session.exec(
                    select(Section).where(Section.preptest_id == pt.id)
                ).all()
                for sec in secs:
                    qs = session.exec(
                        select(Question).where(Question.section_id == sec.id)
                    ).all()
                    for q in qs:
                        session.exec(delete(AnswerChoice).where(AnswerChoice.question_id == q.id))
                        session.exec(delete(Explanation).where(Explanation.question_id == q.id))
                        session.exec(delete(SRSCard).where(SRSCard.question_id == q.id))
                    session.exec(delete(Passage).where(Passage.section_id == sec.id))
                    for q in qs:
                        session.delete(q)
                    session.delete(sec)
                session.delete(pt)
            session.commit()

        pt = PrepTest(name=SAMPLE_NAME, source="sample", is_official=False,
                      date_admin=None)
        session.add(pt)
        session.commit()
        session.refresh(pt)

        # --- LR section ---
        lr = Section(preptest_id=pt.id, type=SectionType.LR, order=0,
                     time_limit_sec=2100)
        session.add(lr)
        session.commit()
        session.refresh(lr)

        lr_questions: list[Question] = []
        for (q_type, diff, stem, prompt, choices, correct, _b) in LR_ITEMS:
            q = Question(section_id=lr.id, passage_id=None, stem=stem, prompt=prompt,
                         correct_answer=correct, difficulty=diff, q_type=q_type,
                         source=QuestionSource.sample, approved=True)
            session.add(q)
            session.commit()
            session.refresh(q)
            for (label, text, trap) in choices:
                session.add(AnswerChoice(question_id=q.id, label=label, text=text,
                                         is_correct=(label == correct), trap_type=trap))
            body, per = _explanation_body(stem, prompt, choices, correct)
            session.add(Explanation(question_id=q.id, body=body,
                                    source=ExplanationSource.official, per_choice_json=per))
            session.commit()
            lr_questions.append(q)

        # --- RC section ---
        rc = Section(preptest_id=pt.id, type=SectionType.RC, order=1,
                     time_limit_sec=2100)
        session.add(rc)
        session.commit()
        session.refresh(rc)

        passage = Passage(section_id=rc.id, text=RC_PASSAGE, type="single",
                          topic="ecology / philosophy of conservation")
        session.add(passage)
        session.commit()
        session.refresh(passage)

        rc_questions: list[Question] = []
        for (q_type, diff, stem, prompt, choices, correct, _b) in RC_ITEMS:
            q = Question(section_id=rc.id, passage_id=passage.id, stem=stem,
                         prompt=prompt, correct_answer=correct, difficulty=diff,
                         q_type=q_type, source=QuestionSource.sample, approved=True)
            session.add(q)
            session.commit()
            session.refresh(q)
            for (label, text, trap) in choices:
                session.add(AnswerChoice(question_id=q.id, label=label, text=text,
                                         is_correct=(label == correct), trap_type=trap))
            body, per = _explanation_body(stem, prompt, choices, correct)
            session.add(Explanation(question_id=q.id, body=body,
                                    source=ExplanationSource.official, per_choice_json=per))
            session.commit()
            rc_questions.append(q)

        all_questions = lr_questions + rc_questions

        # --- Prior completed StudySession with realistic attempts ---
        started = datetime.now(timezone.utc) - timedelta(days=3, hours=1)
        sess = StudySession(type=SessionType.section, started=started,
                            ended=started + timedelta(minutes=40),
                            config_json={"section_id": lr.id, "note": "seed prior session"})
        session.add(sess)
        session.commit()
        session.refresh(sess)

        # Pattern: vary correctness, timing, flags, and BR answers.
        # (chosen_offset, time_ms, flagged, br_offset, confidence)
        #   chosen_offset 0 => correct; otherwise pick a wrong neighbor.
        #   br_offset None => no BR; 0 => BR correct; else BR wrong.
        plan = [
            (0, 48000, False, None, Confidence.sure),    # timed_ok
            (1, 95000, True, 0, Confidence.guess),       # timing_problem (timed wrong, BR right)
            (2, 120000, True, 1, Confidence.guess),      # concept_gap (both wrong)
            (0, 30000, False, None, Confidence.sure),    # timed_ok
            (0, 62000, True, 2, Confidence.likely),      # lucky (timed right, BR wrong)
            (1, 88000, True, 0, Confidence.guess),       # timing_problem
            (2, 110000, False, 1, Confidence.guess),     # concept_gap
            (0, 41000, False, None, Confidence.sure),    # timed_ok
            (0, 55000, False, None, Confidence.likely),  # RC timed_ok
            (1, 99000, True, 0, Confidence.guess),       # RC timing_problem
            (2, 130000, True, 2, Confidence.guess),      # RC concept_gap
            (0, 47000, False, None, Confidence.sure),    # RC timed_ok
            (1, 70000, True, 0, Confidence.likely),      # RC timing_problem
        ]

        labels = ["A", "B", "C", "D", "E"]

        def shifted(correct: str, offset: int) -> str:
            ci = labels.index(correct)
            return labels[(ci + offset) % 5]

        for q, (coff, t_ms, flagged, broff, conf) in zip(all_questions, plan):
            chosen = shifted(q.correct_answer, coff)
            is_correct = chosen == q.correct_answer
            br_answer = None
            br_correct = None
            if broff is not None:
                br_answer = shifted(q.correct_answer, broff)
                br_correct = br_answer == q.correct_answer
            session.add(Attempt(
                question_id=q.id, session_id=sess.id, mode=AttemptMode.timed,
                chosen_answer=chosen, br_answer=br_answer, is_correct=is_correct,
                br_correct=br_correct, time_ms=t_ms, flagged=flagged, confidence=conf,
                created_at=started + timedelta(minutes=2 * all_questions.index(q)),
            ))
        session.commit()

        # Set scaled score for the session (sample isn't official, so predictor
        # would yield None for official-only; we store a representative scaled here
        # based on the section raw to give the trend a point).
        raw = sum(1 for (coff, *_r) in plan if coff == 0)
        from . import scoring
        sess.scaled_score = scoring.predict_scaled(raw, len(plan))
        session.add(sess)
        session.commit()

        # --- A few SRS cards for missed questions ---
        missed = [q for q, p in zip(all_questions, plan) if p[0] != 0][:4]
        for q in missed:
            card = SRSCard(question_id=q.id, fsrs_state=srs.new_card_state(),
                           due_date=datetime.now(timezone.utc) - timedelta(hours=1))
            session.add(card)
        session.commit()

        return pt.id


if __name__ == "__main__":
    pid = seed()
    print(f"Seeded sample PrepTest id={pid} ('{SAMPLE_NAME}').")

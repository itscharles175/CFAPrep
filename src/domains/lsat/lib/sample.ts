// Local fallback sample data so screens render gracefully when the backend is
// offline during frontend development. Mirrors the seeded "Sample Diagnostic".
// Real data from the API always takes precedence; this is only used as a
// fallback when a fetch fails.
import type {
  ActivityDay,
  BlindReviewGap,
  ByTypeRow,
  DashboardAnalytics,
  DifficultyRow,
  ErrorLogEntry,
  PrepTestDetail,
  PrepTestSummary,
  Question,
  SectionDetail,
  SessionResults,
  SessionSummary,
  SrsDue,
  TimingRow,
  TrapRow,
} from "./types";

export const sampleDashboard: DashboardAnalytics = {
  predicted_score: 164,
  score_delta_30d: 3,
  streak_days: 12,
  trend: [
    { date: "2026-02-20", score: 152 },
    { date: "2026-03-01", score: 155 },
    { date: "2026-03-12", score: 154 },
    { date: "2026-03-24", score: 158 },
    { date: "2026-04-05", score: 160 },
    { date: "2026-04-18", score: 159 },
    { date: "2026-04-30", score: 162 },
    { date: "2026-05-10", score: 163 },
    { date: "2026-05-19", score: 164 },
  ],
  weakest_types: [
    {
      q_type: "Parallel",
      accuracy: 0.61,
      avg_time_ms: 102000,
      trend: "down",
      section_type: "LR",
    },
    {
      q_type: "NecessaryAssumption",
      accuracy: 0.74,
      avg_time_ms: 78000,
      trend: "flat",
      section_type: "LR",
    },
    {
      q_type: "Comparative",
      accuracy: 0.66,
      avg_time_ms: 121000,
      trend: "down",
      section_type: "RC",
    },
    {
      q_type: "Flaw",
      accuracy: 0.79,
      avg_time_ms: 64000,
      trend: "up",
      section_type: "LR",
    },
  ],
  coach: {
    text: "Your timed/BR gap on LR shrank to 4 pts — understanding is solid; it's a speed problem now. Recommend 2 timed LR sections and cutting time on the first 10 questions.",
    recommendation: {
      label: "Drill timed LR",
      action: { type: "drill", payload: { section_type: "LR", timed: true } },
    },
  },
};

export const samplePrepTests: PrepTestSummary[] = [
  {
    id: 1,
    name: "Sample Diagnostic",
    source: "sample",
    date_admin: "2026-01-15",
    is_official: false,
    section_count: 2,
    completed_sections: 1,
  },
  {
    id: 2,
    name: "PrepTest 73",
    source: "official",
    date_admin: "2014-09-01",
    is_official: true,
    section_count: 4,
    completed_sections: 0,
  },
];

export const samplePrepTestDetail: PrepTestDetail = {
  ...samplePrepTests[0],
  sections: [
    { id: 11, type: "LR", order: 1, time_limit_sec: 2100, question_count: 4 },
    { id: 12, type: "RC", order: 2, time_limit_sec: 2100, question_count: 2 },
  ],
};

const lrQuestions: Question[] = [
  {
    id: 101,
    section_id: 11,
    passage_id: null,
    prompt:
      "Which one of the following, if true, most weakens the argument above?",
    stem: "Editorial: The city council claims the new congestion tax will reduce traffic. However, the tax applies only on weekdays, and most of the city's worst congestion occurs on weekends when major sporting events are held. Therefore, the council's plan will do little to address the city's real traffic problem.",
    q_type: "Weaken",
    difficulty: 4,
    source: "sample",
    choices: [
      { id: 1, label: "A", text: "The tax applies only to vehicles registered within city limits." },
      { id: 2, label: "B", text: "Most weekend commuters already use public transit to reach events." },
      { id: 3, label: "C", text: "The council's traffic data was collected primarily on weekdays, when the worst delays actually occur." },
      { id: 4, label: "D", text: "Traffic studies in other cities show mixed results for congestion taxes." },
      { id: 5, label: "E", text: "The new tax rate is lower than that of comparable cities." },
    ],
  },
  {
    id: 102,
    section_id: 11,
    passage_id: null,
    prompt:
      "The argument's conclusion follows logically if which one of the following is assumed?",
    stem: "Every student who studied for the exam passed it. Maria passed the exam. Therefore, Maria studied for the exam.",
    q_type: "SufficientAssumption",
    difficulty: 3,
    source: "sample",
    choices: [
      { id: 6, label: "A", text: "Only students who studied for the exam passed it." },
      { id: 7, label: "B", text: "Maria is a diligent student in most subjects." },
      { id: 8, label: "C", text: "Some students who did not study still passed." },
      { id: 9, label: "D", text: "The exam was unusually difficult this year." },
      { id: 10, label: "E", text: "Studying guarantees a passing grade." },
    ],
  },
  {
    id: 103,
    section_id: 11,
    passage_id: null,
    prompt:
      "Which one of the following arguments is most similar in its reasoning to the argument above?",
    stem: "If the bridge is unsafe, the inspector will close it. The inspector did not close the bridge. So the bridge is not unsafe.",
    q_type: "Parallel",
    difficulty: 5,
    source: "sample",
    choices: [
      { id: 11, label: "A", text: "If it rains, the game is canceled. It did not rain, so the game was not canceled." },
      { id: 12, label: "B", text: "If the alarm sounds, everyone evacuates. No one evacuated, so the alarm did not sound." },
      { id: 13, label: "C", text: "If she is qualified, she will be hired. She was hired, so she is qualified." },
      { id: 14, label: "D", text: "Whenever sales rise, profits rise. Profits rose, so sales rose." },
      { id: 15, label: "E", text: "All cats are mammals. Felix is a mammal, so Felix is a cat." },
    ],
  },
  {
    id: 104,
    section_id: 11,
    passage_id: null,
    prompt:
      "Which one of the following most accurately describes a flaw in the argument's reasoning?",
    stem: "A recent survey found that people who drink coffee daily report higher productivity. Clearly, drinking coffee causes people to be more productive.",
    q_type: "Flaw",
    difficulty: 2,
    source: "sample",
    choices: [
      { id: 16, label: "A", text: "It confuses a correlation with a causal relationship." },
      { id: 17, label: "B", text: "It relies on a sample that is too small to be representative." },
      { id: 18, label: "C", text: "It assumes what it sets out to prove." },
      { id: 19, label: "D", text: "It appeals to an authority that lacks relevant expertise." },
      { id: 20, label: "E", text: "It draws a conclusion about all people from a claim about some." },
    ],
  },
];

const rcQuestions: Question[] = [
  {
    id: 201,
    section_id: 12,
    passage_id: 301,
    prompt: "The primary purpose of the passage is to",
    stem: "",
    q_type: "MainPoint",
    difficulty: 3,
    source: "sample",
    choices: [
      { id: 21, label: "A", text: "compare two competing scientific theories and endorse one." },
      { id: 22, label: "B", text: "describe a phenomenon and survey explanations proposed for it." },
      { id: 23, label: "C", text: "refute a widely held misconception about marine biology." },
      { id: 24, label: "D", text: "advocate for increased funding of ocean research." },
      { id: 25, label: "E", text: "trace the historical development of a research method." },
    ],
  },
  {
    id: 202,
    section_id: 12,
    passage_id: 301,
    prompt:
      "Which one of the following can most reasonably be inferred from the passage?",
    stem: "",
    q_type: "Inference",
    difficulty: 4,
    source: "sample",
    choices: [
      { id: 26, label: "A", text: "Bioluminescence evolved independently in multiple lineages." },
      { id: 27, label: "B", text: "All deep-sea organisms rely on bioluminescence to survive." },
      { id: 28, label: "C", text: "Researchers have fully explained the chemistry of every glowing species." },
      { id: 29, label: "D", text: "Bioluminescence is more common in shallow water than in the deep sea." },
      { id: 30, label: "E", text: "The phenomenon was unknown before the twentieth century." },
    ],
  },
];

export const sampleSectionLR: SectionDetail = {
  id: 11,
  preptest_id: 1,
  type: "LR",
  time_limit_sec: 2100,
  passages: [],
  questions: lrQuestions,
};

export const sampleSectionRC: SectionDetail = {
  id: 12,
  preptest_id: 1,
  type: "RC",
  time_limit_sec: 2100,
  passages: [
    {
      id: 301,
      type: "RC",
      topic: "Marine biology",
      text: "Few phenomena in the natural world are as striking as bioluminescence — the production of light by living organisms. In the deep sea, where sunlight never penetrates, a remarkable proportion of animals can generate their own light. For decades, biologists puzzled over why this capacity should be so widespread in an environment seemingly so hostile to vision.\n\nSeveral explanations have been advanced. Some researchers argue that bioluminescence functions chiefly as a defense: a sudden flash may startle a predator, or a glowing cloud of luminescent material may serve as a decoy while the prey escapes. Others emphasize its role in communication, particularly in attracting mates across the vast darkness. A third group points to its use in hunting, noting that certain predatory fish dangle luminescent lures to draw smaller animals within reach.\n\nWhat unites these accounts is the recognition that light, even in darkness, carries information — and that organisms able to control that information gain a decisive advantage.",
    },
  ],
  questions: rcQuestions,
};

export function sampleSection(id: number): SectionDetail {
  return id === 12 ? sampleSectionRC : sampleSectionLR;
}

// Review-form version of a sample question (used by Blind Review / Explanation
// screens when the backend is offline).
export const sampleReviewQuestion: Question = {
  ...lrQuestions[0],
  correct_answer: "C",
  choices: [
    { id: 1, label: "A", text: lrQuestions[0].choices[0].text, is_correct: false, trap_type: "out_of_scope" },
    { id: 2, label: "B", text: lrQuestions[0].choices[1].text, is_correct: false, trap_type: "irrelevant_comparison" },
    { id: 3, label: "C", text: lrQuestions[0].choices[2].text, is_correct: true, trap_type: "none" },
    { id: 4, label: "D", text: lrQuestions[0].choices[3].text, is_correct: false, trap_type: "irrelevant_comparison" },
    { id: 5, label: "E", text: lrQuestions[0].choices[4].text, is_correct: false, trap_type: "degree" },
  ],
  explanation: {
    source: "ai",
    body: "The argument concludes the council's plan won't help because the worst congestion is on weekends. Answer C undermines the premise: if the data was actually collected on weekdays when delays are worst, the weekend assumption collapses.",
    per_choice: {
      A: "Out of scope — vehicle registration is never at issue.",
      B: "Irrelevant comparison; doesn't bear on whether the tax reduces traffic.",
      C: "Correct. Severs the link by attacking the claim that weekends are the real problem.",
      D: "Irrelevant comparison to other cities.",
      E: "Degree trap — the tax rate's level doesn't address effectiveness.",
    },
  },
};

export const sampleResults: SessionResults = {
  session: { id: 999, type: "section", started: "2026-05-19T14:00:00Z" },
  items: [
    {
      question: sampleReviewQuestion,
      attempt: {
        attempt_id: 9001,
        chosen_answer: "C",
        br_answer: "C",
        is_correct: true,
        br_correct: true,
        time_ms: 94000,
        outcome: "timed_ok",
      },
    },
    {
      question: { ...sampleReviewQuestion, id: 102, q_type: "SufficientAssumption", correct_answer: "A" },
      attempt: {
        attempt_id: 9002,
        chosen_answer: "E",
        br_answer: "A",
        is_correct: false,
        br_correct: true,
        time_ms: 132000,
        outcome: "timing_problem",
      },
    },
    {
      question: { ...sampleReviewQuestion, id: 103, q_type: "Parallel", correct_answer: "B" },
      attempt: {
        attempt_id: 9003,
        chosen_answer: "D",
        br_answer: "D",
        is_correct: false,
        br_correct: false,
        time_ms: 156000,
        outcome: "concept_gap",
      },
    },
    {
      question: { ...sampleReviewQuestion, id: 104, q_type: "Flaw", correct_answer: "A" },
      attempt: {
        attempt_id: 9004,
        chosen_answer: "A",
        br_answer: "C",
        is_correct: true,
        br_correct: false,
        time_ms: 41000,
        outcome: "lucky",
      },
    },
  ],
};

export const sampleByType: ByTypeRow[] = [
  { q_type: "Parallel", section_type: "LR", attempts: 38, accuracy: 0.61, avg_time_ms: 102000, trend: "down" },
  { q_type: "NecessaryAssumption", section_type: "LR", attempts: 52, accuracy: 0.74, avg_time_ms: 78000, trend: "flat" },
  { q_type: "Flaw", section_type: "LR", attempts: 61, accuracy: 0.79, avg_time_ms: 64000, trend: "up" },
  { q_type: "Weaken", section_type: "LR", attempts: 47, accuracy: 0.83, avg_time_ms: 71000, trend: "up" },
  { q_type: "Strengthen", section_type: "LR", attempts: 44, accuracy: 0.8, avg_time_ms: 69000, trend: "flat" },
  { q_type: "MainPoint", section_type: "RC", attempts: 22, accuracy: 0.86, avg_time_ms: 55000, trend: "up" },
  { q_type: "Comparative", section_type: "RC", attempts: 18, accuracy: 0.66, avg_time_ms: 121000, trend: "down" },
  { q_type: "Inference", section_type: "RC", attempts: 31, accuracy: 0.71, avg_time_ms: 88000, trend: "flat" },
];

export const sampleTiming: TimingRow[] = Array.from({ length: 25 }, (_, i) => {
  const base = 60000 + Math.round(Math.sin(i / 2) * 25000) + i * 1200;
  return {
    question_order: i + 1,
    time_ms: Math.max(20000, base),
    is_correct: i % 4 !== 0,
    difficulty: ((i % 5) + 1),
  };
});

export const sampleGap: BlindReviewGap = {
  timed_accuracy: 0.78,
  br_accuracy: 0.91,
  gap: 0.13,
  by_type: [
    { q_type: "Parallel", timed_accuracy: 0.61, br_accuracy: 0.82 },
    { q_type: "NecessaryAssumption", timed_accuracy: 0.74, br_accuracy: 0.9 },
    { q_type: "Flaw", timed_accuracy: 0.79, br_accuracy: 0.88 },
    { q_type: "Weaken", timed_accuracy: 0.83, br_accuracy: 0.95 },
    { q_type: "Comparative", timed_accuracy: 0.66, br_accuracy: 0.78 },
  ],
};

export const sampleTraps: TrapRow[] = [
  { trap_type: "reversal", times_fell_for: 14, pct: 0.31 },
  { trap_type: "out_of_scope", times_fell_for: 11, pct: 0.24 },
  { trap_type: "degree", times_fell_for: 8, pct: 0.18 },
  { trap_type: "too_strong", times_fell_for: 6, pct: 0.13 },
  { trap_type: "half_right", times_fell_for: 4, pct: 0.09 },
  { trap_type: "scope_shift", times_fell_for: 2, pct: 0.05 },
];

export const sampleDifficulty: DifficultyRow[] = [
  { difficulty: 1, attempts: 41, accuracy: 0.95, avg_time_ms: 42000 },
  { difficulty: 2, attempts: 58, accuracy: 0.89, avg_time_ms: 55000 },
  { difficulty: 3, attempts: 73, accuracy: 0.78, avg_time_ms: 71000 },
  { difficulty: 4, attempts: 49, accuracy: 0.64, avg_time_ms: 92000 },
  { difficulty: 5, attempts: 27, accuracy: 0.48, avg_time_ms: 118000 },
];

export const sampleSessions: SessionSummary[] = [
  { id: 999, type: "section", started: "2026-05-19T14:00:00Z", ended: "2026-05-19T14:35:00Z", scaled_score: 164, question_count: 25 },
  { id: 998, type: "section", started: "2026-05-12T09:10:00Z", ended: "2026-05-12T09:46:00Z", scaled_score: 162, question_count: 25 },
  { id: 997, type: "drill", started: "2026-05-08T18:00:00Z", ended: "2026-05-08T18:18:00Z", scaled_score: null, question_count: 10 },
];

export const sampleActivity: ActivityDay[] = Array.from({ length: 120 }, (_, i) => {
  const d = new Date();
  d.setDate(d.getDate() - (119 - i));
  const q = Math.max(0, Math.round(Math.sin(i / 4) * 8 + 6));
  return {
    date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
    questions: q,
    minutes: q * 2,
    correct: Math.round(q * 0.75),
    sessions: q > 0 ? 1 : 0,
  };
});

export const sampleSrs: SrsDue = {
  due_count: 14,
  cards: lrQuestions.slice(0, 3).map((q, i) => ({ ...q, card_id: 500 + i })),
};

export const sampleErrorLog: ErrorLogEntry[] = [
  {
    id: 1,
    question: sampleReviewQuestion,
    reason: "trap",
    note: "Picked the reversal — read 'weakens' as 'strengthens' under time pressure.",
    ai_diagnosis: "Recurring reversal errors on Weaken questions when time-pressured.",
    created_at: "2026-05-18T10:30:00Z",
  },
  {
    id: 2,
    question: { ...sampleReviewQuestion, id: 103, q_type: "Parallel" },
    reason: "concept",
    note: "Didn't recognize the contrapositive structure.",
    created_at: "2026-05-17T09:12:00Z",
  },
];

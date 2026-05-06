import type { LearningObjective, Question, QuestionResult } from './learningTypes';

export type TutorCapability =
  | 'missed-answer-explanation'
  | 'extra-practice'
  | 'weak-topic-summary'
  | 'lesson-question'
  | 'constructed-response-critique';

export interface TutorProviderMetadata {
  id: string;
  label: string;
  enabled: boolean;
  localOnly: boolean;
  capabilities: TutorCapability[];
}

export interface TutorResponse {
  text: string;
  sourceIds: string[];
  safetyFlags: string[];
  blockedReason?: string;
}

export interface TutorContext {
  domain: string;
  topic: string;
  lessonTitle?: string;
  objective?: LearningObjective;
  question?: Question;
  latestResult?: QuestionResult;
  localMasteryScore?: number;
  sourceIds?: string[];
}

export interface TutorExplanationRequest {
  context: TutorContext;
  learnerPrompt?: string;
}

export interface TutorPracticeRequest {
  context: TutorContext;
  count: number;
  difficulty?: 'foundation' | 'intermediate' | 'advanced';
}

export interface TutorConstructedResponseRequest {
  context: TutorContext;
  response: string;
  rubricCriteria: Array<{ id: string; label: string; maxPoints: number }>;
}

export interface TutorProvider {
  metadata: TutorProviderMetadata;
  explainMissedAnswer(request: TutorExplanationRequest): Promise<TutorResponse>;
  generateExtraPractice(request: TutorPracticeRequest): Promise<Question[]>;
  summarizeWeakTopic(context: TutorContext): Promise<TutorResponse>;
  answerLessonQuestion(request: TutorExplanationRequest): Promise<TutorResponse>;
  critiqueConstructedResponse(request: TutorConstructedResponseRequest): Promise<TutorResponse>;
}

export function createUnavailableTutorProvider(): TutorProvider {
  async function unavailable(): Promise<TutorResponse> {
    return {
      text: '',
      sourceIds: [],
      safetyFlags: [],
      blockedReason: 'AI tutoring is not enabled. Core QuantVault learning features are deterministic and local-first.',
    };
  }

  return {
    metadata: {
      id: 'unavailable',
      label: 'Unavailable Tutor Provider',
      enabled: false,
      localOnly: true,
      capabilities: [],
    },
    explainMissedAnswer: unavailable,
    generateExtraPractice: async () => [],
    summarizeWeakTopic: unavailable,
    answerLessonQuestion: unavailable,
    critiqueConstructedResponse: unavailable,
  };
}

export function createMockTutorProvider(): TutorProvider {
  function groundedResponse(text: string, sourceIds: string[] = []): TutorResponse {
    return {
      text,
      sourceIds,
      safetyFlags: [],
    };
  }

  return {
    metadata: {
      id: 'mock-local',
      label: 'Mock Local Tutor',
      enabled: true,
      localOnly: true,
      capabilities: [
        'missed-answer-explanation',
        'weak-topic-summary',
        'lesson-question',
        'constructed-response-critique',
      ],
    },
    explainMissedAnswer: async ({ context }) =>
      groundedResponse(
        `Review ${context.objective?.title || context.lessonTitle || context.topic}. Start from the authored explanation, identify the missed concept, then redo one adjacent local question before advancing.`,
        context.sourceIds || ([context.question?.id, context.objective?.id].filter(Boolean) as string[]),
      ),
    generateExtraPractice: async () => [],
    summarizeWeakTopic: async (context) =>
      groundedResponse(
        `Your local mastery signal points to ${context.objective?.title || context.topic}. Prioritize due reviews, then run a short topic drill and tag the error category after each miss.`,
        context.sourceIds || ([context.objective?.id].filter(Boolean) as string[]),
      ),
    answerLessonQuestion: async ({ context }) =>
      groundedResponse(
        `Use the local lesson and formulas for ${context.lessonTitle || context.topic}. I can summarize grounded hints here once an AI provider is enabled.`,
        context.sourceIds || ([context.objective?.id].filter(Boolean) as string[]),
      ),
    critiqueConstructedResponse: async ({ context, rubricCriteria }) =>
      groundedResponse(
        `Self-score against ${rubricCriteria.length} rubric criteria. Check command words first, then confirm every claimed point is tied to the prompt facts.`,
        context.sourceIds || ([context.objective?.id].filter(Boolean) as string[]),
      ),
  };
}

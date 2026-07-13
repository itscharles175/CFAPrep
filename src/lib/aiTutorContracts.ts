import type { LearningObjective, Question, QuestionResult } from './learningTypes';

export type TutorCapability =
  | 'missed-answer-explanation'
  | 'grounded-hint'
  | 'extra-practice'
  | 'next-practice-suggestion'
  | 'weak-topic-summary'
  | 'lesson-question'
  | 'constructed-response-critique';

export interface TutorProviderMetadata {
  id: string;
  label: string;
  enabled: boolean;
  localOnly: boolean;
  capabilities: TutorCapability[];
  policy: TutorProviderPolicy;
}

export interface TutorResponse {
  text: string;
  sourceIds: string[];
  safetyFlags: string[];
  blockedReason?: string;
  citations?: GroundingCitation[];
  groundingRequired?: boolean;
  groundingStatus?: 'grounded' | 'refused' | 'not-required';
  auditLog?: TutorAuditLog;
}

export interface GroundingCitation {
  sourceId: string;
  label: string;
  locator?: string;
  excerptHash?: string;
}

export interface GroundedTutorResponse extends TutorResponse {
  citations: GroundingCitation[];
  groundingRequired: boolean;
  groundingStatus: 'grounded' | 'refused' | 'not-required';
  auditLog?: TutorAuditLog;
}

export interface TutorProviderPolicy {
  optInRequired: boolean;
  sourceGroundingRequired: boolean;
  allowNetwork: boolean;
  logResponses: boolean;
  defaultEnabled: boolean;
}

export interface TutorAuditLog {
  id: string;
  providerId: string;
  capability: TutorCapability;
  createdAt: string;
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

export interface TutorEvalCase {
  id: string;
  capability: TutorCapability;
  requiredSourceIds: string[];
  allowBlocked?: boolean;
  requireGrounding?: boolean;
  sourceRequired?: boolean;
}

export interface TutorEvalResult {
  caseId: string;
  passed: boolean;
  issues: string[];
}

export interface TutorProvider {
  metadata: TutorProviderMetadata;
  explainMissedAnswer(request: TutorExplanationRequest): Promise<TutorResponse>;
  provideGroundedHint(request: TutorExplanationRequest): Promise<TutorResponse>;
  generateExtraPractice(request: TutorPracticeRequest): Promise<Question[]>;
  suggestNextPractice(request: TutorPracticeRequest): Promise<TutorResponse>;
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
      policy: {
        optInRequired: true,
        sourceGroundingRequired: true,
        allowNetwork: false,
        logResponses: false,
        defaultEnabled: false,
      },
    },
    explainMissedAnswer: unavailable,
    provideGroundedHint: unavailable,
    generateExtraPractice: async () => [],
    suggestNextPractice: unavailable,
    summarizeWeakTopic: unavailable,
    answerLessonQuestion: unavailable,
    critiqueConstructedResponse: unavailable,
  };
}

export function createMockTutorProvider(): TutorProvider {
  function groundedResponse(text: string, sourceIds: string[] = [], capability: TutorCapability = 'grounded-hint'): GroundedTutorResponse {
    if (!sourceIds.length) {
      return {
        text: '',
        sourceIds: [],
        safetyFlags: ['missing-grounding'],
        blockedReason: 'Grounding citations are required before tutor output can be shown.',
        citations: [],
        groundingRequired: true,
        groundingStatus: 'refused',
        auditLog: {
          id: `tutor-audit:${Date.now()}`,
          providerId: 'mock-local',
          capability,
          createdAt: new Date().toISOString(),
          sourceIds: [],
          safetyFlags: ['missing-grounding'],
          blockedReason: 'Grounding citations are required before tutor output can be shown.',
        },
      };
    }
    return {
      text,
      sourceIds,
      safetyFlags: [],
      citations: sourceIds.map((sourceId) => ({
        sourceId,
        label: sourceId,
        locator: 'local-authoring-pack',
        excerptHash: `local:${sourceId}`,
      })),
      groundingRequired: true,
      groundingStatus: 'grounded',
      auditLog: {
        id: `tutor-audit:${Date.now()}`,
        providerId: 'mock-local',
        capability,
        createdAt: new Date().toISOString(),
        sourceIds,
        safetyFlags: [],
      },
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
        'grounded-hint',
        'next-practice-suggestion',
        'weak-topic-summary',
        'lesson-question',
        'constructed-response-critique',
      ],
      policy: {
        optInRequired: true,
        sourceGroundingRequired: true,
        allowNetwork: false,
        logResponses: true,
        defaultEnabled: false,
      },
    },
    explainMissedAnswer: async ({ context }) =>
      groundedResponse(
        `Review ${context.objective?.title || context.lessonTitle || context.topic}. Start from the authored explanation, identify the missed concept, then redo one adjacent local question before advancing.`,
        context.sourceIds || ([context.question?.id, context.objective?.id].filter(Boolean) as string[]),
        'missed-answer-explanation',
      ),
    provideGroundedHint: async ({ context }) =>
      groundedResponse(
        `Hint: read the command word, name the controlling local fact, and connect it to ${context.objective?.title || context.topic} before looking at choices.`,
        context.sourceIds || ([context.question?.id, context.objective?.id].filter(Boolean) as string[]),
        'grounded-hint',
      ),
    generateExtraPractice: async () => [],
    suggestNextPractice: async ({ context, count, difficulty }) =>
      groundedResponse(
        `Next practice: complete ${count} ${difficulty || 'mixed'} local item${count === 1 ? '' : 's'} for ${context.objective?.title || context.topic}, then add any miss to the review inbox.`,
        context.sourceIds || ([context.objective?.id, context.question?.id].filter(Boolean) as string[]),
        'next-practice-suggestion',
      ),
    summarizeWeakTopic: async (context) =>
      groundedResponse(
        `Your local mastery signal points to ${context.objective?.title || context.topic}. Prioritize due reviews, then run a short topic drill and tag the error category after each miss.`,
        context.sourceIds || ([context.objective?.id].filter(Boolean) as string[]),
        'weak-topic-summary',
      ),
    answerLessonQuestion: async ({ context }) =>
      groundedResponse(
        `Use the local lesson and formulas for ${context.lessonTitle || context.topic}. I can summarize grounded hints here once an AI provider is enabled.`,
        context.sourceIds || ([context.objective?.id].filter(Boolean) as string[]),
        'lesson-question',
      ),
    critiqueConstructedResponse: async ({ context, rubricCriteria }) =>
      groundedResponse(
        `Self-score against ${rubricCriteria.length} rubric criteria. Check command words first, then confirm every claimed point is tied to the prompt facts.`,
        context.sourceIds || ([context.objective?.id].filter(Boolean) as string[]),
        'constructed-response-critique',
      ),
  };
}

export function isTutorEnabledFromEnv() {
  return import.meta.env.VITE_AI_ENABLED === 'true';
}

export function getTutorProvider() {
  return isTutorEnabledFromEnv() ? createMockTutorProvider() : createUnavailableTutorProvider();
}

export function evaluateTutorResponse(evalCase: TutorEvalCase, response: TutorResponse): TutorEvalResult {
  const groundedResponse = response as Partial<GroundedTutorResponse>;
  const issues = [
    !evalCase.allowBlocked && response.blockedReason ? `Response is blocked: ${response.blockedReason}` : '',
    !response.blockedReason && !response.text.trim() ? 'Response text is empty.' : '',
    evalCase.sourceRequired && !response.blockedReason && response.sourceIds.length === 0 ? 'Grounded tutor output requires at least one sourceId.' : '',
    evalCase.requireGrounding && !response.blockedReason && groundedResponse.groundingStatus !== 'grounded'
      ? 'Grounded tutor output must report groundingStatus=grounded.'
      : '',
    evalCase.requireGrounding && !response.blockedReason && !groundedResponse.citations?.length
      ? 'Grounded tutor output requires citations.'
      : '',
    ...evalCase.requiredSourceIds
      .filter((sourceId) => !response.sourceIds.includes(sourceId))
      .map((sourceId) => `Missing required sourceId: ${sourceId}`),
    !Array.isArray(response.safetyFlags) ? 'safetyFlags must be an array.' : '',
  ].filter(Boolean);

  return {
    caseId: evalCase.id,
    passed: issues.length === 0,
    issues,
  };
}

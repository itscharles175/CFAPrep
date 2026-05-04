import type { LearningObjective, Question, QuestionResult } from './learningTypes';

export interface TutorContext {
  domain: string;
  topic: string;
  lessonTitle?: string;
  objective?: LearningObjective;
  question?: Question;
  latestResult?: QuestionResult;
  localMasteryScore?: number;
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

export interface TutorProvider {
  explainMissedAnswer(request: TutorExplanationRequest): Promise<string>;
  generateExtraPractice(request: TutorPracticeRequest): Promise<Question[]>;
  summarizeWeakTopic(context: TutorContext): Promise<string>;
  answerLessonQuestion(request: TutorExplanationRequest): Promise<string>;
}

export function createUnavailableTutorProvider(): TutorProvider {
  async function unavailable<T>(): Promise<T> {
    throw new Error('AI tutoring is not enabled. Core QuantVault learning features are deterministic and local-first.');
  }

  return {
    explainMissedAnswer: () => unavailable<string>(),
    generateExtraPractice: () => unavailable<Question[]>(),
    summarizeWeakTopic: () => unavailable<string>(),
    answerLessonQuestion: () => unavailable<string>(),
  };
}

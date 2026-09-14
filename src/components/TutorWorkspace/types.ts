import type { CfaSourceChunk, CfaSourceDocument } from '../../lib/cfaSourceTypes';

export type TutorSourceProvenance = 'built-in' | 'imported' | 'generated';
export type TutorCoverage = 'ready' | 'partial' | 'missing' | 'unknown';

export interface TutorSource {
  id: string;
  title: string;
  subtitle: string;
  provenance: TutorSourceProvenance;
  coverage: TutorCoverage;
  kind: 'cfa-document' | 'notebook-source' | 'generated-note';
  document?: CfaSourceDocument;
  generatedBody?: string;
}

export interface TutorCitation {
  id: string;
  number: number;
  sourceId: string;
  title: string;
  locator?: string;
  snippet?: string;
  provenance: TutorSourceProvenance;
}

export interface TutorTurn {
  id: string;
  question: string;
  answer: string;
  citations: TutorCitation[];
  sourceId: string;
  createdAt: string;
}

export interface TutorReaderContent {
  chunks: CfaSourceChunk[];
  state: 'idle' | 'loading' | 'ready' | 'empty' | 'error';
  error?: string;
}

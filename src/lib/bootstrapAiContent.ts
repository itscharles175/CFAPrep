import { getStorage } from './storage';

// Bootstrap pre-generated AI content into the in-app caches on first run.
//
// `npm run content:expand` produces a `public/cfa-generated.json` companion
// bundle of AI-generated questions + flashcards per (level, topic). At app
// startup we fetch it and, for any (level, topic) that doesn't already have
// a cached row, seed db.settings under the existing cache keys the CfaModule
// AI-practice and AI-flashcards panels look up. Idempotent: never overwrites
// caches the user has generated locally; honors a per-bundle marker so the
// import only runs once per bundle version.

const BOOTSTRAP_MARKER_KEY = 'ai-content-bootstrap-marker';

interface GeneratedTopicEntry {
  questions?: unknown[];
  flashcards?: unknown[];
  generatedAt?: string;
}

interface GeneratedBundle {
  kind: 'cfa-generated-content';
  generatedAt: string;
  byTopic: Record<string, Record<string, GeneratedTopicEntry>>;
}

export interface BootstrapAiContentResult {
  seeded: number;
  skipped: number;
  source: 'missing' | 'already-imported' | 'bundle';
  generatedAt?: string;
}

function answerCacheKeyForAi(level: string, topic: string): string {
  // Mirror localLlm.js's `ai-questions:${level}:${topic}` shape.
  return `ai-questions:${level}:${topic}`;
}

function flashCacheKeyForAi(level: string, topic: string): string {
  // Mirror localLlm.js's `flash-cards:${level}:${topic}` shape.
  return `flash-cards:${level}:${topic}`;
}

async function fetchGeneratedBundle(): Promise<GeneratedBundle | null> {
  try {
    const response = await fetch('/cfa-generated.json', { credentials: 'omit' });
    if (!response.ok) return null;
    const payload = (await response.json()) as unknown;
    if (
      !payload ||
      typeof payload !== 'object' ||
      (payload as { kind?: unknown }).kind !== 'cfa-generated-content'
    ) {
      return null;
    }
    return payload as GeneratedBundle;
  } catch {
    // No bundle present (development; or first run before `npm run content:expand`).
    return null;
  }
}

export async function bootstrapAiContent(): Promise<BootstrapAiContentResult> {
  const payload = await fetchGeneratedBundle();
  if (!payload?.byTopic) return { seeded: 0, skipped: 0, source: 'missing' };

  // Skip if this exact generatedAt has already been imported.
  try {
    const marker = await getStorage().settings.get(BOOTSTRAP_MARKER_KEY);
    if (marker?.value === payload.generatedAt) {
      return { seeded: 0, skipped: 0, source: 'already-imported' };
    }
  } catch {
    // Best-effort marker — if Dexie isn't ready, we'll re-check inside the loop.
  }

  let seeded = 0;
  let skipped = 0;
  for (const [level, topics] of Object.entries(payload.byTopic)) {
    for (const [topic, entry] of Object.entries(topics)) {
      // Seed questions if missing.
      if (entry?.questions?.length) {
        const qKey = answerCacheKeyForAi(level, topic);
        try {
          const existing = await getStorage().settings.get(qKey);
          const existingValue = existing?.value as { questions?: unknown[] } | undefined;
          if (!existingValue?.questions?.length) {
            await getStorage().settings.put({
              key: qKey,
              value: {
                questions: entry.questions,
                generatedAt: entry.generatedAt || payload.generatedAt,
                source: 'bootstrap',
              },
              updatedAt: new Date().toISOString(),
            });
            seeded += 1;
          } else {
            skipped += 1;
          }
        } catch {
          // best-effort
        }
      }
      // Seed flashcards if missing.
      if (entry?.flashcards?.length) {
        const fKey = flashCacheKeyForAi(level, topic);
        try {
          const existing = await getStorage().settings.get(fKey);
          const existingValue = existing?.value as { flashcards?: unknown[] } | undefined;
          if (!existingValue?.flashcards?.length) {
            await getStorage().settings.put({
              key: fKey,
              value: {
                flashcards: entry.flashcards,
                generatedAt: entry.generatedAt || payload.generatedAt,
                source: 'bootstrap',
              },
              updatedAt: new Date().toISOString(),
            });
            seeded += 1;
          } else {
            skipped += 1;
          }
        } catch {
          // best-effort
        }
      }
    }
  }

  try {
    await getStorage().settings.put({
      key: BOOTSTRAP_MARKER_KEY,
      value: payload.generatedAt,
      updatedAt: new Date().toISOString(),
    });
  } catch {
    // best-effort
  }

  return { seeded, skipped, source: 'bundle', generatedAt: payload.generatedAt };
}

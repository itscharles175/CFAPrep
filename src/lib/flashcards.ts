import { loadCfaLevelContent } from '../domains/cfa/cfaLoaders';
import { cfaLevels } from '../domains/cfa/cfaSummary';
import { DEFAULT_LEVEL3_PATHWAY } from '../domains/cfa/cfaLevel3Pathways';
import type { Flashcard } from '../lib/contentTypes';
import type { VaultBookmark } from '../lib/learningTypes';

export function buildBookmarkFlashcards(bookmarks: VaultBookmark[] = []): Flashcard[] {
  return bookmarks.map((bookmark) => ({
    id: `bookmark:${bookmark.id}`,
    domain: bookmark.domain || 'cfa',
    topic: bookmark.moduleId || 'bookmarks',
    type: 'bookmark',
    front: bookmark.title,
    back: `Saved ${bookmark.type} bookmark. Open the source to review your marked item.`,
    sourcePath: bookmark.path,
    tags: ['bookmark', bookmark.type],
  }));
}

export interface BuildFlashcardsOptions {
  level3Pathway?: string;
}

export async function buildFlashcards(bookmarks: VaultBookmark[] = [], options: BuildFlashcardsOptions = {}): Promise<Flashcard[]> {
  const level3Pathway = options.level3Pathway || DEFAULT_LEVEL3_PATHWAY;
  const levels = await Promise.all(
    cfaLevels.map((level) => loadCfaLevelContent(level.id, level.id === 'level3' ? { pathway: level3Pathway } : {})),
  );
  const cfaFlashcards: Flashcard[] = levels.flatMap((level: { topics: Array<{ flashcards: Flashcard[] }> }) =>
    level.topics.flatMap((topic) => topic.flashcards),
  );

  return [...buildBookmarkFlashcards(bookmarks), ...cfaFlashcards];
}

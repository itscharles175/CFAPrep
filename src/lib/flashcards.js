import { loadCfaLevelContent } from '../domains/cfa/cfaLoaders';
import { cfaLevels } from '../domains/cfa/cfaSummary';

export function buildBookmarkFlashcards(bookmarks = []) {
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

export async function buildFlashcards(bookmarks = []) {
  const levels = await Promise.all(cfaLevels.map((level) => loadCfaLevelContent(level.id)));
  const cfaFlashcards = levels.flatMap((level) => level.topics.flatMap((topic) => topic.flashcards));

  return [...buildBookmarkFlashcards(bookmarks), ...cfaFlashcards];
}

import { cfaAllFlashcards } from '../domains/cfa/cfaLevels';

export function buildFlashcards(bookmarks = []) {
  const bookmarkCards = bookmarks.map((bookmark) => ({
    id: `bookmark:${bookmark.id}`,
    domain: bookmark.domain || 'cfa',
    topic: bookmark.moduleId || 'bookmarks',
    type: 'bookmark',
    front: bookmark.title,
    back: `Saved ${bookmark.type} bookmark. Open the source to review your marked item.`,
    sourcePath: bookmark.path,
    tags: ['bookmark', bookmark.type],
  }));

  return [...bookmarkCards, ...cfaAllFlashcards];
}

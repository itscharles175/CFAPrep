import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { BadgeCheck, BookOpen, RotateCcw } from 'lucide-react';
import { PageHeader, MetricCard, SegmentedControl } from '../components/ui/Primitives';
import { buildFlashcards } from '../lib/flashcards';
import { getBookmarks, recordFlashcardResult } from '../lib/learning';
import { getCfaRuntimeReport } from '../domains/cfa/cfaSummary';

const filters = [
  { value: 'all', label: 'All' },
  { value: 'formula', label: 'Formulas' },
  { value: 'definition', label: 'Objectives' },
  { value: 'bookmark', label: 'Bookmarks' },
];

export default function Flashcards() {
  const [bookmarks, setBookmarks] = useState([]);
  const [cards, setCards] = useState([]);
  const [loadingCards, setLoadingCards] = useState(true);
  const [filter, setFilter] = useState('all');
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const visibleCards = useMemo(() => (filter === 'all' ? cards : cards.filter((card) => card.type === filter)), [cards, filter]);
  const card = visibleCards[index % Math.max(1, visibleCards.length)];
  const level1Runtime = getCfaRuntimeReport().levels.find((item) => item.level === 'level1');

  useEffect(() => {
    getBookmarks().then(setBookmarks);
  }, []);

  useEffect(() => {
    let cancelled = false;
    buildFlashcards(bookmarks)
      .then((deck) => {
        if (!cancelled) setCards(deck);
      })
      .finally(() => {
        if (!cancelled) setLoadingCards(false);
      });
    return () => {
      cancelled = true;
    };
  }, [bookmarks]);

  function nextCard(mode) {
    if (!card) return;
    recordFlashcardResult({
      domain: card?.domain || 'cfa',
      topic: card?.topic || 'flashcards',
      cardId: card.id,
      cardType: card.type,
      title: card.front,
      path: card.sourcePath,
      outcome: mode,
      elapsedSeconds: 20,
    });
    setIndex((value) => (value + 1) % Math.max(1, visibleCards.length));
    setRevealed(false);
  }

  return (
    <div className="page-container">
      <PageHeader
        badge={level1Runtime?.mode === 'exam-ready' ? 'FLASHCARDS · EXAM-READY' : 'FLASHCARDS'}
        title="Local Flashcards"
        subtitle={
          level1Runtime?.mode === 'exam-ready'
            ? 'Generated from editorial exam-ready Level I and II packs, formulas, learning objectives, and your bookmarks. No AI dependency.'
            : 'Generated from formulas, learning objectives, and your bookmarks. No AI dependency.'
        }
      />

      <div className="grid-3" style={{ marginBottom: 'var(--space-6)' }}>
        <MetricCard label="Cards" value={visibleCards.length} detail={`${cards.length} total generated`} icon={BookOpen} />
        <MetricCard label="Mode" value={filter} detail="Current drill type" icon={RotateCcw} tone="warning" />
        <MetricCard label="Progress" value={visibleCards.length ? `${index + 1}/${visibleCards.length}` : '-'} detail="Current deck position" icon={BadgeCheck} tone="success" />
      </div>

      <SegmentedControl label="Flashcard type" options={filters} value={filter} onChange={(value) => { setFilter(value); setIndex(0); setRevealed(false); }} />

      {loadingCards ? (
        <div className="flashcard-panel glass-card no-hover" aria-busy="true">
          <div className="skeleton skeleton-heading" />
          <div className="skeleton skeleton-text" />
          <div className="skeleton skeleton-card" />
        </div>
      ) : card ? (
        <div className="flashcard-panel glass-card no-hover">
          <div className="badge badge-purple">{card.type}</div>
          <h2>{card.front}</h2>
          {revealed ? (
            <>
              <p style={{ whiteSpace: 'pre-line' }}>{card.back}</p>
              <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
                <button className="btn btn-secondary" onClick={() => nextCard('again')}>Again</button>
                <button className="btn btn-primary" onClick={() => nextCard('known')}>Known</button>
                <Link to={card.sourcePath} className="btn btn-secondary">Open Source</Link>
              </div>
            </>
          ) : (
            <button className="btn btn-primary btn-lg" onClick={() => setRevealed(true)}>Reveal</button>
          )}
        </div>
      ) : (
        <div className="glass-card no-hover">No cards in this filter yet.</div>
      )}
    </div>
  );
}

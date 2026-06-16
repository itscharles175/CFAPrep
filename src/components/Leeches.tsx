/**
 * Leech / concept-gap list renderer (roadmap LEARN-5).
 *
 * A presentational list of canonical {@link CrossDomainReviewCard} rows merged
 * across both data planes (LSAT sidecar + host CFA/Quant/Excel) by
 * `leechBridge.fetchLeechesAndGaps`. LSAT rows deep-link into the LSAT SRS review
 * flow (`/lsat/srs`, a hard navigation — the LSAT app is a separate top-level
 * branch); host rows are shown inline with their lapse/leech/origin badges (the
 * host owns its own review surface, so there's no cross-app deep link).
 *
 * Pure presentation — no I/O. The page (`pages/LeechesAndGaps.tsx`) owns the
 * fetch + tab state and hands this the already-merged rows.
 */
import type { ReactNode } from 'react';
import { StatusBadge } from './ui/Primitives';
import EmptyState from './EmptyState';
import { LSAT_SRS_PATH } from '../lib/leechBridge';
import type { CrossDomainReviewCard } from '../lib/dataDictionary';
import { parseCrossDomainId } from '../lib/dataDictionary';

export interface LeechesProps {
  /** Already-merged canonical rows (LSAT + host) for the active tab. */
  cards: CrossDomainReviewCard[];
  /** "leech" tints rows toward the lapse count; "gap" toward the origin reason. */
  variant: 'leech' | 'gap';
  /** Empty-state copy shown when there are no rows. */
  emptyTitle: string;
  emptyDescription: string;
}

function planeLabel(card: CrossDomainReviewCard): string {
  const plane = parseCrossDomainId(card.crossId)?.plane ?? card.domain;
  return plane === 'lsat' ? 'LSAT' : plane.toUpperCase();
}

function isLsat(card: CrossDomainReviewCard): boolean {
  return (parseCrossDomainId(card.crossId)?.plane ?? card.domain) === 'lsat';
}

function rowMeta(card: CrossDomainReviewCard, variant: 'leech' | 'gap'): ReactNode {
  const bits: ReactNode[] = [];
  if (variant === 'leech' && typeof card.lapses === 'number') {
    bits.push(
      <StatusBadge key="lapses" tone="danger">
        {card.lapses} {card.lapses === 1 ? 'lapse' : 'lapses'}
      </StatusBadge>,
    );
  }
  if (card.origin) {
    bits.push(
      <StatusBadge key="origin" tone="vault">
        {card.origin.replace(/[-_]/g, ' ')}
      </StatusBadge>,
    );
  }
  if (card.itemType) {
    bits.push(
      <StatusBadge key="type" tone="accent">
        {card.itemType}
      </StatusBadge>,
    );
  }
  return bits;
}

export default function Leeches({ cards, variant, emptyTitle, emptyDescription }: LeechesProps) {
  if (cards.length === 0) {
    return <EmptyState title={emptyTitle} description={emptyDescription} />;
  }
  return (
    <ul className="card-list" role="list" aria-label={variant === 'leech' ? 'Leeches' : 'Concept gaps'}>
      {cards.map((card) => {
        const lsat = isLsat(card);
        return (
          <li key={card.crossId} className="card card-row">
            <div className="card-row-main">
              <div className="card-row-head">
                <StatusBadge tone={lsat ? 'exam' : 'study'}>{planeLabel(card)}</StatusBadge>
                {card.leech && (
                  <StatusBadge tone="danger" aria-label="Flagged as a leech">
                    Leech
                  </StatusBadge>
                )}
              </div>
              <p className="card-row-title">{card.title}</p>
              <div className="card-row-meta">{rowMeta(card, variant)}</div>
            </div>
            <div className="card-row-actions">
              {lsat ? (
                // LSAT app is a separate top-level branch served at /lsat/* — a
                // hard navigation (not a client-side <Link>) is required to cross
                // the basename boundary into the LSAT SRS review flow.
                <a className="btn btn-secondary" href={LSAT_SRS_PATH}>
                  Review in LSAT
                </a>
              ) : (
                <span className="card-row-inline-note">In your domain review queue</span>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Leeches & Gaps — unified remediation page (roadmap LEARN-5).
 *
 * A standalone page (reached via its own `/leeches` route — NOT a System Health
 * panel) that surfaces the two cross-domain remediation queues the LSAT backend
 * tracks, MERGED with the host's mirrored rows:
 *
 *   - LEECHES — cards lapsed too many times (sorted most-lapsed first);
 *   - GAPS    — concept gaps (origin marks unfinished understanding).
 *
 * Both queues are fetched with `include_host=true` so the backend also returns
 * the host (CFA/Quant/Excel) rows it has mirrored (DATA-4a), already projected
 * onto the canonical {@link CrossDomainReviewCard} shape. LSAT rows deep-link
 * into the LSAT SRS flow; host rows render inline (`components/Leeches.tsx`).
 *
 * Fully degrading: when the sidecar is offline the bridge returns empty queues
 * and the page shows its empty states rather than erroring.
 */
import { useEffect, useState } from 'react';
import { PageHeader, SegmentedControl } from '../components/ui/Primitives';
import { SkeletonList } from '../components/feedback';
import Leeches from '../components/Leeches';
import { fetchLeechesAndGaps, type LeechesAndGapsResult } from '../lib/leechBridge';

type Tab = 'leeches' | 'gaps';

const TABS: Array<{ value: Tab; label: string }> = [
  { value: 'leeches', label: 'Leeches' },
  { value: 'gaps', label: 'Concept gaps' },
];

export default function LeechesAndGaps() {
  const [tab, setTab] = useState<Tab>('leeches');
  const [data, setData] = useState<LeechesAndGapsResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchLeechesAndGaps({ include_host: true }).then((result) => {
      if (!cancelled) setData(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const loading = data === null;
  const leechCount = data?.leeches.length ?? 0;
  const gapCount = data?.gaps.length ?? 0;

  return (
    <div className="page-container">
      <PageHeader
        eyebrow="Remediation"
        title="Leeches & Gaps"
        subtitle="Cards that keep lapsing and concept gaps to close — unified across LSAT and your domains."
        tone="vault"
      />
      <SegmentedControl
        label="Remediation queue"
        value={tab}
        onChange={(value) => setTab(value as Tab)}
        options={[
          { value: 'leeches', label: `Leeches (${leechCount})` },
          { value: 'gaps', label: `Concept gaps (${gapCount})` },
        ]}
      />
      {loading ? (
        <SkeletonList rows={5} />
      ) : tab === 'leeches' ? (
        <Leeches
          cards={data.leeches}
          variant="leech"
          emptyTitle="No leeches"
          emptyDescription="No cards have lapsed past the leech threshold. Keep your reviews up to date and they'll surface here if recall keeps slipping."
        />
      ) : (
        <Leeches
          cards={data.gaps}
          variant="gap"
          emptyTitle="No concept gaps"
          emptyDescription="No open concept gaps. Gaps appear when a question is missed both under time and in blind review, signalling understanding to rebuild."
        />
      )}
    </div>
  );
}

// Keep the tab list importable for tests / future nav wiring without re-deriving it.
export { TABS as leechesAndGapsTabs };

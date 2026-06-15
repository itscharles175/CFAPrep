import { Link } from 'react-router-dom';
import { BrainCircuit, CalendarClock, ChevronRight } from 'lucide-react';
import { Panel, StatusBadge } from '../ui/Primitives';
import type { ReviewItem, MasterySnapshot } from '../../lib/learningTypes';
import './dashboard-hierarchy.css';

/**
 * UB2 — the single dominant "what to study now" card. Replaces the old
 * three-equal-panels row with one hero: the primary next-action (blown up,
 * left) and a compact signals rail (due reviews + weak objectives, right) so
 * the most urgent context stays above the fold without a second viewport of
 * equal-weight cards.
 *
 * Presentational only. The recommendation + signal arrays come straight from
 * the Dashboard's existing useProgressSummary() data; navigation targets are
 * unchanged from the prior layout.
 */
export interface DashboardHeroRecommendation {
  label: string;
  title: string;
  path: string;
  reason: string;
}

export interface DashboardHeroProps {
  recommendation: DashboardHeroRecommendation;
  dueReviews: ReviewItem[];
  weakObjectives: MasterySnapshot[];
}

export function DashboardHero({ recommendation, dueReviews, weakObjectives }: DashboardHeroProps) {
  const reviews = dueReviews.slice(0, 3);
  const weak = weakObjectives.slice(0, 3);

  return (
    <div className="dashboard-hero">
      <Panel
        as={Link}
        to={recommendation.path}
        tone="study"
        status="exam"
        interactive
        className="dashboard-hero-primary animate-fade"
      >
        <div className="dashboard-hero-eyebrow">
          <StatusBadge tone="accent">{recommendation.label}</StatusBadge>
          <span className="muted-copy">What to study now</span>
        </div>
        <h2 className="dashboard-hero-title type-display">{recommendation.title}</h2>
        <p className="dashboard-hero-reason">{recommendation.reason}</p>
        <span className="panel-link dashboard-hero-cta">
          Start session <ChevronRight size={18} aria-hidden="true" />
        </span>
      </Panel>

      <div className="dashboard-hero-rail">
        <Panel tone="vault" status="vault" density="compact" className="dashboard-signal-card">
          <div className="dashboard-signal-head">
            <CalendarClock size={16} aria-hidden="true" />
            <span className="dashboard-signal-title">Due Reviews</span>
            {reviews.length > 0 && <span className="dashboard-signal-count">{dueReviews.length}</span>}
          </div>
          {reviews.length ? (
            <div className="dashboard-signal-list">
              {reviews.map((item) => (
                <Link key={item.id} to={item.path} className="dashboard-signal-link">
                  <strong>{item.title}</strong>
                  <small>
                    Due {new Date(item.dueAt).toLocaleDateString()} · streak {item.correctStreak}
                  </small>
                </Link>
              ))}
            </div>
          ) : (
            <p className="dashboard-signal-empty">
              No reviews are due. Take a quiz to seed the spaced-repetition queue.
            </p>
          )}
        </Panel>

        <Panel tone="analytics" status="warning" density="compact" className="dashboard-signal-card">
          <div className="dashboard-signal-head">
            <BrainCircuit size={16} aria-hidden="true" />
            <span className="dashboard-signal-title">Weak Objectives</span>
            {weak.length > 0 && <span className="dashboard-signal-count">{weakObjectives.length}</span>}
          </div>
          {weak.length ? (
            <div className="dashboard-signal-list">
              {weak.map((item) => (
                <Link
                  key={item.id}
                  to={`/cfa/level1/${item.topic}/quiz?mode=weak-areas&objective=${item.learningObjective}`}
                  className="dashboard-signal-link"
                >
                  <strong>{item.title}</strong>
                  <small>
                    {item.score}% mastery · {item.attempts} attempts
                  </small>
                </Link>
              ))}
            </div>
          ) : (
            <p className="dashboard-signal-empty">
              No weak objectives yet. Fresh quiz data will populate this panel.
            </p>
          )}
        </Panel>
      </div>
    </div>
  );
}

export default DashboardHero;

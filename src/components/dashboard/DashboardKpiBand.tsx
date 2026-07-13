import type { ComponentType } from 'react';
import { Clock, Flame, Trophy, Zap } from 'lucide-react';
import { MetricTile } from '../ui/Primitives';
import './dashboard-hierarchy.css';

type LucideIcon = ComponentType<{ size?: number; 'aria-hidden'?: boolean }>;

/**
 * UB2 — sticky KPI band. The few headline metrics that should never leave the
 * viewport: study streak, questions answered, recorded study time, and the
 * readiness/mastery snapshot. Presentational only — all values are passed in
 * from the Dashboard's existing useProgressSummary() data.
 */
export interface DashboardKpiBandProps {
  streakDays: number;
  questionsAnswered: number;
  studyTime: string;
  masteryScore: number | null;
}

interface Kpi {
  label: string;
  value: string;
  detail: string;
  icon: LucideIcon;
  tone: 'warning' | 'accent' | 'success' | 'exam';
}

export function DashboardKpiBand({
  streakDays,
  questionsAnswered,
  studyTime,
  masteryScore,
}: DashboardKpiBandProps) {
  const kpis: Kpi[] = [
    {
      label: 'Study Streak',
      value: `${streakDays} day${streakDays === 1 ? '' : 's'}`,
      detail: 'Current momentum',
      icon: Flame,
      tone: 'warning',
    },
    {
      label: 'Questions',
      value: questionsAnswered.toLocaleString(),
      detail: 'Answered locally',
      icon: Zap,
      tone: 'accent',
    },
    {
      label: 'Study Time',
      value: studyTime,
      detail: 'Recorded sessions',
      icon: Clock,
      tone: 'success',
    },
    {
      label: 'Mastery',
      value: masteryScore === null ? '-' : `${masteryScore}%`,
      detail: 'Readiness snapshot',
      icon: Trophy,
      tone: 'exam',
    },
  ];

  return (
    <div className="dashboard-kpi-band" role="group" aria-label="Headline study metrics">
      <div className="dashboard-kpi-grid">
        {kpis.map((kpi) => (
          <MetricTile
            key={kpi.label}
            label={kpi.label}
            value={kpi.value}
            detail={kpi.detail}
            icon={kpi.icon}
            tone={kpi.tone}
          />
        ))}
      </div>
    </div>
  );
}

export default DashboardKpiBand;

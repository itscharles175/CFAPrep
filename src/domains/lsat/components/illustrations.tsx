/** Spot illustrations for empty states (docs/06 §1.5, §2.5). */

export function IllustrationPrepTests({ className = "h-24 w-24" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 96 96" fill="none" aria-hidden>
      <rect x="12" y="16" width="72" height="64" rx="6" stroke="hsl(var(--primary))" strokeWidth="2" fill="hsl(var(--muted))" />
      <path d="M24 32h48M24 44h36M24 56h42" stroke="hsl(var(--muted-foreground))" strokeWidth="2" strokeLinecap="round" />
      <circle cx="72" cy="68" r="14" fill="hsl(var(--primary))" opacity="0.2" />
      <path d="M66 68l4 4 8-8" stroke="hsl(var(--primary))" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function IllustrationSrsCaughtUp({ className = "h-24 w-24" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 96 96" fill="none" aria-hidden>
      <circle cx="48" cy="48" r="32" stroke="hsl(var(--success))" strokeWidth="2" fill="hsl(var(--success) / 0.1)" />
      <path d="M32 48l10 10 22-24" stroke="hsl(var(--success))" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IllustrationImport({ className = "h-24 w-24" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 96 96" fill="none" aria-hidden>
      <path d="M48 20v40M36 48l12-12 12 12" stroke="hsl(var(--primary))" strokeWidth="2.5" strokeLinecap="round" />
      <path d="M20 68h56" stroke="hsl(var(--border))" strokeWidth="2" strokeLinecap="round" />
      <rect x="28" y="72" width="40" height="8" rx="2" fill="hsl(var(--muted))" />
    </svg>
  );
}

export function IllustrationAnalytics({ className = "h-24 w-24" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 96 96" fill="none" aria-hidden>
      <path d="M20 68V44M36 68V32M52 68V52M68 68V24" stroke="hsl(var(--primary))" strokeWidth="3" strokeLinecap="round" />
      <path d="M16 72h64" stroke="hsl(var(--border))" strokeWidth="2" />
    </svg>
  );
}

export function IllustrationReview({ className = "h-24 w-24" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 96 96" fill="none" aria-hidden>
      <rect x="20" y="24" width="56" height="48" rx="4" stroke="hsl(var(--primary))" strokeWidth="2" fill="hsl(var(--muted))" />
      <path d="M32 40h32M32 52h24" stroke="hsl(var(--muted-foreground))" strokeWidth="2" strokeLinecap="round" />
      <circle cx="68" cy="28" r="10" fill="hsl(var(--warning) / 0.25)" stroke="hsl(var(--warning))" strokeWidth="2" />
    </svg>
  );
}

export function IllustrationOffline({ className = "h-20 w-20" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 80 80" fill="none" aria-hidden>
      <circle cx="40" cy="40" r="28" stroke="hsl(var(--warning))" strokeWidth="2" fill="hsl(var(--warning) / 0.1)" />
      <path d="M28 40h24M40 28v24" stroke="hsl(var(--warning))" strokeWidth="2" strokeLinecap="round" transform="rotate(45 40 40)" />
    </svg>
  );
}

/** R10 (docs/20 C1) — error / disconnected spot for ErrorState (the one state
 *  surface still on a bare lucide triangle). A calm "instrument offline" still-life. */
export function IllustrationError({ className = "h-20 w-20" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 80 80" fill="none" aria-hidden>
      <circle cx="40" cy="40" r="28" stroke="hsl(var(--destructive))" strokeWidth="2" fill="hsl(var(--destructive) / 0.08)" />
      <path d="M40 27v19" stroke="hsl(var(--destructive))" strokeWidth="3" strokeLinecap="round" />
      <circle cx="40" cy="55" r="2.6" fill="hsl(var(--destructive))" />
    </svg>
  );
}

/** R10 (docs/20 C1) — "awaiting data" spot for analytics/zero-data empty states
 *  that still fall back to the generic Inbox: a faint plot axis with no series yet. */
export function IllustrationAwaitingData({ className = "h-24 w-24" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 96 96" fill="none" aria-hidden>
      <path d="M22 22v52h52" stroke="hsl(var(--border))" strokeWidth="2" strokeLinecap="round" />
      <path d="M30 60q14 -6 22 -2t18 -14" stroke="hsl(var(--muted-foreground))" strokeWidth="2" strokeLinecap="round" strokeDasharray="3 5" opacity="0.7" />
      <circle cx="48" cy="48" r="11" fill="hsl(var(--primary) / 0.12)" stroke="hsl(var(--primary))" strokeWidth="1.5" strokeDasharray="2 3" />
    </svg>
  );
}

/** R9 (docs/19) — collections / smart-set spot: a stack of set cards with the
 *  verdict "play" node, matching the PrepTests/Review family. */
export function IllustrationPlaylists({ className = "h-24 w-24" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 96 96" fill="none" aria-hidden>
      <rect x="22" y="20" width="52" height="14" rx="4" fill="hsl(var(--muted))" stroke="hsl(var(--border))" strokeWidth="2" />
      <rect x="18" y="38" width="60" height="16" rx="4" fill="hsl(var(--muted))" stroke="hsl(var(--border))" strokeWidth="2" />
      <rect x="14" y="58" width="68" height="20" rx="5" fill="hsl(var(--primary) / 0.12)" stroke="hsl(var(--primary))" strokeWidth="2" />
      <path d="M42 63v10l9-5z" fill="hsl(var(--primary))" />
    </svg>
  );
}

/** R9 (docs/19) — empty session-history / activity timeline spot: a rail with
 *  nodes climbing toward a goal, echoing the SessionHistory rail. */
export function IllustrationTimeline({ className = "h-24 w-24" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 96 96" fill="none" aria-hidden>
      <path d="M24 74V30" stroke="hsl(var(--border))" strokeWidth="2" strokeLinecap="round" />
      <path d="M24 66l16-10 14 8 18-26" stroke="hsl(var(--primary))" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="24" cy="66" r="4" fill="hsl(var(--primary))" />
      <circle cx="40" cy="56" r="4" fill="hsl(var(--primary))" />
      <circle cx="54" cy="64" r="4" fill="hsl(var(--primary))" />
      <circle cx="72" cy="38" r="5" fill="hsl(var(--primary) / 0.2)" stroke="hsl(var(--primary))" strokeWidth="2" />
    </svg>
  );
}

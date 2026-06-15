// ---------------------------------------------------------------------------
// UB5 — shared "system status" barrel. One import path for the host's
// EmptyState / ErrorState / Skeleton states so CFA, Quant and Excel pages stop
// hand-rolling loading/error/empty markup (and stop reaching into the LSAT
// domain, whose states.tsx depends on @lsat/* aliases the host shell lacks).
//
//   import { EmptyState, ErrorState, Skeleton, SkeletonList } from '@/components/feedback';
//
// The existing default-export path `components/EmptyState` keeps working, so
// nothing already importing it has to change.
// ---------------------------------------------------------------------------

export { default as EmptyState } from '../EmptyState';
export type { EmptyStateProps } from '../EmptyState';

export { ErrorState } from './ErrorState';
export type { ErrorStateProps } from './ErrorState';

export { Skeleton, SkeletonList } from './Skeleton';
export type { SkeletonProps, SkeletonListProps } from './Skeleton';

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

// K4-4 — route-shaped skeletons (host twins of the LSAT
// SkeletonCard/SkeletonChart/SkeletonListPage/SkeletonDetailPage/DashboardSkeleton)
// so a lazy host route can reserve its real layout instead of flashing the bare
// RouteFallback spinner.
export {
  SkeletonCard,
  SkeletonChart,
  SkeletonListPage,
  SkeletonDetailPage,
  SkeletonDashboard,
} from './skeletons';
export type {
  SkeletonCardProps,
  SkeletonChartProps,
  SkeletonListPageProps,
  SkeletonDetailPageProps,
  SkeletonDashboardProps,
} from './skeletons';

// K4-4 — shared data surfaces. Re-exported from the host-styled primitive barrel
// (src/components/ui) so a reskin reaches the full feedback + table/list-row
// vocabulary through one import path.
export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
} from '../ui/table';

export { ListRow } from '../ui/list-row';
export type { ListRowProps } from '../ui/list-row';

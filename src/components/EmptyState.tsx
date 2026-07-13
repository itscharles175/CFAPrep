import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { EmptyPanel } from './ui/Primitives';

export interface EmptyStateProps {
  title?: ReactNode;
  description?: ReactNode;
  actionLabel?: ReactNode;
  actionTo?: string;
}

export default function EmptyState({ title, description, actionLabel, actionTo }: EmptyStateProps) {
  return (
    <EmptyPanel
      title={title}
      description={description}
      action={
        actionLabel && actionTo ? (
          <Link to={actionTo} className="btn btn-primary">
            {actionLabel}
          </Link>
        ) : null
      }
    />
  );
}

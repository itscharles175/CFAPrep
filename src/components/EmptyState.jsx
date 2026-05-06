import { Link } from 'react-router-dom';
import { EmptyPanel } from './ui/Primitives';

export default function EmptyState({ title, description, actionLabel, actionTo }) {
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

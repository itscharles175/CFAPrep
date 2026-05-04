import { Link } from 'react-router-dom';

export default function EmptyState({ title, description, actionLabel, actionTo }) {
  return (
    <div className="glass-card no-hover empty-state">
      <h2>{title}</h2>
      {description && <p>{description}</p>}
      {actionLabel && actionTo && (
        <Link to={actionTo} className="btn btn-primary">
          {actionLabel}
        </Link>
      )}
    </div>
  );
}

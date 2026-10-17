import { Link } from 'react-flight-router/client';
import { EmptyState } from '../components/ui';

export default function NotFound() {
  return (
    <main className="p-4">
      <EmptyState
        title="Page not found"
        description="Check the address or return to your workspace."
        action={
          <Link to="/dashboard" className="btn btn-sm">
            Open workspace
          </Link>
        }
      />
    </main>
  );
}

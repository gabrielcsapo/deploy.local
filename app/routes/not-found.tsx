import { Empty } from '../components/ui/v2/Empty';
import './v2-public/about/public.css';
export default function NotFound() {
  return (
    <main className="dl-sheet v2-public public-recovery">
      <Empty
        title="Page not found"
        icon="search"
        actions={
          <>
            <a href="/dashboard" className="dl-btn primary">
              Home
            </a>
            <a href="/dashboard/live" className="dl-btn secondary">
              Live
            </a>
          </>
        }
      >
        Check the address, or head back to Home and your running apps.
      </Empty>
    </main>
  );
}

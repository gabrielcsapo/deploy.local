import { Link } from 'react-flight-router/client';

export default function NotFound() {
  return (
    <div className="max-w-7xl mx-auto px-6 py-16 text-center">
      <h1 className="text-4xl font-bold mb-4">404</h1>
      <p className="text-text-secondary mb-8">The page you're looking for doesn't exist.</p>
      <Link to="/" className="btn btn-primary">
        Go home
      </Link>
    </div>
  );
}

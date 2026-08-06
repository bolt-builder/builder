import { Link } from 'react-router';
import type { MetaFunction } from 'react-router';

export const meta: MetaFunction = () => {
  return [{ title: '404 — Bolt' }, { name: 'description', content: 'Page not found' }];
};

export default function NotFound() {
  return (
    <main className="flex flex-col items-center justify-center h-full w-full bg-bolt-elements-background-depth-1 text-bolt-elements-textPrimary">
      <h1 className="text-6xl font-bold mb-4">404</h1>
      <p className="text-lg text-bolt-elements-textSecondary mb-8">Page not found</p>
      <Link to="/" className="px-6 py-3 rounded-lg bg-accent-500 text-white hover:bg-accent-600 transition-colors">
        Go Home
      </Link>
    </main>
  );
}

import * as Sentry from '@sentry/react';
import { useStore } from '@nanostores/react';
import { useEffect } from 'react';
import { profileStore } from '~/lib/stores/profile';

const SESSION_ID_KEY = 'bolt_session_id';

/**
 * Generate a cryptographically random session ID.
 * Falls back to Math.random if crypto API is unavailable.
 */
function generateSessionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  // Fallback for older browsers
  const bytes = new Uint8Array(16);

  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }

  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Get or create a stable session ID stored in localStorage.
 * The session ID persists across page reloads within the same browser
 * but is regenerated if localStorage is cleared.
 */
function getOrCreateSessionId(): string {
  try {
    const existing = localStorage.getItem(SESSION_ID_KEY);

    if (existing) {
      return existing;
    }

    const newId = generateSessionId();
    localStorage.setItem(SESSION_ID_KEY, newId);

    return newId;
  } catch {
    // localStorage unavailable (private browsing, storage full, etc.)
    return generateSessionId();
  }
}

/**
 * Hook to sync user/session context with Sentry for error correlation.
 *
 * bolt is a self-hosted local app without traditional authentication.
 * This hook provides a stable anonymous session ID so errors from the same
 * browser session can be correlated in Sentry. If the user has set a profile
 * username (via settings), it is included as additional context.
 *
 * Must be called from a client-side component (e.g., root Layout).
 */
export function useSentryUser() {
  const profile = useStore(profileStore);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return undefined;
    }

    const sessionId = getOrCreateSessionId();

    const sentryUser: Sentry.User = {
      id: sessionId,
    };

    if (profile.username) {
      sentryUser.username = profile.username;
    }

    Sentry.setUser(sentryUser);

    return () => {
      Sentry.setUser(null);
    };
  }, [profile.username]);
}

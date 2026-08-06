/*
 * Enforce a safe bind policy before the server starts. The app exposes a
 * runtime API that executes arbitrary shell commands and reads/writes files, so
 * it must never listen on a non-loopback interface without authentication.
 * Default to loopback; require BOLT_AUTH_TOKEN to bind anything else. This runs
 * for every entrypoint that loads this file via `node --import`.
 */
{
  const host = process.env.HOST;
  const isLoopback = !host || host === '127.0.0.1' || host === '::1' || host === 'localhost';

  if (!host) {
    process.env.HOST = '127.0.0.1';
  } else if (!isLoopback && !process.env.BOLT_AUTH_TOKEN) {
    console.error(
      `[Bolt] Refusing to bind ${host} without authentication: the runtime API grants shell execution ` +
        `and file access. Set BOLT_AUTH_TOKEN to expose the server beyond localhost, or unset HOST to bind 127.0.0.1.`,
    );
    process.exit(1);
  }
}

import * as Sentry from '@sentry/node';

const dsn = process.env.SENTRY_DSN;
const environment = process.env.SENTRY_ENVIRONMENT || 'development';
const release = process.env.SENTRY_RELEASE || 'dev';
const isProduction = process.env.NODE_ENV === 'production';

if (dsn) {
  Sentry.init({
    dsn,
    environment,
    release,
    tracesSampleRate: isProduction ? 0.1 : 1.0,
  });
} else {
  console.warn('[Sentry] SENTRY_DSN not set — server-side error monitoring disabled.');
}

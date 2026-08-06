import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './app/lib/.server/db/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: {
    url: process.env.BOLT_DB_PATH
      ? process.env.BOLT_DB_PATH.startsWith('file:')
        ? process.env.BOLT_DB_PATH
        : `file:${process.env.BOLT_DB_PATH}`
      : 'file:./data/bolt.db',
  },
});

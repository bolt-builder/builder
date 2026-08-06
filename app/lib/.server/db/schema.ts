import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

/**
 * SQLite schema for Bolt — mirrors the IndexedDB v3 structure
 * so that data can be migrated from client-side IndexedDB to
 * server-side SQLite seamlessly.
 *
 * Tables: chats, messages, snapshots, versions
 */

/*
 * ---------------------------------------------------------------------------
 * chats
 * ---------------------------------------------------------------------------
 */
export const chats = sqliteTable(
  'chats',
  {
    id: text('id').primaryKey(),
    urlId: text('url_id').unique(),
    description: text('description'),
    timestamp: text('timestamp'),

    /** JSON-serialised IChatMetadata (gitUrl, gitBranch, netlifySiteId) */
    metadata: text('metadata', { mode: 'json' }),
    userId: text('user_id'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [
    index('idx_chats_url_id').on(table.urlId),
    index('idx_chats_user_id').on(table.userId),
    index('idx_chats_created_at').on(table.createdAt),
  ],
);

/*
 * ---------------------------------------------------------------------------
 * messages
 * ---------------------------------------------------------------------------
 */
export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    chatId: text('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['user', 'assistant', 'system'] }).notNull(),
    content: text('content').notNull(),

    /** Full AI SDK message payload stored as JSON for lossless round-tripping */
    fullMessage: text('full_message', { mode: 'json' }),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [
    index('idx_messages_chat_id').on(table.chatId),
    index('idx_messages_sort_order').on(table.chatId, table.sortOrder),
  ],
);

/*
 * ---------------------------------------------------------------------------
 * snapshots
 * ---------------------------------------------------------------------------
 */
export const snapshots = sqliteTable('snapshots', {
  chatId: text('chat_id')
    .primaryKey()
    .references(() => chats.id, { onDelete: 'cascade' }),

  /** JSON-serialised Snapshot ({ chatIndex, files, summary }) */
  snapshot: text('snapshot', { mode: 'json' }).notNull(),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`),
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`(datetime('now'))`),
});

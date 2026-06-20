// Conversation persistence (agent-conversations plan, Phase 01). Stores one JSON
// file per conversation under the app's `openSettings()` mount — a per-(user,app),
// chrooted, durable directory (capability `settings:app`, baseline). This is the
// canonical, forkable, in-sandbox store: no host Firestore machinery, no new grant.
//
// Mirrors `fsTools.ts`: the core is fs-injectable (`createConversationStore`) so
// tests are hermetic; production resolves the settings mount + real `fs.promises`
// (`openConversationStore`).

import fs from 'fs';
import { openSettings } from '@immediately-run/sdk';
import type { ChatMessage } from './agentLoop';
import type { Conversation, ConversationMeta } from './conversationModel';

const DIR = 'conversations'; // subdir under the settings mount
const LIST_CAP = 500; // defensive cap on conversations surfaced
const TITLE_MAX = 60;

const genId = (): string => crypto.randomUUID();

/** The `fs.promises` subset the store uses — narrowed so tests inject a fake. */
export interface StoreFs {
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
  readdir(path: string, options: { withFileTypes: true }): Promise<{ name: string; isDirectory(): boolean }[]>;
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  unlink(path: string): Promise<void>;
}

export interface ConversationStore {
  /** Conversation metadata, newest-first. A corrupt file is skipped, not thrown. */
  list(): Promise<ConversationMeta[]>;
  /** Create, persist, and return a fresh empty conversation. */
  create(title?: string): Promise<Conversation>;
  /** Load a conversation, or `null` if missing/corrupt. */
  load(id: string): Promise<Conversation | null>;
  /** Persist a conversation, bumping `updatedAt`; returns the persisted record. */
  save(conv: Conversation): Promise<Conversation>;
  /** Set a conversation's title (no-op if missing). */
  rename(id: string, title: string): Promise<void>;
  /** Delete a conversation (no-op if missing). */
  remove(id: string): Promise<void>;
}

const code = (e: unknown): string | undefined => (e as { code?: string })?.code;

/** First user-message text, trimmed — the auto-title. Empty → "New conversation". */
export function deriveTitle(messages: ChatMessage[]): string {
  const firstUser = messages.find((m) => m.role === 'user');
  const text = (firstUser?.content ?? [])
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return 'New conversation';
  return text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX - 1)}…` : text;
}

/**
 * Build a store over an explicit fs + root. Used directly in tests; in production
 * `openConversationStore` supplies the settings-mount root + real `fs.promises`.
 */
export function createConversationStore(opts: { root: string; fs: StoreFs }): ConversationStore {
  const p = opts.fs;
  const dir = `${opts.root.replace(/\/+$/, '')}/${DIR}`;
  const file = (id: string): string => `${dir}/${id}.json`;

  const ensureDir = () => p.mkdir(dir, { recursive: true });

  const load = async (id: string): Promise<Conversation | null> => {
    try {
      const raw = await p.readFile(file(id), 'utf8');
      const parsed = JSON.parse(raw) as Conversation;
      if (parsed?.schema !== 1 || typeof parsed.id !== 'string') return null;
      return parsed;
    } catch {
      return null; // ENOENT or malformed JSON — caller decides
    }
  };

  // Write a record verbatim (no timestamp change). `save` bumps; `create` writes
  // a fresh record whose createdAt === updatedAt.
  const write = async (conv: Conversation): Promise<void> => {
    await ensureDir();
    await p.writeFile(file(conv.id), JSON.stringify(conv));
  };

  const save = async (conv: Conversation): Promise<Conversation> => {
    const next = { ...conv, updatedAt: Date.now() };
    await write(next);
    return next;
  };

  return {
    async list() {
      await ensureDir();
      let entries: { name: string; isDirectory(): boolean }[];
      try {
        entries = await p.readdir(dir, { withFileTypes: true });
      } catch {
        return [];
      }
      const ids = entries
        .filter((e) => !e.isDirectory() && e.name.endsWith('.json'))
        .map((e) => e.name.slice(0, -'.json'.length));
      const metas: ConversationMeta[] = [];
      for (const id of ids) {
        const conv = await load(id);
        if (conv) metas.push({ id: conv.id, title: conv.title, createdAt: conv.createdAt, updatedAt: conv.updatedAt });
      }
      return metas.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, LIST_CAP);
    },

    async create(title) {
      const now = Date.now();
      const conv: Conversation = {
        id: genId(),
        title: title ?? 'New conversation',
        createdAt: now,
        updatedAt: now,
        schema: 1,
        messages: [],
      };
      await write(conv); // createdAt === updatedAt for a fresh record
      return conv;
    },

    load,
    save,

    async rename(id, title) {
      const conv = await load(id);
      if (conv) await save({ ...conv, title });
    },

    async remove(id) {
      try {
        await p.unlink(file(id));
      } catch (e) {
        if (code(e) !== 'ENOENT') throw e;
      }
    },
  };
}

/**
 * Production factory: resolve the app's settings mount and build the store on it.
 * Throws if `openSettings()` is unavailable (signed out / no host) — callers
 * degrade to ephemeral behavior rather than crash.
 */
export async function openConversationStore(): Promise<ConversationStore> {
  const mount = await openSettings();
  return createConversationStore({ root: mount.path, fs: fs.promises as unknown as StoreFs });
}

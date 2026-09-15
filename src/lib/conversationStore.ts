// Conversation persistence (agent-conversations plan, Phase 01; R3-559 adds the
// checkpoint journal). The RECORD is one JSON file per conversation under the
// app's `openSettings()` mount — a per-(user,app), chrooted, durable, SYNCED
// directory (capability `settings:app`, baseline). The JOURNAL is the two-tier
// checkpoint's append tier (AGENT_RUN_DURABILITY_SPEC §4): one immutable JSON
// entry per loop boundary under the device-local `openLocalStore()` mount
// (R3-558), folded into the record at run end / compaction / cadence (R-ARD-9).
//
// Mirrors `fsTools.ts`: the core is fs-injectable (`createConversationStore`) so
// tests are hermetic; production resolves both mounts + real `fs.promises`
// (`openConversationStore`).

import fs from 'fs';
import { openSettings, openLocalStore } from '@immediately-run/sdk';
import type {
  ChatMessage,
  ContentBlock,
  ImageBlock,
  LoopBoundary,
  RunState,
  ToolResultBlock,
  ToolUseBlock,
} from './agentLoop';
import type { Conversation, ConversationMeta } from './conversationModel';

const DIR = 'conversations'; // subdir under each mount root
const LIST_CAP = 500; // defensive cap on conversations surfaced
const TITLE_MAX = 60;
/** One entry file per boundary, under `<journalRoot>/conversations/<id>/journal/`
 *  (R-ARD-5a: a SUBDIRECTORY of the conversation — sibling `.json` files would
 *  make `list()` O(checkpoints) reads). */
const JOURNAL_DIR = 'journal';
/** Bounded write (R-ARD-10a): a checkpoint append that has not settled within
 *  this budget is a failure — the loop never executes past an unwritten B2, and
 *  blocking forever would stall a run silently. */
const APPEND_TIMEOUT_MS = 5_000;
/** R-ARD-5b — the entry-size rule. The append tier (IndexedDB) has no inline-size
 *  cliff, but the FOLD copies journal content into the Firestore-backed record,
 *  where a file over `OFFLOAD_THRESHOLD` (256 KiB in the host's FirestoreFS)
 *  becomes a Storage upload. The checkpointed copy of an oversized string is
 *  truncated head/tail with an explicit marker; the model's copy is untouched.
 *  Mirrors the host constant — the app cannot import it. */
const ENTRY_STRING_LIMIT = 256 * 1024;
const HEAD_TAIL = Math.floor(ENTRY_STRING_LIMIT / 2);

const genId = (): string => crypto.randomUUID();

/** The `fs.promises` subset the store uses — narrowed so tests inject a fake. */
export interface StoreFs {
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
  readdir(path: string, options: { withFileTypes: true }): Promise<{ name: string; isDirectory(): boolean }[]>;
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  unlink(path: string): Promise<void>;
}

/** The current journal-entry schema version (per-entry — R-ARD-5a: the store
 *  silently skips a RECORD whose schema it does not recognise, so an unversioned
 *  ENTRY would vanish without a sound; entries are refused loudly instead). */
export type JournalSchema = 1;

/**
 * One journal entry (R-ARD-5a): `{ seq, kind, schema, …payload }`, one file per
 * entry, named by its monotonic `seq`. Every field is JSON-round-trippable
 * (R-ARD-5d) — `replay` refuses an entry whose `schema` it does not know rather
 * than skipping it. `taint` is reserved (R-ARD-22) and written by nobody.
 */
export interface JournalEntry {
  seq: number;
  kind: LoopBoundary['kind'];
  schema: JournalSchema;
  t: number;
  effectId?: string;
  /** B0 / B6: the full message array (kickoff identity / post-compaction fold). */
  messages?: ChatMessage[];
  /** B1: the assistant turn's finalized blocks. */
  blocks?: ContentBlock[];
  /** B2: the tool_use block about to be executed (marked started). */
  call?: ToolUseBlock;
  /** B3: one completed call's tool_result. */
  result?: ToolResultBlock;
  /** B3: the images this call produced (they ride with the results message). */
  images?: ImageBlock[];
  /** B4: the loop's carried accounting. */
  runState?: RunState;
  /** B5: the injected user turn (steer, nudge, truncation retry). */
  message?: ChatMessage;
  /** Reserved (R-ARD-22, §8): present in the shape from day one, written by nobody. */
  taint?: never;
}

/** A B2 intent with no resolving B3 — a call that was started and torn down before
 *  completion. `replay` reports them so a resume can mark them *started, outcome
 *  unknown* (R3-560's repair) rather than guessing. */
export interface PendingEffect {
  effectId: string;
  toolUseId: string;
  name: string;
}

/** What `replay` reconstructs from record-then-entries-above-`foldedSeq`. */
export interface ReplayResult {
  /** The assembled transcript (a partially-filled results message included). */
  messages: ChatMessage[];
  /** The latest B4 run-state at/below the replayed seq, if any entry carried one. */
  runState: RunState | null;
  /** The record's fold watermark at replay time. */
  foldedSeq: number;
  /** The highest seq applied (journal head), ≥ `foldedSeq`. */
  lastSeq: number;
  /** B2 intents with no completing B3 (dangling calls). */
  pendingEffects: PendingEffect[];
}

export interface ConversationStore {
  /** Conversation metadata, newest-first. A corrupt file is skipped, not thrown. */
  list(): Promise<ConversationMeta[]>;
  /** Create, persist, and return a fresh empty conversation, stamped with the
   *  workspace repo when the caller knows it (R3-475). */
  create(title?: string, repo?: string): Promise<Conversation>;
  /** Load a conversation, or `null` if missing/corrupt. */
  load(id: string): Promise<Conversation | null>;
  /** Persist a conversation, bumping `updatedAt`; returns the persisted record. */
  save(conv: Conversation): Promise<Conversation>;
  /** Set a conversation's title (no-op if missing). */
  rename(id: string, title: string): Promise<void>;
  /** Delete a conversation and its journal (no-op if missing). */
  remove(id: string): Promise<void>;
  // ---- R3-559: the two-tier checkpoint journal (AGENT_RUN_DURABILITY_SPEC §4) ----
  /** Is the device-local append tier wired? A journalless store still runs —
   *  R-ARD-10: an un-checkpointable run is allowed to start, and SAYS SO. */
  hasJournal(): boolean;
  /** Append one checkpoint boundary as its own immutable entry on the
   *  device-local tier, minting the next monotonic `seq`. Bounded: a write that
   *  has not settled within `APPEND_TIMEOUT_MS` rejects (a timeout is a failure,
   *  R-ARD-10a). Rejects `journal-unavailable` on a journalless store. */
  append(convId: string, b: LoopBoundary): Promise<number>;
  /** Reconstruct the transcript: the folded record, then every entry above its
   *  watermark — idempotent, and a duplicated/re-delivered entry is harmless
   *  (R-ARD-5). Refuses an entry it does not understand, loudly (R-ARD-5d). */
  replay(convId: string): Promise<ReplayResult>;
  /** Fold the journal into the synced record (R-ARD-6/9): stamp the fold
   *  watermark + carried run-state, then reclaim the superseded entries
   *  (R-ARD-5c). `patch.messages`, when given, is the run's authoritative
   *  transcript (byte-true to what the model saw). Returns the persisted record. */
  fold(convId: string, patch?: { messages?: ChatMessage[]; title?: string; repo?: string }): Promise<Conversation>;
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

/** Truncate an oversized checkpointed string head/tail with an explicit marker
 *  (R-ARD-5b). Only the journal copy is truncated — the model's copy is untouched. */
function truncateForEntry(s: string): string {
  if (s.length <= ENTRY_STRING_LIMIT) return s;
  return (
    s.slice(0, HEAD_TAIL) +
    `\n…[checkpoint truncated: ${ENTRY_STRING_LIMIT} of ${s.length} bytes kept — head/tail only]…\n` +
    s.slice(-HEAD_TAIL)
  );
}

/** Apply the entry-size rule to a boundary payload (strings only; structure is
 *  never rewritten — replay must be able to reassemble the exact message shape). */
function boundEntryPayload(b: LoopBoundary): LoopBoundary {
  if (b.kind === 'B3') {
    return {
      ...b,
      result: { ...b.result, content: truncateForEntry(b.result.content) },
      ...(b.images ? { images: b.images.map((im) => ({ ...im, data: truncateForEntry(im.data) })) } : {}),
    };
  }
  return b;
}

const errWithCode = (code: string, msg: string): Error => Object.assign(new Error(msg), { code });

/**
 * Build a store over an explicit fs + roots. The journal tier is a constructor
 * argument, never a branch inside a method (R3-559): `recordRoot` is the synced
 * settings mount (the record + the fold), `journalRoot` the device-local mount
 * (appends). One injected fs serves both in tests; production passes the real
 * `fs.promises`, which reaches both mounts by path.
 */
export function createConversationStore(opts: {
  recordRoot: string;
  fs: StoreFs;
  /** Device-local append tier. Absent ⇒ journalless store: runs are allowed and
   *  say so (R-ARD-10); `append` rejects `journal-unavailable`. */
  journalRoot?: string;
}): ConversationStore {
  const p = opts.fs;
  const recordDir = `${opts.recordRoot.replace(/\/+$/, '')}/${DIR}`;
  const journalRoot = opts.journalRoot ? opts.journalRoot.replace(/\/+$/, '') : undefined;
  const convJournalDir = (id: string): string => `${journalRoot}/${DIR}/${id}/${JOURNAL_DIR}`;
  const file = (id: string): string => `${recordDir}/${id}.json`;
  // seq allocation (R-ARD-5c: by the lease holder — this writer, until R3-561's
  // advisory lease exists). Lazily seeded per conversation from the journal head
  // AND the record's fold watermark, so a fold that reclaimed entries still mints
  // seqs above everything the record already contains.
  const lastSeq = new Map<string, number>();

  const ensureDir = () => p.mkdir(recordDir, { recursive: true });

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

  /** Every journal entry for a conversation, ascending by seq. `[]` when the
   *  journal is absent (journalless store, or nothing appended yet). */
  const readEntries = async (id: string): Promise<JournalEntry[]> => {
    if (!journalRoot) return [];
    let names: { name: string; isDirectory(): boolean }[];
    try {
      names = await p.readdir(convJournalDir(id), { withFileTypes: true });
    } catch {
      return [];
    }
    const seqs = names
      .filter((e) => !e.isDirectory() && /^\d+\.json$/.test(e.name))
      .map((e) => Number(e.name.slice(0, -'.json'.length)))
      .sort((a, b) => a - b);
    const entries: JournalEntry[] = [];
    for (const seq of seqs) {
      const raw = await p.readFile(`${convJournalDir(id)}/${seq}.json`, 'utf8');
      let parsed: JournalEntry;
      try {
        parsed = JSON.parse(raw) as JournalEntry;
      } catch (e) {
        throw errWithCode('journal-corrupt', `journal entry ${seq} is not JSON: ${String((e as Error)?.message ?? e)}`);
      }
      if (parsed?.schema !== 1) {
        // R-ARD-5d: refused LOUDLY — the record loader silently skips unknown
        // schemas, and an entry that vanished the same way would corrupt replay
        // without a sound.
        throw errWithCode('journal-schema', `journal entry ${seq} has unknown schema ${String(parsed?.schema)}`);
      }
      entries.push(parsed);
    }
    return entries;
  };

  const nextSeq = async (id: string): Promise<number> => {
    const known = lastSeq.get(id);
    if (known !== undefined) return known + 1;
    let head = 0;
    if (journalRoot) {
      try {
        const names = await p.readdir(convJournalDir(id), { withFileTypes: true });
        for (const e of names) {
          if (!e.isDirectory() && /^\d+\.json$/.test(e.name)) {
            head = Math.max(head, Number(e.name.slice(0, -'.json'.length)));
          }
        }
      } catch {
        // no journal dir yet — head stays 0
      }
    }
    const record = await load(id);
    head = Math.max(head, record?.foldedSeq ?? 0);
    return head + 1;
  };

  const append = async (convId: string, b: LoopBoundary): Promise<number> => {
    if (!journalRoot) throw errWithCode('journal-unavailable', 'no device-local journal mount');
    const seq = await nextSeq(convId);
    lastSeq.set(convId, seq);
    const payload = boundEntryPayload(b) as Partial<JournalEntry>;
    const entry: JournalEntry = { ...payload, seq, kind: b.kind, schema: 1, t: b.t };
    const path = `${convJournalDir(convId)}/${seq}.json`;
    await p.mkdir(convJournalDir(convId), { recursive: true });
    // Bounded write (R-ARD-10a): race the write against a timer; a timeout is a
    // failure, never a silent hang the run executes past.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        p.writeFile(path, JSON.stringify(entry)),
        new Promise<never>((_, rej) => {
          timer = setTimeout(() => rej(errWithCode('journal-timeout', 'journal append timed out')), APPEND_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    return seq;
  };

  /** Assemble the partially-filled results message (R-ARD-7a): B3s of one batch
   *  share one `user` message shaped `[...results, ...images]` — byte-identical to
   *  the in-memory message the loop pushed — and any non-B3 boundary closes it. */
  const replayFrom = (record: Conversation | null, entries: JournalEntry[]): ReplayResult => {
    const foldedSeq = record?.foldedSeq ?? 0;
    let messages: ChatMessage[] = [...(record?.messages ?? [])];
    let runState: RunState | null = record?.runState ?? null;
    let lastSeqApplied = foldedSeq;
    const pending = new Map<string, PendingEffect>();
    // The results message in assembly: results and images are collected separately
    // so the assembled message keeps the loop's `[...results, ...images]` order.
    let results: ToolResultBlock[] | null = null;
    let images: ImageBlock[] = [];
    const closeBatch = (): void => {
      if (results === null) return;
      messages.push({ role: 'user', content: [...results, ...images] });
      results = null;
      images = [];
    };
    for (const e of entries) {
      if (e.seq <= foldedSeq) continue; // already folded into the record — harmless
      switch (e.kind) {
        case 'B0':
          closeBatch();
          // Kickoff REPLACES: the entry carries the run's full initial array
          // (history + prompt), and the record may hold an older or empty prefix.
          messages = [...(e.messages ?? [])];
          break;
        case 'B1':
          closeBatch();
          messages.push({ role: 'assistant', content: [...(e.blocks ?? [])] });
          break;
        case 'B2':
          // B2 does NOT close the batch in assembly: the loop interleaves
          // B2,B3,B2,B3 within one batch, and they all belong to the same
          // results message (R-ARD-7a).
          if (e.effectId !== undefined && e.call) {
            pending.set(e.effectId, { effectId: e.effectId, toolUseId: e.call.id, name: e.call.name });
          }
          break;
        case 'B3': {
          if (results === null) {
            results = [];
            images = [];
          }
          if (e.result) results.push(e.result);
          if (e.images?.length) images.push(...e.images);
          if (e.effectId !== undefined) pending.delete(e.effectId);
          break;
        }
        case 'B4':
          runState = e.runState ?? runState;
          break;
        case 'B5':
          closeBatch();
          if (e.message) messages.push(e.message);
          break;
        case 'B6':
          closeBatch();
          messages = [...(e.messages ?? [])];
          break;
      }
      lastSeqApplied = Math.max(lastSeqApplied, e.seq);
    }
    closeBatch();
    return { messages, runState, foldedSeq, lastSeq: lastSeqApplied, pendingEffects: [...pending.values()] };
  };

  const replay = async (id: string): Promise<ReplayResult> =>
    replayFrom(await load(id), await readEntries(id));

  /** Best-effort recursive delete over the StoreFs surface (no rmdir in the
   *  port): unlink every file under `dir`, descending into subdirectories. */
  const rmTree = async (dir: string): Promise<void> => {
    let entries: { name: string; isDirectory(): boolean }[];
    try {
      entries = await p.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) await rmTree(`${dir}/${e.name}`);
      else {
        try {
          await p.unlink(`${dir}/${e.name}`);
        } catch {
          /* best-effort reclaim */
        }
      }
    }
  };

  const reclaimThrough = async (id: string, seq: number): Promise<void> => {
    if (!journalRoot) return;
    try {
      const names = await p.readdir(convJournalDir(id), { withFileTypes: true });
      for (const e of names) {
        const m = /^(\d+)\.json$/.exec(e.name);
        if (m && Number(m[1]) <= seq) {
          try {
            await p.unlink(`${convJournalDir(id)}/${e.name}`);
          } catch {
            /* best-effort reclaim */
          }
        }
      }
    } catch {
      /* no journal dir — nothing to reclaim */
    }
  };

  const fold = async (
    id: string,
    patch?: { messages?: ChatMessage[]; title?: string; repo?: string },
  ): Promise<Conversation> => {
    const conv = await load(id);
    if (!conv) throw errWithCode('ENOENT', `conversation ${id} not found`);
    let next: Conversation;
    if (!journalRoot) {
      // Journalless fold degrades to a plain save (R-ARD-10: allowed, surfaced).
      next = { ...conv, ...(patch?.messages !== undefined ? { messages: patch.messages } : {}), ...(patch?.title !== undefined ? { title: patch.title } : {}), ...(patch?.repo !== undefined ? { repo: patch.repo } : {}) };
      return save(next);
    }
    const replayed = await replay(id);
    next = {
      ...conv,
      messages: patch?.messages ?? replayed.messages,
      runState: replayed.runState ?? conv.runState,
      foldedSeq: replayed.lastSeq,
      ...(patch?.title !== undefined ? { title: patch.title } : {}),
      ...(patch?.repo !== undefined ? { repo: patch.repo } : {}),
    };
    const saved = await save(next);
    lastSeq.set(id, replayed.lastSeq);
    await reclaimThrough(id, replayed.lastSeq); // R-ARD-5c: the fold supersedes
    return saved;
  };

  return {
    async list() {
      await ensureDir();
      let entries: { name: string; isDirectory(): boolean }[];
      try {
        entries = await p.readdir(recordDir, { withFileTypes: true });
      } catch {
        return [];
      }
      const ids = entries
        .filter((e) => !e.isDirectory() && e.name.endsWith('.json'))
        .map((e) => e.name.slice(0, -'.json'.length));
      const metas: ConversationMeta[] = [];
      for (const id of ids) {
        const conv = await load(id);
        if (conv)
          metas.push({ id: conv.id, title: conv.title, createdAt: conv.createdAt, updatedAt: conv.updatedAt, repo: conv.repo });
      }
      return metas.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, LIST_CAP);
    },

    async create(title, repo) {
      const now = Date.now();
      const conv: Conversation = {
        id: genId(),
        title: title ?? 'New conversation',
        createdAt: now,
        updatedAt: now,
        schema: 1,
        messages: [],
        ...(repo ? { repo } : {}),
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
      // R-ARD-5c: deleting the conversation reclaims its journal — abandoned
      // journals must not accumulate in a quota-bearing store.
      if (journalRoot) await rmTree(`${journalRoot}/${DIR}/${id}`);
    },

    hasJournal: () => journalRoot !== undefined,
    append,
    replay,
    fold,
  };
}

/**
 * Production factory: resolve the app's settings mount (record tier) and the
 * device-local store mount (append tier, R3-558's `openLocalStore`), and build
 * the store over both. The journal mount is OPTIONAL: when it is unavailable
 * (signed out, capability absent, browser refused) the store is journalless —
 * runs still work, save-at-run-end still works, and the caller surfaces the
 * degradation (R-ARD-10) rather than refusing to run.
 */
export async function openConversationStore(): Promise<ConversationStore> {
  const recordMount = await openSettings();
  let journalRoot: string | undefined;
  try {
    journalRoot = (await openLocalStore()).path;
  } catch {
    journalRoot = undefined; // journalless — degrade loudly at the caller
  }
  return createConversationStore({
    recordRoot: recordMount.path,
    ...(journalRoot !== undefined ? { journalRoot } : {}),
    fs: fs.promises as unknown as StoreFs,
  });
}

// Conversation persistence (agent-conversations plan, Phase 01; R3-559 adds the
// checkpoint journal). The RECORD is one JSON file per conversation under the
// app's `openSettings()` mount — a per-(user,app), chrooted, durable, SYNCED
// directory (capability `settings:app`, baseline). The JOURNAL is the two-tier
// checkpoint's append tier (AGENT_RUN_DURABILITY_SPEC §4): one immutable JSON
// entry per loop boundary under the device-local `openLocalStore()` mount
// (R3-558), folded into the record at run end and at every compaction (R-ARD-9;
// the after-N-entries cadence is deliberately unimplemented — N is spec Q3, "a
// measurement, not a guess").
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
import {
  LEASE_HEARTBEAT_MS,
  isExpired,
  leaseVerdict,
  mintLease,
  nextHeartbeat,
  parseLease,
  stillHeld,
  type Lease,
  type LeaseVerdict,
} from './lease';

const DIR = 'conversations'; // subdir under each mount root
const LIST_CAP = 500; // defensive cap on conversations surfaced
const TITLE_MAX = 60;
/** One entry file per boundary, under `<journalRoot>/conversations/<id>/journal/`
 *  (R-ARD-5a: a SUBDIRECTORY of the conversation — sibling `.json` files would
 *  make `list()` O(checkpoints) reads). */
const JOURNAL_DIR = 'journal';
/** R3-561 — the advisory run lease: `<journalRoot>/conversations/<id>/lease.json`,
 *  a sibling of that conversation's `journal/` directory.
 *
 *  ON THE DEVICE-LOCAL TIER, not the synced record tier, for two reasons. The
 *  first is a rule this file's own tests already assert: *"the record itself is
 *  untouched by appends — the synced tier is not in the loop's hot path"*
 *  (R-ARD-6). A lease beside the RECORD would put a heartbeat write on the
 *  Firestore-backed tier inside the run loop, which is the thing R-ARD-6 exists to
 *  keep out of it. The second is that it is also the more correct home: what the
 *  lease guards — `seq` allocation, journal appends, and the working tree the run
 *  drives — is device-local, and a frame on another DEVICE cannot double-drive a
 *  working tree it cannot reach, so a synced lease would refuse runs it has no
 *  business refusing.
 *
 *  It follows that a JOURNALLESS store has no lease. That is coherent rather than
 *  a hole: `seq` does not exist, `append` rejects `journal-unavailable` whatever
 *  the lease says, and the device-local mount is absent precisely because the
 *  browser or the capability refused it — the substrate two frames would
 *  coordinate through is the one that is missing. Such a run is degraded and says
 *  so (R-ARD-10); this is one more way in which it is.
 *
 *  Note the gate is INERT there rather than ordered behind that rejection: with no
 *  `journalRoot`, `checkHold` answers true and `tryAcquire` answers `free`. An
 *  earlier comment here claimed the ordering mattered; the review gate moved the
 *  throw and nothing changed, so the claim is withdrawn rather than left standing. */
const LEASE_FILE = 'lease.json';
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
  /** B1: the assistant turn's finalized blocks (a `partial: true` turn is one an
   *  `interrupt` steer cut short — R3-560's repair discards it when trailing). */
  blocks?: ContentBlock[];
  partial?: boolean;
  /** B2: the tool_use block about to be executed (marked started). */
  call?: ToolUseBlock;
  /** B3: one completed call's tool_result. */
  result?: ToolResultBlock;
  /** B3: the images this call produced (they ride with the results message). */
  images?: ImageBlock[];
  /** B4: the loop's carried accounting (`runEnd: true` marks a clean finish). */
  runState?: RunState;
  runEnd?: true;
  /** B5: the injected user turn (steer, nudge, truncation retry). */
  message?: ChatMessage;
  /** B0 (R3-560, R-ARD-16): the workspace label the run authored. */
  workspace?: string;
  /** B0 (R3-560, R-ARD-17): the pinned system-prompt prefix bytes. */
  systemPrefix?: string;
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
  /** R3-560: the last applied entry was a `partial` B1 — the trailing
   *  half-finished assistant turn repair must DISCARD, not complete. */
  trailingPartial: boolean;
  /** R3-560: how many entries were applied above the fold (0 ⇒ no journal
   *  evidence — a finished conversation whose entries were folded away). */
  journalDepth: number;
  /** R3-560: the last applied entry was the final `runEnd` B4 — the run finished
   *  cleanly, nothing to resume. */
  runEnded: boolean;
  /** R3-560 (R-ARD-16): the workspace label the (latest) B0 stamped, if any. */
  stampedWorkspace?: string;
  /** R3-560 (R-ARD-17): the pinned system-prompt prefix bytes from B0, if any. */
  systemPrefix?: string;
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
   *  transcript (byte-true to what the model saw). A PATCH-LESS fold (the
   *  compaction-time fold, mid-run) persists the checkpointed copies — which is
   *  where R-ARD-5b's entry-size truncation is visible by design; the run-end
   *  fold with `patch.messages` is the fidelity-restoring write. Returns the
   *  persisted record. */
  fold(convId: string, patch?: { messages?: ChatMessage[]; title?: string; repo?: string }): Promise<Conversation>;
  // ---- R3-561: the advisory run lease (AGENT_RUN_DURABILITY_SPEC §6) ----
  /** Try to take the run lease. `free` ⇒ this frame may execute, allocate `seq`
   *  and append; `held` ⇒ another frame's lease is still live and the caller
   *  offers a TAKEOVER (never a hard block — R-ARD-18a). A lease this frame's own
   *  `tabId` left behind is reclaimed immediately, which is what makes the
   *  canonical teardown-and-return flow resumable rather than `held`. */
  acquireRun(convId: string): Promise<LeaseVerdict>;
  /** Take the lease over a live foreign one — the explicit user action behind the
   *  `held` offer. */
  takeOverRun(convId: string): Promise<void>;
  /** Do we still hold it? Re-reads the stored lease when a heartbeat is due, and
   *  refreshes it when we do. `false` means we lost it — someone took over, or the
   *  conversation was removed under us. Call at each loop boundary. */
  holdsRun(convId: string): Promise<boolean>;
  /** Drop the lease if we hold it. Best-effort: no unload handler can be relied
   *  on, so the TTL and same-tab reclaim are what actually free a lease. */
  releaseRun(convId: string): Promise<void>;
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

/** R3-560: did this thrown value come from the journal's fail-closed refusals
 *  (corrupt / unknown schema / incoherent seq / timeout / unavailability)?
 *  The ONE predicate — callers never re-type the `journal-` prefix dance. The
 *  user-facing copy that names the durability consequence lives with the catch
 *  sites in ConversationStage (JOURNAL_REFUSAL_SUFFIX), which is where run
 *  surfaces live. */
export const isJournalRefusal = (e: unknown): boolean =>
  typeof (e as { code?: string })?.code === 'string' && ((e as { code: string }).code.startsWith('journal-'));

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
  /** R3-561 — this FRAME's identity, stable for the life of the document. Same-tab
   *  reclaim keys on it, so a per-store DEFAULT would defeat the reclaim R-ARD-18a
   *  calls mandatory the moment a frame built a second store — and the panel and
   *  the stage are exactly that. REQUIRED rather than defaulted for that reason:
   *  the default this field used to carry was the very thing this comment warns
   *  against. Production passes `documentTabId()`; tests pass a literal to play
   *  two frames. */
  tabId: string;
  /** Injected clock (R3-561). Tests advance it to reach a heartbeat or a TTL
   *  without timers. */
  now?: () => number;
}): ConversationStore {
  const p = opts.fs;
  const recordDir = `${opts.recordRoot.replace(/\/+$/, '')}/${DIR}`;
  const journalRoot = opts.journalRoot ? opts.journalRoot.replace(/\/+$/, '') : undefined;
  const convJournalDir = (id: string): string => `${journalRoot}/${DIR}/${id}/${JOURNAL_DIR}`;
  const file = (id: string): string => `${recordDir}/${id}.json`;
  // seq allocation (R-ARD-5c: by the lease holder — this writer, until R3-561's
  // advisory lease exists). Lazily seeded per conversation from the journal head
  // AND the record's fold watermark, so a fold that reclaimed entries still mints
  // seqs above everything the record already contains. The cache only ever moves
  // FORWARD (clamp): a mid-run fold's snapshot can be staler than appends that
  // landed while its synced-tier save was in flight, and a backward move would
  // re-mint a durable seq and silently overwrite that entry.
  const lastSeq = new Map<string, number>();
  const bumpSeq = (id: string, seq: number): void => {
    lastSeq.set(id, Math.max(lastSeq.get(id) ?? 0, seq));
  };
  // Folds are SERIALIZED per conversation (chained): a mid-run compaction fold
  // and the run-end fold both write the record and reclaim entries, and two in
  // flight at once could write watermarks out of order. Chaining also makes the
  // run-end fold await any in-flight mid-run fold.
  const foldChain = new Map<string, Promise<unknown>>();

  // ── R3-561: the advisory run lease ────────────────────────────────────────
  // ADVISORY, and nothing here may say otherwise. There is no conditional write
  // at the SDK's file surface, so the loser of a race is NOT detected by the
  // store; two frames can both believe they hold a lease. See `lease.ts`.
  const tabId = opts.tabId;
  const clock = opts.now ?? (() => Date.now());
  /** The lease we minted, per conversation, while we believe we hold it. Absent ⇒
   *  this frame may not execute, allocate `seq` or append. */
  const held = new Map<string, Lease>();
  /** When each held lease is next due a re-read + refresh. */
  const beatDue = new Map<string, number>();
  /** Conversations this store HELD and then lost — taken over, or removed under
   *  it. A latch, and the reason `append` does not simply re-acquire: silently
   *  taking the lease back would resume a run the user moved to another window,
   *  which is the double-drive this whole mechanism exists to avoid. Cleared only
   *  by an explicit `acquireRun`/`takeOverRun`, i.e. by the user asking again. */
  const lost = new Set<string>();
  const leaseFile = (id: string): string => `${journalRoot}/${DIR}/${id}/${LEASE_FILE}`;

  /**
   * Read the stored lease.
   *
   * THREE outcomes, not two, and the third is load-bearing:
   *   - a `Lease`         — it is there and well-formed
   *   - `null`            — genuinely ABSENT (ENOENT, or bytes `parseLease` refuses)
   *   - `'unreadable'`    — the mount could not answer
   *
   * Collapsing the third into `null` is a real bug, not a tidiness question,
   * because the two callers want OPPOSITE defaults from it. `tryAcquire` is
   * deciding whether it may start, so absent-reads-as-takeable is right there —
   * fail toward letting the user work. `checkHold` is asking whether it still
   * holds, and reading a fault as "someone took it" both ends the run and LATCHES
   * the frame out, while our own unexpired lease is still on disk. The review gate
   * measured it: one injected `EBUSY` refused every later append for the session
   * and told the user another window had taken over, which had not happened.
   */
  const readLease = async (id: string): Promise<Lease | null | 'unreadable'> => {
    if (!journalRoot) return null;
    let raw: string;
    try {
      raw = await p.readFile(leaseFile(id), 'utf8');
    } catch (e) {
      // ENOENT is the ordinary "no lease yet". Anything else is the mount failing
      // to answer a question we asked, which is not evidence about the lease.
      return code(e) === 'ENOENT' ? null : 'unreadable';
    }
    return parseLease(raw); // malformed bytes ARE absence — `parseLease` says why
  };

  const writeLease = async (id: string, lease: Lease): Promise<void> => {
    await p.mkdir(`${journalRoot}/${DIR}/${id}`, { recursive: true });
    await p.writeFile(leaseFile(id), JSON.stringify(lease));
    held.set(id, lease);
    beatDue.set(id, clock() + LEASE_HEARTBEAT_MS);
    lost.delete(id);
  };

  /** Take the lease if it is takeable. The one place a lease is minted. A
   *  journalless store has no lease substrate, so it is always `free` — see
   *  `LEASE_FILE`. */
  const tryAcquire = async (id: string): Promise<LeaseVerdict> => {
    if (!journalRoot) return 'free';
    const now = clock();
    const stored = await readLease(id);
    // An unreadable mount reads as takeable HERE, deliberately: this caller is
    // deciding whether the user may start, and refusing on a fault would strand
    // them behind a lease nobody can even read. The opposite default belongs to
    // `checkHold` — see `readLease`.
    //
    // `leaseVerdict`, not a second spelling of its body: the rule "takeable ⇒
    // free" is decided in `lease.ts` and tested there, and a copy here would be a
    // second place for it to drift.
    if (leaseVerdict(stored === 'unreadable' ? null : stored, tabId, now) === 'held') return 'held';
    await writeLease(id, mintLease(genId(), tabId, now));
    return 'free';
  };

  const forget = (id: string, latch: boolean): void => {
    if (latch && held.has(id)) lost.add(id);
    held.delete(id);
    beatDue.delete(id);
  };

  /**
   * Do we hold the lease?
   *
   * The stored lease is re-read EVERY time, never cached behind the heartbeat
   * window. An earlier version skipped the read until a beat was due, and the
   * review gate measured what that bought: for up to a full `LEASE_HEARTBEAT_MS`
   * after another frame took over, this one still answered `true` and kept
   * appending into the new holder's journal. Colliding `seq`s OVERWRITE an entry
   * rather than leave a gap, so `replay`'s contiguity check — the thing that would
   * otherwise catch it — cannot see the damage at all. A read per boundary against
   * the device-local tier is the cheapest correctness there is here.
   *
   * The beat still decides whether to WRITE a refresh, which is the expensive half.
   */
  const checkHold = async (id: string): Promise<boolean> => {
    if (!journalRoot) return true; // nothing to coordinate — see `LEASE_FILE`
    const mine = held.get(id);
    if (!mine) return false;
    const now = clock();
    const stored = await readLease(id);
    // A mount that could not answer is NOT evidence that we lost the lease — but
    // it is not a licence to hold one forever either, and this branch returns
    // BEFORE the refresh below, so a frame whose reads keep failing would both
    // keep claiming the lease and stop writing heartbeats. The review gate measured
    // that: across 2.5 TTLs of persistent EBUSY the frame answered `true` every
    // time, its stored `expiresAt` never moved, a second frame's `acquireRun`
    // answered `free`, and both then minted the same `seq` — one entry overwriting
    // the other, which is the damage `replay`'s contiguity check cannot see.
    //
    // So the hold is bounded by the lease we already have, which is what "let the
    // TTL decide" has to mean if it means anything. A transient fault is harmless
    // (we are well inside our own expiry); a fault we can no longer justify holding
    // through stops being a hold, and latches like any other loss.
    if (stored === 'unreadable') {
      if (!isExpired(mine, now)) return true;
      forget(id, true);
      return false;
    }
    if (!stillHeld(stored, mine.holderId)) {
      forget(id, true); // taken over, or the conversation was removed under us
      return false;
    }
    if (now >= (beatDue.get(id) ?? 0)) await writeLease(id, nextHeartbeat(mine, now));
    return true;
  };

  /** Why we are not holding it — only ever read on the failure path, so the extra
   *  record read costs nothing in the common case. */
  const lostReason = async (id: string): Promise<'conversation-removed' | 'lease-lost'> =>
    (await load(id)) === null ? 'conversation-removed' : 'lease-lost';

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
    // R3-561 / R-ARD-18: only the lease holder allocates `seq` or appends. The
    // check is BEFORE `nextSeq`, so a frame that does not hold the lease never
    // mints a number — two frames minting from one journal head is the corruption
    // this gate exists to prevent, and a minted-then-discarded seq is already a
    // gap `replay`'s contiguity check would refuse.
    //
    // ACQUISITION IS IMPLICIT on the first append, and deliberately so. Three
    // openers of this store ship today — the panel, the stage, and the standalone
    // agent (§11) — and a gate that only rejected callers which forgot an explicit
    // `acquireRun` would be a runtime regression in a shipped surface rather than
    // a coordination mechanism. A first-time appender therefore takes the lease if
    // it is takeable, which is what "only the holder may append" means when the
    // holder set is empty.
    //
    // A LOST lease is NOT re-acquired. Once this frame has held and lost one, the
    // latch refuses every later append until the user explicitly asks again —
    // silently taking it back would resume a run the user moved to another window.
    if (!(await checkHold(convId)) && (lost.has(convId) || (await tryAcquire(convId)) === 'held')) {
      throw errWithCode(await lostReason(convId), 'this frame does not hold the run lease');
    }
    const payload = boundEntryPayload(b) as Partial<JournalEntry>;
    // Bounded write (R-ARD-10a): the WHOLE append path — seq seeding (which may
    // read the journal dir and, on a cold boot, the record's fold watermark on
    // the synced tier) plus the file write — races a timer. A timeout is a
    // failure, never a silent hang the run executes past.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        (async (): Promise<number> => {
          const seq = await nextSeq(convId);
          bumpSeq(convId, seq);
          const entry: JournalEntry = { ...payload, seq, kind: b.kind, schema: 1, t: b.t };
          await p.mkdir(convJournalDir(convId), { recursive: true });
          await p.writeFile(`${convJournalDir(convId)}/${seq}.json`, JSON.stringify(entry));
          return seq;
        })(),
        new Promise<never>((_, rej) => {
          timer = setTimeout(() => rej(errWithCode('journal-timeout', 'journal append timed out')), APPEND_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
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
    // R3-560: the interruption/identity facts the repair path reads.
    let trailingPartial = false;
    let runEnded = false;
    let journalDepth = 0;
    let stampedWorkspace: string | undefined;
    let systemPrefix: string | undefined;
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
    // R3-560 (G-ARD-5): seq must be CONTIGUOUS above the fold. Appends mint
    // sequentially and each write settles before the next boundary, so a gap is
    // a torn or tampered journal — fail closed, never a best-effort partial
    // replay of an incoherent record (R-ARD-14).
    let expectedSeq = foldedSeq;
    for (const e of entries) {
      if (e.seq <= foldedSeq) continue; // already folded into the record — harmless
      expectedSeq += 1;
      if (e.seq !== expectedSeq) {
        throw errWithCode(
          'journal-corrupt',
          `journal seq incoherent above the fold: expected ${expectedSeq}, found ${e.seq}`,
        );
      }
      // Fail closed on a known kind with a missing payload, for the same reason
      // the unknown-kind default refuses: a silently skipped B5 yields
      // provider-invalid consecutive assistant messages, a B0/B6 without its
      // array wipes the transcript to []. Corrupt is corrupt — name it.
      const missing = (() => {
        switch (e.kind) {
          case 'B0':
          case 'B6':
            return e.messages === undefined ? 'messages' : null;
          case 'B1':
            return e.blocks === undefined ? 'blocks' : null;
          case 'B2':
            return e.call === undefined || e.effectId === undefined ? 'call/effectId' : null;
          case 'B3':
            return e.result === undefined || e.effectId === undefined ? 'result/effectId' : null;
          case 'B5':
            return e.message === undefined ? 'message' : null;
          default:
            return null; // B4 carries no required payload; unknown kinds refused below
        }
      })();
      if (missing) {
        throw errWithCode('journal-corrupt', `journal entry ${e.seq} (${e.kind}) is missing its ${missing} payload`);
      }
      trailingPartial = false;
      runEnded = false;
      journalDepth += 1;
      switch (e.kind) {
        case 'B0':
          closeBatch();
          // Kickoff REPLACES: the entry carries the run's full initial array
          // (history + prompt), and the record may hold an older or empty prefix.
          messages = [...(e.messages ?? [])];
          stampedWorkspace = e.workspace ?? stampedWorkspace;
          systemPrefix = e.systemPrefix ?? systemPrefix;
          break;
        case 'B1':
          closeBatch();
          messages.push({ role: 'assistant', content: [...(e.blocks ?? [])] });
          trailingPartial = e.partial === true;
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
          runEnded = e.runEnd === true;
          break;
        case 'B5':
          closeBatch();
          if (e.message) messages.push(e.message);
          break;
        case 'B6':
          closeBatch();
          messages = [...(e.messages ?? [])];
          break;
        default: {
          // Fail closed on doubt: the schema check refuses an unknown version for
          // exactly this reason (R-ARD-5d) — an entry silently skipped here would
          // corrupt replay without a sound, so an unknown KIND is refused too.
          const kind = (e as { kind?: string }).kind;
          throw errWithCode('journal-corrupt', `journal entry ${e.seq} has unknown kind ${String(kind)}`);
        }
      }
      lastSeqApplied = Math.max(lastSeqApplied, e.seq);
    }
    closeBatch();
    // R3-560 (G-ARD-5, R-ARD-14): a tool_result for a call never issued — no
    // `tool_use` with that id anywhere in the assembled transcript — is a
    // hostile or incoherent record, not data to replay. Refuse it.
    const issuedIds = new Set(
      messages.flatMap((m) => m.content).filter((b) => b.type === 'tool_use').map((b) => (b as ToolUseBlock).id),
    );
    for (const b of messages.flatMap((m) => m.content)) {
      if (b.type === 'tool_result' && !issuedIds.has(b.tool_use_id)) {
        throw errWithCode(
          'journal-corrupt',
          `journal replays a tool_result for a call never issued (${b.tool_use_id})`,
        );
      }
    }
    return {
      messages,
      runState,
      foldedSeq,
      lastSeq: lastSeqApplied,
      pendingEffects: [...pending.values()],
      trailingPartial,
      runEnded,
      journalDepth,
      ...(stampedWorkspace !== undefined ? { stampedWorkspace } : {}),
      ...(systemPrefix !== undefined ? { systemPrefix } : {}),
    };
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
    // Serialized per conversation: the chained predecessor (if any) completes
    // first, so two folds can never write watermarks out of order.
    const prior = foldChain.get(id) ?? Promise.resolve();
    const run = (): Promise<Conversation> => foldNow(id, patch);
    const chained = prior.then(run, run);
    foldChain.set(id, chained);
    try {
      return await chained;
    } finally {
      if (foldChain.get(id) === chained) foldChain.delete(id);
    }
  };

  const foldNow = async (
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
    // CLAMPED forward: appends that landed while the (synced-tier) record save
    // was in flight are already above the snapshot — never move the cache back.
    bumpSeq(id, replayed.lastSeq);
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
      // R3-561 / R-ARD-18b: `remove` is NOT lease-gated — the panel and the stage
      // are the same app on the same mount, and gating the panel's writes would
      // break a shipped surface. The `rmTree` above takes the lease with it (it
      // is a sibling of `journal/` under the same directory), which is exactly how
      // a holder mid-run FINDS OUT: its next boundary reads an absent lease, drops
      // its hold, and `append` rejects `conversation-removed`. The run stops there
      // rather than folding the record back into existence.
      forget(id, false); // our own delete: nothing to latch against
    },

    hasJournal: () => journalRoot !== undefined,
    append,
    replay,
    fold,

    acquireRun: tryAcquire,

    async takeOverRun(convId) {
      // The explicit user action behind the `held` offer. It does not consult the
      // stored lease: the point of a takeover is that the user has decided the
      // other window is not really running this.
      //
      // The `journalRoot` guard is not decoration. `writeLease` interpolates it,
      // so without this a journalless store wrote `undefined/conversations/<id>/
      // lease.json` — a relative path in neither mount — and then reported
      // `holdsRun` true off the in-memory copy. Every other lease method guards;
      // this one did not.
      if (!journalRoot) return;
      await writeLease(convId, mintLease(genId(), tabId, clock()));
    },

    holdsRun: checkHold,

    async releaseRun(convId) {
      const mine = held.get(convId);
      forget(convId, false); // a deliberate release is not a loss — no latch
      if (!mine) return;
      // Only delete a lease that is still OURS — a takeover may have replaced it
      // while we were working, and deleting the new holder's lease would hand the
      // conversation to whoever asked next. This NARROWS that window, it does not
      // close it: the read and the unlink are two awaits apart and there is no
      // conditional delete to make them one, so a takeover landing between them is
      // still deleted. Said plainly because the rest of this mechanism is careful
      // not to overclaim.
      const stored = await readLease(convId);
      if (stored === 'unreadable' || !stillHeld(stored, mine.holderId)) return;
      if (!journalRoot) return;
      try {
        await p.unlink(leaseFile(convId));
      } catch {
        /* best-effort: the TTL and same-tab reclaim are what actually free it */
      }
    },
  };
}

/** This FRAME's identity for the life of the document (R3-561). Module-level, so
 *  two stores built in one frame — the panel and the stage are the same app —
 *  share it and each can reclaim the other's lease. It never leaves the frame and
 *  it is not persisted, which is the point: a reload is a NEW frame, and the lease
 *  it left behind is freed by its TTL rather than reclaimed by identity. */
let TAB_ID: string | undefined;
const documentTabId = (): string => (TAB_ID ??= genId());

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
    tabId: documentTabId(),
  });
}

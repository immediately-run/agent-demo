// The conversation STAGE — the stage-slot half of the agents activity (plan Phase
// 05, region `stage.conversation`). The analog of the editor: it loads the
// conversation the panel selected, shows its transcript, and runs the in-browser
// agent loop, persisting every turn. The loop, tools, streaming, and host-mediated
// BYOK are the same machinery the standalone CodingAgent uses (LLM_AND_AGENTS_SPEC
// §3.3); confinement is automatic (G12/T24): catalog ⊕ mount-chroot fs tools only.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useCatalog,
  useMounts,
  getAppMountPath,
  useWorkspace,
  postToRegion,
  onRegionMessage,
  describeChat,
} from "@immediately-run/sdk";
import { catalogToolset, mergeToolsets } from "../lib/toolset";
import { createFsToolset, findConferredWorktree } from "../lib/fsTools";
import { createProjectToolset } from "../lib/projectTools";
import { createDiagnosticsToolset } from "../lib/diagnosticsTools";
import { createGitToolset } from "../lib/gitTools";
import { buildPinnedPrefix, buildLiveSuffix, composeSystemPrompt, todayIso } from "../lib/agentPrompt";
import { withSkills } from "../lib/skills";
import { createChatModelClient } from "../lib/chatModelClient";
import { runAgent, type RunState } from "../lib/agentLoop";
import { SteerController, INTERRUPTED_TURN_TEXT, type SteerMessage, type SteerMode } from "../lib/steering";
import { repairTranscript, interrupted, divergenceMessage, resumedMessages } from "../lib/resume";
import { LEASE_HEARTBEAT_MS } from "../lib/lease";
import { openConversationStore, deriveTitle, isJournalRefusal, type ConversationStore, type ReplayResult } from "../lib/conversationStore";
import {
  openSessionProjectionWriter,
  createProjectionPublisher,
  type SessionProjectionWriter,
  type ProjectionPublisher,
} from "../lib/sessionProjection";
import { createStageSelection, type StageSelection } from "../lib/stageSelection";
import { useStickToBottom } from "../hooks/useStickToBottom";
import type { Conversation } from "../lib/conversationModel";
import { messagesToLog, type LogEntry } from "../lib/transcript";
import TranscriptRows from "./TranscriptRows";
import { PANEL_REGION, isSelect } from "../lib/conversationIpc";
import { describeStoreFailure as describe } from "../lib/storeError";
import "./CodingAgent.css";

// R-ARD-10: the copy for a dead settings store names BOTH costs — the amnesia
// (history not re-sent) and the durability consequence (a closed tab loses the
// run). One constant so a fourth call site cannot ship the old copy.
const NO_STORE_SUFFIX =
  ", so each message is sent without the earlier ones — and a closed tab loses the run, not just the in-flight turn";

// R-ARD-10a: the copy for a checkpoint-append refusal — the run stopped AT a
// boundary and everything checkpointed so far survives. One home, used by both
// run surfaces's journal-failure catches.
const JOURNAL_REFUSAL_SUFFIX =
  ", so the run stopped at its last checkpoint — nothing after it was kept";

export default function ConversationStage() {
  const catalog = useCatalog();
  const mounts = useMounts();
  const storeRef = useRef<ConversationStore | null>(null);
  const convRef = useRef<Conversation | null>(null);
  // R3-631 — the session projection (CONTRIBUTE_TRANSCRIPT_SPEC §3): the writer and
  // the named-heartbeat publisher over it. Opened/built beside the store on the
  // SAME settings mount; a dead writer costs only the feature (the host never sees
  // a heartbeat ⇒ never offers ⇒ fail-closed), never the conversation. The trigger
  // semantics live in `sessionProjection.ts` (extracted like `stageSelection.ts`
  // so they are testable without a DOM); this component only names the moments.
  const projectionRef = useRef<SessionProjectionWriter | null>(null);
  const publisherRef = useRef<ProjectionPublisher | null>(null);
  // R3-224 (§3.3): the stop button's abort controller for the in-flight run. Aborting
  // it halts the loop AND tears down the in-flight upstream LLM request (stops billing).
  const abortRef = useRef<AbortController | null>(null);
  // R3-333: the mid-run steering queue. STOP (above) ends the run; STEER redirects it
  // without discarding the transcript. One controller per run, so a correction the
  // user took back never leaks into the next one.
  const steerRef = useRef<SteerController | null>(null);
  const [queued, setQueued] = useState<readonly SteerMessage[]>([]);
  const [steerText, setSteerText] = useState("");
  const [log, setLog] = useState<LogEntry[]>([]);
  const [prompt, setPrompt] = useState("");
  const [streaming, setStreaming] = useState("");
  // R3-335 — the in-flight reasoning for the current turn (cleared when the whole block
  // arrives and becomes a transcript row).
  const [thinking, setThinking] = useState("");
  // R3-336 — the run's token accounting, including prompt-cache reads/writes where the
  // provider reports them. Surfacing it is what makes caching verifiable rather than
  // believed; without a number on screen the cost claim is unfalsifiable.
  const [usage, setUsage] = useState<{
    spentTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  } | null>(null);
  const [running, setRunning] = useState(false);
  // Which conversation a run is in flight for — a ref, so the arbiter's per-id probe can
  // read it without rebuilding. Set when a run starts, cleared when it ends.
  const runningIdRef = useRef<string | null>(null);
  const [title, setTitle] = useState<string>("");
  // The conversation currently shown — keys the transcript scroller so a switch resets
  // its follow state (a release in one conversation must not carry into the next).
  const [convId, setConvId] = useState<string | undefined>(undefined);
  // Why persistence is unavailable, if it is. The conversation store is not a
  // nice-to-have: `run()` reads the model's HISTORY out of the persisted
  // conversation, so a dead store silently downgrades the agent to a stateless
  // chatbot that re-reads nothing between turns. That failure used to be
  // swallowed by empty `catch {}`s — surface it instead (R3-247).
  const [storeError, setStoreError] = useState<string | null>(null);
  /** R3-561 — another frame's run lease is live on this conversation. Renders as
   *  an OFFER to take over, never as a block (R-ARD-18a): the lease is advisory,
   *  the holder may be a window that no longer exists, and a hard block on it is a
   *  dead end the user cannot escape. Carries the action that was refused, so
   *  "take over" continues what the user asked for rather than making them ask
   *  twice. */
  const [leaseHeld, setLeaseHeld] = useState<null | { convId: string; resume: boolean }>(null);
  // R3-560: an interrupted run detected on this conversation — the journal says
  // a run was in flight and never reached its final `runEnd` B4. Resume is
  // ATTENDED (R-ARD-15): rendering this affordance is all the boot path does;
  // no model call, no executor, nothing until the user picks an action.
  const [pendingResume, setPendingResumeState] = useState<{ convId: string; replay: ReplayResult } | null>(null);
  // Ref mirror — the attended gate in run() must read the CURRENT value after
  // awaiting an in-flight replay, which a render-closed state variable cannot give.
  const pendingResumeRef = useRef<{ convId: string; replay: ReplayResult } | null>(null);
  const setPendingResume = (v: { convId: string; replay: ReplayResult } | null): void => {
    pendingResumeRef.current = v;
    setPendingResumeState(v);
  };
  // The boot replay currently in flight, if any — `run()` must not start past an
  // unresolved interruption check (the TOCTOU hole: a kickoff that slips between
  // the replay call and its result takes the restart-and-lose-tail path).
  const replayInFlightRef = useRef<{ convId: string; promise: Promise<void> } | null>(null);

  // R3-615 — follow the stream. The transcript and the live reasoning box each pin to
  // their newest row while the reader is at the bottom, and stop the moment they scroll
  // up — resuming only on return. Two scrollers, one hook, called twice.
  const logRef = useRef<HTMLUListElement>(null);
  const reasoningRef = useRef<HTMLSpanElement>(null);
  // The transcript scroller follows everything that grows inside it — the settled rows,
  // the live reasoning block and the live reply — so it is keyed on all three, not just
  // the settled rows (the live rows stream without touching `log`).
  const transcriptFlow = useMemo(
    () => [log, thinking, streaming],
    [log, thinking, streaming],
  );
  useStickToBottom(logRef, transcriptFlow);
  useStickToBottom(reasoningRef, thinking);

  // The STAGE app's working tree, conferred by the host as a `type:'worktree'` mount
  // (AA-23) — NOT the agent's OWN repo. If it isn't conferred (the mount hasn't arrived,
  // churned away, or no app is loaded), this is `null` and we MUST NOT fall back to the
  // agent's own repo: doing so made the workbench silently author *itself* (every
  // stage-app path read `not found`, and the model floundered). Re-derived when the
  // conferred mount changes (switching the loaded app tears down the old port, mints new).
  const stageTree = useMemo(() => findConferredWorktree(mounts, getAppMountPath()), [mounts]);

  // Tools given to the model. Without the stage tree the agent gets the catalog ONLY —
  // no filesystem tools — so it can never edit the wrong (its own) repo. Run is gated
  // below and a "workspace not ready" notice is shown.
  // R3-339 — does the model the user configured accept images? The tool is told, so a
  // `read_file` on a PNG can SAY the model cannot look at it instead of sending
  // something that errors upstream. Re-read when the provider changes.
  const vision = useMemo(() => describeChat()?.features.vision === true, []);

  const { toolset, skills } = useMemo(() => {
    // No conferred stage tree ⇒ a catalog-only toolset with no authoring tools, so
    // `withSkills` offers nothing and `load_skill` is absent — the authoring skills
    // would be advice the agent cannot act on (R3-331).
    if (!stageTree) return withSkills(catalogToolset(catalog));
    const fsTools = createFsToolset({ root: stageTree.root, readOnly: stageTree.readOnly, vision });
    const projectTools = createProjectToolset({ root: stageTree.root, readOnly: stageTree.readOnly });
    const diagnosticsTools = createDiagnosticsToolset();
    // R3-332: git-READ over the same working tree. Empty (and therefore invisible to
    // the model) unless the app holds `vcs:read`.
    const gitTools = createGitToolset({ catalog });
    // `withSkills` stays LAST (R3-331): which host skills are offered depends on the
    // final merged tool list, so it has to see the git tools too.
    return withSkills(mergeToolsets(catalogToolset(catalog), fsTools, projectTools, diagnosticsTools, gitTools));
  }, [catalog, stageTree, vision]);

  const append = (e: LogEntry) => setLog((l) => [...l, e]);

  // R3-561 / R-ARD-18 — the lease is "refreshed on an interval WHILE THE RUN
  // EXECUTES", and this is that interval. It cannot be boundary-driven: `holdsRun`
  // refreshes, but the loop only reaches a boundary after the model turn returns,
  // and a single slow turn routinely outlasts `LEASE_TTL_MS`. A running frame
  // would then let its own lease expire and a second tab would read `free` — the
  // double-drive the lease exists to prevent, arriving through the mechanism meant
  // to prevent it.
  //
  // `holdsRun` returning false means we lost it mid-run. We do NOT stop the loop
  // here: the run is between boundaries, its tool call is in flight, and the
  // honest stopping point is the next append, which rejects `lease-lost` and is
  // rendered by the catch above. What this does is raise the offer immediately
  // rather than leaving the user watching a run that is already doomed.
  useEffect(() => {
    if (!running) return;
    const id = runningIdRef.current;
    const store = storeRef.current;
    if (!id || !store) return;
    const t = setInterval(() => {
      void store
        .holdsRun(id)
        .then((still) => {
          if (!still) setLeaseHeld({ convId: id, resume: false });
        })
        .catch(() => {
          /* a refresh that cannot run is not a loss — the TTL decides */
        });
    }, LEASE_HEARTBEAT_MS);
    return () => clearInterval(t);
  }, [running]);

  const showConversation = useCallback((conv: Conversation) => {
    convRef.current = conv;
    setConvId(conv.id);
    setTitle(conv.title);
    setLog(messagesToLog(conv.messages));
    setStreaming("");
    publisherRef.current?.onShow();
    // R3-560: is there an interrupted run on this conversation? Read the JOURNAL
    // (not warm state) and offer the attended choices if so. Read-only — the
    // boot path executes nothing (G-ARD-4). When interrupted, the transcript
    // rendered is the REPLAYED one — the record alone is folded through the last
    // run end and would show a blank/stale view over a live tail (R-ARD-15).
    setPendingResume(null);
    // R3-561: the takeover offer belongs to the conversation that raised it. Left
    // standing across a switch it would take over the NEW one — `takeOverRun`
    // deliberately consults no stored lease, so it would evict a live holder of a
    // conversation the user never asked about. Cleared here, and the render below
    // carries a `convId` guard the way `pendingResume` does.
    setLeaseHeld(null);
    const store = storeRef.current;
    if (store?.hasJournal()) {
      const promise = store
        .replay(conv.id)
        .then((r) => {
          if (convRef.current?.id !== conv.id || runningIdRef.current !== null) return;
          if (!interrupted(r)) return;
          setLog(messagesToLog(r.messages));
          setPendingResume({ convId: conv.id, replay: r });
        })
        .catch((e) => {
          // R-ARD-14 / §9: a refused journal (corrupt/schema/incoherent) means
          // the conversation is UN-RESUMABLE — say the resume was withheld,
          // never silently best-effort it. Other failures are store faults.
          if (convRef.current?.id !== conv.id) return;
          if (isJournalRefusal(e)) {
            append({
              kind: "error",
              text: "This conversation's checkpoint journal can't be read, so its interrupted run can't be resumed — the saved conversation still opens.",
            });
          } else {
            setStoreError(describe(e, NO_STORE_SUFFIX));
          }
        })
        .finally(() => {
          // Promise-identity, not convId: a same-conversation re-select (the
          // panel's repair gesture) starts a NEWER replay whose marker the older
          // promise's finally must not clear.
          if (replayInFlightRef.current?.promise === promise) replayInFlightRef.current = null;
        });
      replayInFlightRef.current = { convId: conv.id, promise };
    }
  }, []);

  // One arbiter per mount (never module scope): it holds the held selection and the
  // latest-wins ticket, and is created fresh so a remount starts clean. Created in an
  // effect rather than during render — `show` = `showConversation` writes `convRef`, and
  // the React Compiler's `refs` rule forbids a ref access (or a function carrying one)
  // from reaching a render path.
  const stageSelectionRef = useRef<StageSelection | null>(null);
  useEffect(() => {
    stageSelectionRef.current = createStageSelection({
      show: showConversation,
      isRunning: (id) => runningIdRef.current === id,
    });
    return () => {
      stageSelectionRef.current = null;
    };
  }, [showConversation]);

  // The SCOPING KEY — the repo conversations are stamped with and partitioned by.
  //
  // Read from the baseline workspace channel (R3-491), NOT from `stageTree.repo`,
  // even though both are the same string (R-UAA-16). The stamp and the panel's scope
  // have to come from ONE source: they are compared for equality, so the day the two
  // derivations diverge every existing stamp silently stops matching and every
  // conversation lands under "Other repositories" — which is the R3-475 bug, just
  // arrived by a different route. `stageTree` stays what it is actually for: the
  // filesystem root the agent authors.
  const workspaceRepo = useWorkspace()?.label;

  // Readable from the boot effect below without re-running it when the workspace
  // arrives (the effect opens the store ONCE; the fallback simply uses whatever repo
  // is known at that moment — the panel's select corrects it).
  const stageRepoRef = useRef(workspaceRepo);
  useEffect(() => {
    stageRepoRef.current = workspaceRepo;
  }, [workspaceRepo]);

  // Open the store; if no selection arrives, show the newest IN SCOPE (R3-475 —
  // the same repo partition the panel applies) so the stage isn't blank and never
  // seeds itself with another repo's conversation. The arbiter owns which of the
  // held selection / newest fallback wins, so a selection that landed before the
  // store opened is not dropped.
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const store = await openConversationStore();
        if (!live) return;
        storeRef.current = store;
        setStoreError(null);
        await stageSelectionRef.current!.storeOpened(store, stageRepoRef.current);
      } catch (e) {
        // Signed out is the ordinary case; anything else is a real fault the user
        // must see, because it costs them conversation memory.
        if (live) setStoreError(describe(e, NO_STORE_SUFFIX));
      }
    })();
    // R3-631 — open the projection writer on the same mount, independently: a
    // store that fails while the writer opens (or vice versa) degrades exactly one
    // of the two surfaces. The publisher is built here (not during render) so no
    // ref-carrying function reaches a render path.
    projectionRef.current = null;
    publisherRef.current = createProjectionPublisher(
      () => projectionRef.current,
      () => ({ conv: convRef.current, runningId: runningIdRef.current }),
    );
    void openSessionProjectionWriter()
      .then((w) => {
        if (live) {
          projectionRef.current = w;
          // Catch-up: the store's open and the writer's open are independent
          // round-trips — if the stage already showed a conversation while this
          // was in flight, that onShow found no writer and dropped its heartbeat
          // (fail-closed, but the projection should not depend on open order).
          // Re-publishes current state once; per-id running gate; a null conv
          // publishes the harmless explicit-inactive doc.
          publisherRef.current?.onShow();
        }
      })
      .catch((e) => {
        // No projection ⇒ the host never offers a transcript ⇒ fail-closed.
        // Logged-and-dropped (R3): a persistent fault should be visible somewhere.
        console.warn('session projection writer unavailable (transcript offers stay off)', e);
      });
    return () => {
      live = false;
      // Unmount ⇒ explicit inactive doc (best-effort; if the write loses the race
      // with teardown, the host's TTL expires the last heartbeat instead).
      publisherRef.current?.onUnmount();
      publisherRef.current = null;
      projectionRef.current = null;
    };
  }, []);

  // The panel drives which conversation is shown.
  useEffect(() => {
    return onRegionMessage((m) => {
      if (isSelect(m.data)) void stageSelectionRef.current!.select(m.data.id);
    });
  }, []);

  // Ask the panel what it has selected, once, on mount (R3-243).
  //
  // A `select-conversation` can be sent while this region does not exist: on mobile
  // the panel and the stage are different COLUMNS, and an unvisited column renders a
  // skeleton with no iframe — so the tap that reveals this pane is also the tap whose
  // selection had nowhere to land. Without this handshake the fallback above would
  // win and show the newest conversation instead of the tapped one.
  //
  // Subscribed BEFORE the ask (the listener above is already installed by the time
  // this effect runs), so the reply cannot arrive before anyone is listening. If the
  // panel is not there — a stage mounted on its own — nothing answers and the
  // newest-conversation fallback stands, exactly as before.
  useEffect(() => {
    void postToRegion(PANEL_REGION, { type: "request-selection" }).catch(() => {});
  }, []);

  const run = async () => {
    if (!prompt.trim() || running) return;
    // R3-560 (R-ARD-15, the attended gate): an interrupted run on THIS
    // conversation demands a choice first. A fresh kickoff past it would seed
    // history from the stale record, B0-replace the journal's transcript, and
    // fold-reclaim the interrupted tail — completed tool results vanishing from
    // the transcript while their file effects stay, the exact §0 divergence
    // this item exists to remove. Refuse; the affordance is one row above.
    // The interruption check may still be IN FLIGHT (boot replay) — wait for it
    // before deciding, or the gate has a hole exactly one tick wide.
    const convForGate = convRef.current;
    const inflight = replayInFlightRef.current;
    if (convForGate && inflight && inflight.convId === convForGate.id) {
      await inflight.promise;
    }
    const pending = pendingResumeRef.current;
    if (pending && convRef.current && pending.convId === convRef.current.id) {
      append({
        kind: "error",
        text: "This run was interrupted — choose Resume run, or Keep the files and end the run, before starting a new one.",
      });
      return;
    }
    setPendingResume(null);
    // Refuse rather than author the wrong tree: with no conferred stage-app working
    // tree, the agent has no filesystem tools, so a "build me X" prompt would either
    // do nothing or (pre-fix) silently edit the agent's own repo. Tell the user.
    if (!stageTree) {
      append({ kind: "user", text: prompt });
      append({
        kind: "error",
        text: "No app workspace is connected yet. Open an app in the stage (and give it a moment to mount) before asking me to edit it — I won't touch my own files.",
      });
      setPrompt("");
      return;
    }
    const store = storeRef.current;
    // Ensure a conversation exists to attach this run to, stamped with the
    // workspace repo so the panel scopes it correctly (R3-475).
    let conv = convRef.current;
    if (!conv && store) {
      try {
        conv = await store.create(undefined, workspaceRepo);
        convRef.current = conv;
        stageSelectionRef.current!.adopt(conv);
        setTitle(conv.title);
        setStoreError(null);
      } catch (e) {
        // Running ephemerally is a real degradation, not a detail: `history`
        // below falls back to [], so the model sees ONLY this prompt and the
        // conversation appears to have no memory. Say so (R3-247).
        setStoreError(describe(e, NO_STORE_SUFFIX));
      }
    }
    // R3-561 / R-ARD-18: take the advisory run lease before executing anything.
    // A live lease held by another frame means the conversation may be running in
    // a window this one cannot see, and driving one working tree from two loops is
    // what the lease exists to avoid. `held` is an OFFER, never a block — see
    // `leaseHeld` — because the holder may be a frame that no longer exists.
    if (store && conv) {
      try {
        if ((await store.acquireRun(conv.id)) === "held") {
          setLeaseHeld({ convId: conv.id, resume: false });
          return;
        }
      } catch (e) {
        // Wrapped for the same reason `store.create` three lines up is (R3-247): a
        // store call that rejects must not reach the user as an unhandled rejection
        // from a bare `void run()`. A lease we cannot read is not a lease we lost —
        // say the store is degraded and run, rather than refusing on an unknown.
        setStoreError(describe(e, NO_STORE_SUFFIX));
      }
    }
    // R3-559: the checkpoint journal. When the device-local tier is wired, every
    // loop boundary is appended before the loop proceeds past it (B2 intent is
    // durable BEFORE its executor runs — R-ARD-10a); an append that fails or
    // times out unwinds the run AT that boundary with the durability consequence
    // named, and the journal already written stays resumable. Journalless
    // (R-ARD-10): the run is allowed to start, save-at-end only.
    const journal = conv && store?.hasJournal() ? conv : null;
    if (store && conv && !store.hasJournal() && !storeError) {
      setStoreError(
        "Checkpoints are off (no device-local store), so closing this tab loses the run's in-flight turn — the conversation itself still saves when the run ends.",
      );
    }
    const history = conv?.messages ?? [];
    const kickoff = prompt;
    setPrompt("");
    setRunning(true);
    runningIdRef.current = conv?.id ?? null;
    publisherRef.current?.onRunStart(conv?.id ?? null);
    setStreaming("");
    setThinking("");
    setUsage(null);
    append({ kind: "user", text: kickoff });
    const controller = new AbortController();
    abortRef.current = controller;
    const steering = new SteerController();
    steerRef.current = steering;
    setQueued([]);
    const offSteerChange = steering.onChange((pending) => setQueued([...pending]));
    // R3-560 (R-ARD-17): the prompt splits at a cache breakpoint — the PINNED
    // prefix (role, rules, workflow, the date frozen at run start) is stamped
    // into B0 so a resume replays these bytes exactly; the LIVE suffix (tools,
    // skills, workspace root) is rebuilt every time and the cache break at the
    // boundary is accepted, not worked around.
    const pinnedPrefix = buildPinnedPrefix({ today: todayIso() });
    try {
      const transcript = await runAgent({
        client: createChatModelClient(),
        tools: toolset.tools,
        execute: toolset.execute,
        system: composeSystemPrompt(pinnedPrefix, buildLiveSuffix({ tools: toolset.tools, workspaceRoot: stageTree?.root, skills })),
        workspace: workspaceRepo ?? undefined,
        systemPrefix: pinnedPrefix,
        history,
        prompt: kickoff,
        // R3-224 (§3.3): the stop button aborts the loop AND the in-flight LLM turn.
        signal: controller.signal,
        // R3-333: the steering queue — the other verb the human has.
        steering,
        // Token accounting + auto-compaction let the loop run past ~12 turns (R3-220).
        contextWindow: describeChat()?.features.maxContextTokens,
        events: {
          // R3-559: append every boundary to the conversation's journal. The loop
          // awaits this before proceeding — the write's latency IS the
          // intent-before-execute ordering.
          ...(journal
            ? {
                onBoundary: async (b) => {
                  await store!.append(journal.id, b);
                },
              }
            : {}),
          onAssistantDelta: (text) => setStreaming((s) => s + text),
          // R3-335 — the live thinking surface. Now that compaction lets a task run past
          // a dozen turns, the silent stretches are longer, and "is it stuck or
          // thinking?" had no answer on screen.
          onReasoningDelta: (text) => setThinking((t) => t + text),
          onReasoning: (block) => {
            setThinking("");
            append(
              block.redactedData !== undefined
                ? { kind: "reasoning", text: "", redacted: true }
                : { kind: "reasoning", text: block.text },
            );
          },
          onAssistantText: (text) => {
            // A turn an `interrupt` steer cut short is its own row, live and on
            // replay — not a reply the model actually wrote.
            if (text === INTERRUPTED_TURN_TEXT) append({ kind: "interrupted" });
            else if (text.trim()) append({ kind: "text", text });
            setStreaming("");
          },
          onToolUse: (name, input) => append({ kind: "tool", name, input }),
          onToolResult: (name, r) => append({ kind: "result", name, content: r.content, isError: r.isError }),
          onNudge: () => append({ kind: "nudge" }),
          onUsage: (u) =>
            setUsage({
              spentTokens: u.spentTokens,
              cacheReadTokens: u.cacheReadTokens,
              cacheWriteTokens: u.cacheWriteTokens,
            }),
          onCompact: ({ summarizedCount, cacheReadTokens }) => {
            append({
              kind: "compaction",
              // R3-336: the compaction rewrote the conversation prefix, so the next turn
              // re-warms it. The durable system+tools prefix is untouched. Recording the
              // running cache total AT the boundary is what lets the cost curve across a
              // compaction be read rather than assumed.
              summary:
                `${summarizedCount} earlier messages summarized` +
                (cacheReadTokens !== undefined ? ` · ${cacheReadTokens} cached tokens read so far` : ""),
            });
            // R3-559 (R-ARD-9): compaction is a natural fold point — it rewrote the
            // transcript prefix anyway. Best-effort mid-run: a failed fold costs the
            // fold, never the run (the journal retains everything; the run-end fold
            // is the authoritative write), so it is logged-and-dropped, not thrown.
            if (journal) {
              void store!.fold(journal.id).catch((e) => {
                console.warn("mid-run fold at compaction failed (run-end fold still will)", e);
              });
            }
          },
          onSteer: ({ messages }) => {
            for (const m of messages) append({ kind: "steer", mode: m.mode, text: m.text });
          },
        },
      });
      if (conv && store) {
        const newTitle = conv.title === "New conversation" ? deriveTitle(transcript) : conv.title;
        try {
          // R3-559: the run-end save is now a FOLD (R-ARD-9) — the record gets
          // the authoritative transcript (byte-true to what the model saw), the
          // fold watermark, and the carried run-state; the superseded journal
          // entries are reclaimed (R-ARD-5c).
          convRef.current = await store.fold(conv.id, {
            messages: transcript,
            title: newTitle,
            repo: conv.repo ?? workspaceRepo,
          });
          setTitle(newTitle);
          setStoreError(null);
          // R3-631 — the save is the natural heartbeat: messageCount grew.
          publisherRef.current?.onSaved();
          void postToRegion(PANEL_REGION, { type: "conversation-updated", id: conv.id }).catch(() => {});
        } catch (e) {
          // A failed save means `convRef.current` keeps the PRE-run messages, so the
          // next turn re-sends a stale (or empty) history — the same amnesia as a
          // dead store, one turn later. Never silent (R3-247).
          setStoreError(describe(e, NO_STORE_SUFFIX));
        }
      }
    } catch (e) {
      // R3-561: the two lease codes are UX states, not codes to print. Without
      // this branch both reach the user as "this frame does not hold the run
      // lease", which is internal copy naming a mechanism they never saw.
      const c = (e as { code?: string })?.code;
      if (c === "conversation-removed") {
        append({
          kind: "error",
          text: "This conversation was deleted while the run was going, so the run stopped here. The file changes it already made stay.",
        });
      } else if (c === "lease-lost") {
        append({
          kind: "error",
          text: "Another window took over this conversation, so this one stopped rather than driving the same files. Nothing here was lost — reopen it there, or take it back below.",
        });
        setLeaseHeld({ convId: runningIdRef.current ?? convRef.current?.id ?? "", resume: false });
      } else {
        append({ kind: "error", text: (e as Error)?.message ?? String(e) });
      }
      // R3-559 (R-ARD-10a): a failed checkpoint append unwinds the run here. Name
      // the durability consequence — the run stopped AT a boundary and everything
      // checkpointed so far survives (the journal stays resumable).
      if (isJournalRefusal(e)) {
        setStoreError(describe(e, JOURNAL_REFUSAL_SUFFIX));
      }
    } finally {
      offSteerChange();
      steerRef.current = null;
      setQueued([]);
      setSteerText("");
      setStreaming("");
      setThinking("");
      setRunning(false);
      runningIdRef.current = null;
      abortRef.current = null;
      publisherRef.current?.onRunEnd();
      // R3-561: hand the lease back at the end of the run, so a second window is
      // not told to "take over" something that finished. Best-effort by design —
      // the TTL and same-tab reclaim are what actually free a lease, because no
      // unload handler can be relied on to reach this line at all. Fired and NOT
      // awaited for exactly that reason: the whole point is that failing to run it
      // is already the expected case, so making the run's promise wait on a
      // device-local read + unlink with no deadline would buy nothing and could
      // leave it pending — the same argument `APPEND_TIMEOUT_MS` makes one file over.
      {
        const c = convRef.current;
        if (storeRef.current && c) void storeRef.current.releaseRun(c.id).catch(() => {});
      }
    }
  };

  // R3-224 (§3.3): stop the in-flight run — aborts the loop between tool calls AND the
  // in-flight LLM request (the host tears down the upstream provider fetch, stops billing).
  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  // ---- R3-560: the attended-resume choices (R-ARD-15) ------------------------------
  //
  // Booting an interrupted conversation offered three spec'd choices; the third —
  // "discard the tail AND revert the run's writes" — is NOT offered here because
  // the app cannot bound which writes were the run's (the CoW layer is
  // host-side), and a discard that silently keeps the files manufactures exactly
  // the divergence this work exists to remove. The disposition is recorded in
  // AGENT_RUN_DURABILITY_SPEC §5.3; the keep-choice copy says plainly that the
  // file changes stay.

  /** Resume the interrupted run: repair the transcript, name any divergence,
   *  and continue the loop WITHOUT a new prompt turn. */
  const resumeRun = async () => {
    const store = storeRef.current;
    const pending = pendingResume;
    const conv = convRef.current;
    if (!store || !pending || !conv || running || pending.convId !== conv.id) return;
    // The same workspace-readiness gate as a fresh Run: a resume authors files
    // through the conferred stage tree, and without it the loop would run
    // catalog-only or (pre-R3-569) against the wrong tree. Refuse, say why.
    if (!stageTree) {
      append({
        kind: "error",
        text: "No app workspace is connected yet. Open an app in the stage (and give it a moment to mount) before resuming — I won't touch my own files.",
      });
      return;
    }
    // R3-561: same gate as a fresh Run. A reload mid-run is a NEW frame with a new
    // tabId, so same-tab reclaim does not cover it and the dead frame's lease is
    // still live until its TTL — which is exactly the case the takeover offer is
    // for. The host cannot tell a reload from a second tab, and pretending it can
    // would be the double-drive this mechanism exists to prevent.
    try {
      if ((await store.acquireRun(conv.id)) === "held") {
        setLeaseHeld({ convId: conv.id, resume: true });
        return;
      }
    } catch (e) {
      setStoreError(describe(e, NO_STORE_SUFFIX));
    }
    setPendingResume(null);
    const replay = pending.replay;
    const repaired = repairTranscript({
      messages: replay.messages,
      pendingEffects: replay.pendingEffects,
      trailingPartial: replay.trailingPartial,
    });
    // R-ARD-16: say what moved, in the transcript, before the model works. An
    // UNSETTLED workspace channel (undefined) claims nothing — never fabricate
    // a divergence from an unknown.
    const divergence = divergenceMessage(replay.stampedWorkspace, workspaceRepo);
    const resumed = resumedMessages(repaired.messages, divergence);
    setLog(messagesToLog(repaired.messages));
    setRunning(true);
    runningIdRef.current = conv.id;
    publisherRef.current?.onRunStart(conv.id);
    setStreaming("");
    setThinking("");
    append({ kind: "steer", mode: "queue", text: "Run resumed from its last checkpoint" });
    const controller = new AbortController();
    abortRef.current = controller;
    const steeringC = new SteerController();
    steerRef.current = steeringC;
    setQueued([]);
    const offSteerChange = steeringC.onChange((q) => setQueued([...q]));
    // R-ARD-17: the PINNED prefix replays byte-identically from the journal (the
    // frozen date survives midnight); the LIVE suffix is rebuilt from the
    // current catalog — a revoked tool is absent, honestly taking the cache miss.
    const pinnedPrefix = replay.systemPrefix ?? buildPinnedPrefix({ today: todayIso() });
    try {
      const transcript = await runAgent({
        client: createChatModelClient(),
        tools: toolset.tools,
        execute: toolset.execute,
        system: composeSystemPrompt(pinnedPrefix, buildLiveSuffix({ tools: toolset.tools, workspaceRoot: stageTree?.root, skills })),
        workspace: workspaceRepo ?? undefined,
        systemPrefix: pinnedPrefix,
        resume: {
          messages: resumed,
          ...(replay.runState !== null ? { runState: replay.runState as RunState } : {}),
        },
        signal: controller.signal,
        steering: steeringC,
        contextWindow: describeChat()?.features.maxContextTokens,
        events: {
          onBoundary: async (b) => {
            await store.append(conv.id, b);
          },
          onAssistantDelta: (text) => setStreaming((s) => s + text),
          onReasoningDelta: (text) => setThinking((t) => t + text),
          onReasoning: (block) => {
            setThinking("");
            append(
              block.redactedData !== undefined
                ? { kind: "reasoning", text: "", redacted: true }
                : { kind: "reasoning", text: block.text },
            );
          },
          onAssistantText: (text) => {
            if (text === INTERRUPTED_TURN_TEXT) append({ kind: "interrupted" });
            else if (text.trim()) append({ kind: "text", text });
            setStreaming("");
          },
          onToolUse: (name, input) => append({ kind: "tool", name, input }),
          onToolResult: (name, r) => append({ kind: "result", name, content: r.content, isError: r.isError }),
          onNudge: () => append({ kind: "nudge" }),
          onUsage: (u) =>
            setUsage({
              spentTokens: u.spentTokens,
              cacheReadTokens: u.cacheReadTokens,
              cacheWriteTokens: u.cacheWriteTokens,
            }),
          onCompact: ({ summarizedCount }) => {
            append({ kind: "compaction", summary: `${summarizedCount} earlier messages summarized` });
            void store
              .fold(conv.id)
              .catch((e) => console.warn("mid-run fold at compaction failed (run-end fold still will)", e));
          },
          onSteer: ({ messages }) => {
            for (const m of messages) append({ kind: "steer", mode: m.mode, text: m.text });
          },
        },
      });
      try {
        convRef.current = await store.fold(conv.id, {
          messages: transcript,
          repo: conv.repo ?? workspaceRepo,
        });
        setStoreError(null);
        publisherRef.current?.onSaved();
        void postToRegion(PANEL_REGION, { type: "conversation-updated", id: conv.id }).catch(() => {});
      } catch (e) {
        setStoreError(describe(e, NO_STORE_SUFFIX));
      }
    } catch (e) {
      append({ kind: "error", text: (e as Error)?.message ?? String(e) });
      if (isJournalRefusal(e)) {
        setStoreError(describe(e, JOURNAL_REFUSAL_SUFFIX));
      }
    } finally {
      offSteerChange();
      steerRef.current = null;
      setQueued([]);
      setSteerText("");
      setStreaming("");
      setThinking("");
      setRunning(false);
      runningIdRef.current = null;
      abortRef.current = null;
      publisherRef.current?.onRunEnd();
      // R3-561: hand the lease back at the end of the run, so a second window is
      // not told to "take over" something that finished. Best-effort by design —
      // the TTL and same-tab reclaim are what actually free a lease, because no
      // unload handler can be relied on to reach this line at all.
      {
        const c = convRef.current;
        if (storeRef.current && c) await storeRef.current.releaseRun(c.id).catch(() => {});
      }
    }
  };

  /** Keep the files, end the run: fold the repaired transcript so the journal's
   *  watermark advances and the conversation closes cleanly. The FILE CHANGES
   *  STAY — the copy says so (spec §5.3's rev-2 trap). */
  const keepAndClose = async () => {
    const store = storeRef.current;
    const pending = pendingResume;
    const conv = convRef.current;
    if (!store || !pending || !conv || pending.convId !== conv.id) return;
    setPendingResume(null);
    const repaired = repairTranscript({
      messages: pending.replay.messages,
      pendingEffects: pending.replay.pendingEffects,
      trailingPartial: pending.replay.trailingPartial,
    });
    try {
      convRef.current = await store.fold(conv.id, {
        messages: repaired.messages,
        repo: conv.repo ?? workspaceRepo,
      });
      setLog(messagesToLog(repaired.messages));
      setStoreError(null);
      void postToRegion(PANEL_REGION, { type: "conversation-updated", id: conv.id }).catch(() => {});
    } catch (e) {
      setStoreError(describe(e, NO_STORE_SUFFIX));
    }
  };

  // R3-333: the OTHER verb. `queue` applies at the next turn boundary (the in-flight
  // turn finishes); `interrupt` ends the in-flight model turn now and continues with
  // the correction. Neither ends the run — that is what Stop is for.
  const steer = useCallback((mode: SteerMode) => {
    const s = steerRef.current;
    if (!s) return;
    if (s.enqueue(steerText, mode)) setSteerText("");
  }, [steerText]);

  const cancelSteer = useCallback((id: string) => {
    steerRef.current?.cancel(id);
  }, []);

  return (
    <div className="ca ca--stage">
      <header className="ca-hd">
        <span className="ca-title">{title || "Conversation"}</span>
        <span className="ca-sub">
          {toolset.tools.length} tools {stageTree ? "(catalog + files)" : "(catalog only)"}
          {usage && (
            <>
              {" · "}
              {usage.spentTokens.toLocaleString()} tokens
              {/* Shown only when the provider actually reports caching — an absent
                  counter is not a zero, and a "0 cached" badge on a provider that says
                  nothing would be a fabricated measurement. */}
              {usage.cacheReadTokens !== undefined && ` · ${usage.cacheReadTokens.toLocaleString()} cached`}
            </>
          )}
        </span>
      </header>

      {!stageTree && (
        <div className="ca-line ca-error" role="status">
          <span className="ca-err">
            Waiting for the app's workspace to connect… file tools are unavailable until then
            (I won't edit my own files).
          </span>
        </div>
      )}

      {storeError && (
        <div className="ca-line ca-error" role="status">
          <span className="ca-err">{storeError}</span>
        </div>
      )}

      <ul className="ca-log" aria-live="polite" ref={logRef} key={convId ?? "none"}>
        {/* Folded tool calls + markdown replies (R3-473/R3-474) — shared with the
            standalone CodingAgent so both transcripts read identically. */}
        <TranscriptRows log={log} />
        {/* The live streaming row stays PLAIN text (R3-474): re-parsing an
            incomplete markdown document per delta flickers (an unclosed code fence
            swallows the tail); the row swaps to rendered markdown when the turn
            completes into a transcript entry above. */}
        {thinking && (
          <li className="ca-line ca-live">
            {/* Open while it streams — the point is to SHOW that work is happening —
                then collapsed once it becomes a transcript row. */}
            <details className="ca-reasoning" open>
              <summary>
                <span className="ca-thinking-dot" aria-hidden="true" />
                thinking…
              </summary>
              <span className="ca-reasoning-body" ref={reasoningRef}>
                {thinking}
              </span>
            </details>
          </li>
        )}
        {streaming && (
          <li className="ca-line ca-text ca-live">
            <span className="ca-text">{streaming}</span>
          </li>
        )}
      </ul>

      {/* R3-333: what is waiting to be applied, and a way to take it back. A queued
          follow-up the user cannot see or cancel is worse than no queue at all. */}
      {queued.length > 0 && (
        <ul className="ca-queued" aria-label="Queued corrections">
          {queued.map((m) => (
            <li key={m.id} className="ca-queued-item">
              <span className="ca-queued-mode">{m.mode === "interrupt" ? "now" : "next step"}</span>
              <span className="ca-queued-text">{m.text}</span>
              <button
                type="button"
                className="ca-queued-cancel"
                aria-label={`Cancel queued correction: ${m.text}`}
                onClick={() => cancelSteer(m.id)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* R3-560 — the attended-resume affordance (R-ARD-15). Renders the work
          artifact, never a question the user cannot answer; the two offered
          choices are explicit about scope, and the file changes staying is said
          plainly. The third spec'd choice (discard + revert the run's writes) is
          not offered — see the comment above `resumeRun`. */}
      {pendingResume && !running && (
        <div className="ca-line ca-error" role="status">
          <span className="ca-err">
            This run was interrupted after {pendingResume.replay.journalDepth} steps. You can resume it from its last checkpoint — either way, the file changes so far stay.
          </span>
          <div className="ca-resume-row">
            <button type="button" className="ca-run" onClick={() => void resumeRun()}>
              Resume run
            </button>
            <button type="button" className="ca-steer-btn" onClick={() => void keepAndClose()}>
              Keep the files and end the run
            </button>
          </div>
        </div>
      )}

      {/* R3-561 / R-ARD-18a — the lease renders as an OFFER. The copy says "may be",
          not "is", because that is the honest strength of an advisory lease: the
          holder could be a live window, or a frame that was torn down without an
          unload handler and whose lease is simply waiting out its TTL. Taking over
          continues the action that was refused, so the user does not have to ask
          twice. */}
      {leaseHeld && !running && leaseHeld.convId === convId && (
        <div className="ca-line ca-error" role="status">
          <span className="ca-err">
            Another window may be running this conversation. Only one should drive the files at a time — take over if
            that window is gone.
          </span>
          <div className="ca-resume-row">
            <button
              type="button"
              className="ca-run"
              onClick={() => {
                const { resume: wasResume, convId: forConv } = leaseHeld;
                void (async () => {
                  try {
                    const store = storeRef.current;
                    // The offer stays up until the takeover actually lands. An
                    // earlier version dismissed it first, so a rejected write left
                    // the user with no offer, no run and no message.
                    if (store) await store.takeOverRun(forConv);
                    setLeaseHeld(null);
                  } catch (e) {
                    setStoreError(describe(e, NO_STORE_SUFFIX));
                    return;
                  }
                  await (wasResume ? resumeRun() : run());
                })();
              }}
            >
              Take over
            </button>
            <button type="button" className="ca-steer-btn" onClick={() => setLeaseHeld(null)}>
              Leave it alone
            </button>
          </div>
        </div>
      )}

      {/* One row, two modes. Not running: type a prompt and Run. Running: the same
          field STEERS — "Send after this step" queues for the turn boundary, "Send now"
          interrupts the in-flight turn — and Stop still ends the run. The three verbs
          stay visibly distinct (exit 3) and wrap on a phone (value 8). */}
      {running && (
        <p className="ca-steer-hint" role="status">
          {steerText.trim()
            ? "The agent is working. Type here to redirect it."
            : "Type a message to steer"}
        </p>
      )}
      <div className="ca-prompt-row">
        <input
          className="ca-prompt"
          placeholder={
            running
              ? "Steer the agent — say what to do differently…"
              : "Ask the agent to read, search, or edit your app…"
          }
          value={running ? steerText : prompt}
          onChange={(e) => (running ? setSteerText(e.target.value) : setPrompt(e.target.value))}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            if (running) steer("queue");
            else void run();
          }}
          aria-label={running ? "Steer the agent" : "Prompt"}
        />
        {running && (
          <>
            <button
              type="button"
              className="ca-steer-btn"
              disabled={!steerText.trim()}
              onClick={() => steer("queue")}
            >
              Send after this step
            </button>
            <button
              type="button"
              className="ca-steer-btn ca-steer-now"
              disabled={!steerText.trim()}
              onClick={() => steer("interrupt")}
            >
              Send now
            </button>
          </>
        )}
        <button
          type="button"
          className="ca-run"
          // While running, the button becomes a live Stop control (R3-224): it must
          // stay enabled so the user can abort the in-flight turn and stop billing.
          disabled={running ? false : !stageTree}
          title={
            running
              ? "End the run and abort the in-flight request"
              : !stageTree
                ? "Waiting for the app's workspace to connect"
                : undefined
          }
          onClick={() => (running ? stop() : void run())}
        >
          {running ? "Stop" : "Run"}
        </button>
      </div>
    </div>
  );
}

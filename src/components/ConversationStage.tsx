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
  postToRegion,
  onRegionMessage,
  describeChat,
  invokeTask,
} from "@immediately-run/sdk";
import { catalogToolset, mergeToolsets } from "../lib/toolset";
import { createFsToolset, findConferredWorktree } from "../lib/fsTools";
import { createProjectToolset } from "../lib/projectTools";
import { createDiagnosticsToolset } from "../lib/diagnosticsTools";
import { createGitToolset } from "../lib/gitTools";
import { buildSystemPrompt, todayIso } from "../lib/agentPrompt";
import { withSkills } from "../lib/skills";
import { createChatModelClient } from "../lib/chatModelClient";
import { runAgent } from "../lib/agentLoop";
import { SteerController, INTERRUPTED_TURN_TEXT, type SteerMessage, type SteerMode } from "../lib/steering";
import { openConversationStore, deriveTitle, type ConversationStore } from "../lib/conversationStore";
import type { Conversation } from "../lib/conversationModel";
import { messagesToLog, type LogEntry } from "../lib/transcript";
import { PANEL_REGION, isSelect } from "../lib/conversationIpc";
import { describeStoreFailure as describe } from "../lib/storeError";
import "./CodingAgent.css";

export default function ConversationStage() {
  const catalog = useCatalog();
  const mounts = useMounts();
  const storeRef = useRef<ConversationStore | null>(null);
  const convRef = useRef<Conversation | null>(null);
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
  const [title, setTitle] = useState<string>("");
  // Why persistence is unavailable, if it is. The conversation store is not a
  // nice-to-have: `run()` reads the model's HISTORY out of the persisted
  // conversation, so a dead store silently downgrades the agent to a stateless
  // chatbot that re-reads nothing between turns. That failure used to be
  // swallowed by empty `catch {}`s — surface it instead (R3-247).
  const [storeError, setStoreError] = useState<string | null>(null);

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
  const { toolset, skills } = useMemo(() => {
    // No conferred stage tree ⇒ a catalog-only toolset with no authoring tools, so
    // `withSkills` offers nothing and `load_skill` is absent — the authoring skills
    // would be advice the agent cannot act on (R3-331).
    if (!stageTree) return withSkills(catalogToolset(catalog));
    const fsTools = createFsToolset({ root: stageTree.root, readOnly: stageTree.readOnly });
    const projectTools = createProjectToolset({ root: stageTree.root, readOnly: stageTree.readOnly });
    const diagnosticsTools = createDiagnosticsToolset();
    // R3-332: git-READ over the same working tree. Empty (and therefore invisible to
    // the model) unless the app holds `vcs:read`.
    const gitTools = createGitToolset({ catalog });
    // `withSkills` stays LAST (R3-331): which host skills are offered depends on the
    // final merged tool list, so it has to see the git tools too.
    return withSkills(mergeToolsets(catalogToolset(catalog), fsTools, projectTools, diagnosticsTools, gitTools));
  }, [catalog, stageTree]);

  const append = (e: LogEntry) => setLog((l) => [...l, e]);

  const showConversation = useCallback((conv: Conversation) => {
    convRef.current = conv;
    setTitle(conv.title);
    setLog(messagesToLog(conv.messages));
    setStreaming("");
  }, []);

  const loadConversation = useCallback(
    async (id: string) => {
      const store = storeRef.current;
      if (!store) return;
      const conv = await store.load(id);
      if (conv) showConversation(conv);
    },
    [showConversation],
  );

  // Open the store; if no selection arrives, show the newest so the stage isn't blank.
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const store = await openConversationStore();
        if (!live) return;
        storeRef.current = store;
        setStoreError(null);
        if (!convRef.current) {
          const [newest] = await store.list();
          if (newest && live) await loadConversation(newest.id);
        }
      } catch (e) {
        // Signed out is the ordinary case; anything else is a real fault the user
        // must see, because it costs them conversation memory.
        if (live) setStoreError(describe(e, ", so each message is sent without the earlier ones"));
      }
    })();
    return () => {
      live = false;
    };
  }, [loadConversation]);

  // The panel drives which conversation is shown.
  useEffect(() => {
    return onRegionMessage((m) => {
      if (isSelect(m.data)) void loadConversation(m.data.id);
    });
  }, [loadConversation]);

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
    // Ensure a conversation exists to attach this run to.
    let conv = convRef.current;
    if (!conv && store) {
      try {
        conv = await store.create();
        convRef.current = conv;
        setTitle(conv.title);
        setStoreError(null);
      } catch (e) {
        // Running ephemerally is a real degradation, not a detail: `history`
        // below falls back to [], so the model sees ONLY this prompt and the
        // conversation appears to have no memory. Say so (R3-247).
        setStoreError(describe(e, ", so each message is sent without the earlier ones"));
      }
    }
    // The model's memory of earlier turns. Empty whenever the store is
    // unavailable — which is exactly why `storeError` is surfaced above.
    const history = conv?.messages ?? [];
    const kickoff = prompt;
    setPrompt("");
    setRunning(true);
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
    try {
      const transcript = await runAgent({
        client: createChatModelClient(),
        tools: toolset.tools,
        execute: toolset.execute,
        system: buildSystemPrompt({ tools: toolset.tools, skills, workspaceRoot: stageTree?.root, today: todayIso() }),
        history,
        prompt: kickoff,
        // R3-224 (§3.3): the stop button aborts the loop AND the in-flight LLM turn.
        signal: controller.signal,
        // R3-333: the steering queue — the other verb the human has.
        steering,
        // Token accounting + auto-compaction let the loop run past ~12 turns (R3-220).
        contextWindow: describeChat()?.features.maxContextTokens,
        events: {
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
          onCompact: ({ summarizedCount, cacheReadTokens }) =>
            append({
              kind: "compaction",
              // R3-336: the compaction rewrote the conversation prefix, so the next turn
              // re-warms it. The durable system+tools prefix is untouched. Recording the
              // running cache total AT the boundary is what lets the cost curve across a
              // compaction be read rather than assumed.
              summary:
                `${summarizedCount} earlier messages summarized` +
                (cacheReadTokens !== undefined ? ` · ${cacheReadTokens} cached tokens read so far` : ""),
            }),
          onSteer: ({ messages }) => {
            for (const m of messages) append({ kind: "steer", mode: m.mode, text: m.text });
          },
        },
      });
      if (conv && store) {
        const newTitle = conv.title === "New conversation" ? deriveTitle(transcript) : conv.title;
        try {
          convRef.current = await store.save({ ...conv, title: newTitle, messages: transcript });
          setTitle(newTitle);
          setStoreError(null);
          void postToRegion(PANEL_REGION, { type: "conversation-updated", id: conv.id }).catch(() => {});
        } catch (e) {
          // A failed save means `convRef.current` keeps the PRE-run messages, so the
          // next turn re-sends a stale (or empty) history — the same amnesia as a
          // dead store, one turn later. Never silent (R3-247).
          setStoreError(describe(e, ", so each message is sent without the earlier ones"));
        }
      }
    } catch (e) {
      append({ kind: "error", text: (e as Error)?.message ?? String(e) });
    } finally {
      offSteerChange();
      steerRef.current = null;
      setQueued([]);
      setSteerText("");
      setStreaming("");
      setThinking("");
      setRunning(false);
      abortRef.current = null;
    }
  };

  // R3-224 (§3.3): stop the in-flight run — aborts the loop between tool calls AND the
  // in-flight LLM request (the host tears down the upstream provider fetch, stops billing).
  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

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

  // --- R3-43 drill 2: M2 attenuated delegation, live -----------------------------
  // The trigger lives HERE, not in the standalone AgentDemo, because `task:invoke` is
  // conferred by this region's binding — the standalone copy cannot acquire it at all
  // (no consent path for a plain capability yet, R3-233), so a button there could only
  // ever report `forbidden` and would prove nothing about delegation.
  const [probing, setProbing] = useState(false);
  const [probeNote, setProbeNote] = useState<string | null>(null);

  const runProbe = useCallback(async () => {
    setProbing(true);
    setProbeNote(null);
    try {
      const res = await invokeTask<{
        probed: boolean;
        declaredHostOk: boolean;
        declaredDetail: string;
        undeclaredHostOk: boolean;
        undeclaredDetail: string;
      }>("m2-probe", { label: "R3-43 drill 2" });
      // Report the PASS CONDITION, not the payload: the delegated host must be
      // reachable AND the undeclared one must not be. Naming which half failed is the
      // difference between a drill and a shrug.
      const ok = res?.declaredHostOk && !res?.undeclaredHostOk;
      setProbeNote(
        ok
          ? `delegated + attenuated OK — declared ${res.declaredDetail}, undeclared ${res.undeclaredDetail}`
          : `UNEXPECTED — declared ${res?.declaredHostOk ? "reachable" : "blocked"} (${res?.declaredDetail}), undeclared ${res?.undeclaredHostOk ? "REACHABLE, not attenuated" : "blocked"} (${res?.undeclaredDetail})`,
      );
    } catch (e) {
      const code = (e as { code?: string })?.code ?? "error";
      // Carry the MESSAGE too. A bare code sent this drill chasing the wrong layer
      // once already (`invalid-argument` is a Firestore code, not a delegation one),
      // and the message is what says which write failed.
      const detail = (e as { message?: string })?.message ?? "";
      // `consent-required` is the NEGATIVE LEG, not a failure: it is exactly what must
      // happen when this app holds no net:fetch covering the callee's declared host —
      // nothing minted, no overlay opened.
      setProbeNote(
        code === "cancelled"
          ? "cancelled"
          : code === "consent-required"
            ? "consent-required — negative leg: no covering net:fetch on this side, so nothing was minted and no overlay opened"
            : `${code}${detail ? ` — ${detail}` : ""}`,
      );
    } finally {
      setProbing(false);
    }
  }, []);

  return (
    <div className="ca">
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

      <div className="ca-line" role="group">
        <button type="button" onClick={runProbe} disabled={probing}>
          {probing ? "Probing…" : "M2: run the delegation probe"}
        </button>
        {probeNote && <span className="ca-err"> {probeNote}</span>}
      </div>

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

      <ul className="ca-log" aria-live="polite">
        {log.map((e, i) => (
          <li key={i} className={`ca-line ca-${e.kind}`}>
            {e.kind === "user" && <span className="ca-user">{e.text}</span>}
            {e.kind === "text" && <span className="ca-text">{e.text}</span>}
            {e.kind === "tool" && (
              <span>
                → <code>{e.name}</code> <code className="ca-args">{JSON.stringify(e.input)}</code>
              </span>
            )}
            {e.kind === "result" && (
              <span className={e.isError ? "ca-err" : "ca-ok"}>
                <code>{e.name}</code> {e.isError ? "✗" : "✓"} <code className="ca-args">{e.content}</code>
              </span>
            )}
            {e.kind === "error" && <span className="ca-err">{e.text}</span>}
            {e.kind === "nudge" && (
              <span className="ca-nudge">↺ nudging the model to continue…</span>
            )}
            {e.kind === "compaction" && (
              <span className="ca-compaction" title={e.summary}>
                ⚑ compacted earlier turns to stay within the context window
              </span>
            )}
            {e.kind === "steer" && (
              <span className="ca-steer">
                {e.mode === "interrupt" ? "⟂ interrupted and steered:" : "↳ steered:"} {e.text}
              </span>
            )}
            {e.kind === "interrupted" && (
              <span className="ca-interrupted">⟂ turn interrupted by you</span>
            )}
            {e.kind === "reasoning" && (
              <details className="ca-reasoning">
                <summary>{e.redacted ? "thinking (redacted by the provider)" : "thinking"}</summary>
                {!e.redacted && <span className="ca-reasoning-body">{e.text}</span>}
              </details>
            )}
          </li>
        ))}
        {thinking && (
          <li className="ca-line ca-live">
            {/* Open while it streams — the point is to SHOW that work is happening —
                then collapsed once it becomes a transcript row. */}
            <details className="ca-reasoning" open>
              <summary>thinking…</summary>
              <span className="ca-reasoning-body">{thinking}</span>
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

      {/* One row, two modes. Not running: type a prompt and Run. Running: the same
          field STEERS — "Next step" queues for the turn boundary, "Now" interrupts
          the in-flight turn — and Stop still ends the run. The three verbs stay
          visibly distinct (exit 3) and wrap on a phone (value 8). */}
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
              title="Apply this at the next step — the current one finishes first"
              onClick={() => steer("queue")}
            >
              Next step
            </button>
            <button
              type="button"
              className="ca-steer-btn ca-steer-now"
              disabled={!steerText.trim()}
              title="Interrupt the turn in flight and apply this — the run continues"
              onClick={() => steer("interrupt")}
            >
              Now
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

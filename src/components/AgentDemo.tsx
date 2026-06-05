// The embedded-agent demo (§5.5 / §5.9). Shows the app's grant-filtered method
// catalog AS the agent's tool list, lets you "run" a tool through `invoke()`, and
// proves confinement (G12/T23): a method NOT in the catalog — named directly —
// still returns `forbidden` at the host gate. A real LLM agent would be handed
// `useCatalog()` verbatim as its tools; the principle is identical.
import { useState } from "react";
import {
  useCatalog,
  invoke,
  postToRegion,
  invokeTask,
  capFile,
  openAppSpace,
  type ApiMethod,
} from "@immediately-run/sdk";
import "./AgentDemo.css";

// A method we deliberately do NOT hold (this app's grant lacks spaces:admin), to
// show the gate refusing an off-catalog call — the agent can't escape its grant.
const OFF_CATALOG = "spaces:share";

// §5.6 L2 inter-app messaging (T19). This app's binding declares an ipc edge to
// panel.files ONLY (`ipc.to: ["panel.files"]`). Posting there is delivered (the
// file explorer declared it `accepts` us); posting anywhere else is refused at the
// host — the same two-sided-consent confinement the catalog gate shows above.
const FILES_REGION = "panel.files";
const NO_EDGE_REGION = "panel.spaces";

type Result = { kind: "ok"; value: unknown } | { kind: "err"; code: string; message: string };

export default function AgentDemo() {
  const catalog = useCatalog();
  const [log, setLog] = useState<Array<{ name: string; result: Result }>>([]);
  const [running, setRunning] = useState<string | null>(null);

  const run = async (name: string) => {
    setRunning(name);
    try {
      const value = await invoke(name, {});
      setLog((l) => [{ name, result: { kind: "ok", value } }, ...l]);
    } catch (e) {
      const code = (e as { code?: string })?.code ?? "error";
      setLog((l) => [
        { name, result: { kind: "err", code, message: (e as Error)?.message ?? String(e) } },
        ...l,
      ]);
    } finally {
      setRunning(null);
    }
  };

  const inCatalog = (name: string) => catalog.some((m: ApiMethod) => m.name === name);

  // --- inter-app messaging (§5.6) ------------------------------------------
  const [path, setPath] = useState("/README.md");
  const [ipcLog, setIpcLog] = useState<Array<{ to: string; result: Result }>>([]);
  const [posting, setPosting] = useState<string | null>(null);

  // --- task invocation (§5.7): invoke another app, get a typed result back ------
  const [color, setColor] = useState("#3b82f6");
  const [picking, setPicking] = useState(false);
  const [pickNote, setPickNote] = useState<string | null>(null);

  const pickColor = async () => {
    setPicking(true);
    setPickNote(null);
    try {
      const res = await invokeTask<{ color: string }>("pick-color", { initial: color });
      if (res?.color) setColor(res.color);
    } catch (e) {
      const code = (e as { code?: string })?.code ?? "error";
      // `cancelled` is a normal outcome (user dismissed the overlay), not an error.
      setPickNote(code === "cancelled" ? "cancelled" : code);
    } finally {
      setPicking(false);
    }
  };

  // --- file delegation (§5.7/§8.7): hand a callee a file from MY OWN space -------
  const [editing, setEditing] = useState(false);
  const [editNote, setEditNote] = useState<string | null>(null);

  const editFile = async () => {
    setEditing(true);
    setEditNote(null);
    try {
      // Open this app's own workspace (a granted space), then delegate ONE file in
      // it to the bound edit-file app — the host mints an attenuated chroot; this
      // app never sees the editor's code, only the typed { saved } result.
      const space = await openAppSpace();
      const res = await invokeTask<{ saved: boolean }>("edit-file", {
        file: capFile({ mountId: `space:${space.id}`, relPath: "demo.txt" }, { mode: "rw" }),
      });
      setEditNote(res?.saved ? "saved demo.txt to your space ✓" : "done");
    } catch (e) {
      const code = (e as { code?: string })?.code ?? "error";
      setEditNote(
        code === "cancelled"
          ? "cancelled"
          : code === "auth-required"
            ? "sign in to use a space"
            : code,
      );
    } finally {
      setEditing(false);
    }
  };

  const post = async (to: string, data: unknown) => {
    setPosting(to);
    try {
      await postToRegion(to, data);
      setIpcLog((l) => [{ to, result: { kind: "ok", value: "delivered" } }, ...l]);
    } catch (e) {
      const code = (e as { code?: string })?.code ?? "error";
      setIpcLog((l) => [
        { to, result: { kind: "err", code, message: (e as Error)?.message ?? String(e) } },
        ...l,
      ]);
    } finally {
      setPosting(null);
    }
  };

  return (
    <div className="ad">
      <header className="ad-hd">
        <span className="ad-title">Agent tools</span>
        <span className="ad-sub">{catalog.length} in this app's catalog</span>
      </header>

      <ul className="ad-tools">
        {catalog.map((m) => (
          <li key={m.name} className="ad-tool">
            <code className="ad-name">{m.name}</code>
            {m.stream && <span className="ad-badge">stream</span>}
            <button
              type="button"
              className="ad-run"
              disabled={running === m.name || m.stream}
              title={m.stream ? "streaming — use invokeStream" : `requires ${m.capability}`}
              onClick={() => run(m.name)}
            >
              {running === m.name ? "…" : "Run"}
            </button>
          </li>
        ))}
      </ul>

      <div className="ad-escape">
        <p className="ad-escape-h">Confinement check (G12)</p>
        <p className="ad-escape-sub">
          <code>{OFF_CATALOG}</code> is {inCatalog(OFF_CATALOG) ? "in" : "NOT in"} this app's
          catalog. Calling it anyway should be refused by the host gate:
        </p>
        <button type="button" className="ad-run ad-danger" onClick={() => run(OFF_CATALOG)}>
          Try {OFF_CATALOG}
        </button>
      </div>

      <div className="ad-escape">
        <p className="ad-escape-h">Message another panel (§5.6, T19)</p>
        <p className="ad-escape-sub">
          This app declares an <code>ipc</code> edge to <code>{FILES_REGION}</code> only.
          Ask the file explorer to reveal a path — it’ll show the message with a host-attached
          (unspoofable) <code>from</code>:
        </p>
        <div className="ad-ipc-row">
          <input
            className="ad-ipc-input"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            aria-label="Path to reveal"
          />
          <button
            type="button"
            className="ad-run"
            disabled={posting === FILES_REGION}
            onClick={() => post(FILES_REGION, { reveal: path })}
          >
            Reveal in Files
          </button>
        </div>
        <p className="ad-escape-sub">
          Posting to a region this app declared no edge to (<code>{NO_EDGE_REGION}</code>) is
          refused by the host — neither side opened it:
        </p>
        <button
          type="button"
          className="ad-run ad-danger"
          disabled={posting === NO_EDGE_REGION}
          onClick={() => post(NO_EDGE_REGION, { reveal: path })}
        >
          Try messaging {NO_EDGE_REGION}
        </button>

        {ipcLog.length > 0 && (
          <ul className="ad-log">
            {ipcLog.map((e, i) => (
              <li key={i} className={`ad-logline ${e.result.kind}`}>
                <code>{e.to}</code> →{" "}
                {e.result.kind === "ok" ? (
                  <span className="ad-ok">delivered</span>
                ) : (
                  <span className="ad-err">{e.result.code}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="ad-escape">
        <p className="ad-escape-h">Invoke another app (§5.7, task contract)</p>
        <p className="ad-escape-sub">
          A tool can call <code>pick-color</code> and get a typed color back. The host
          loads the user's bound picker in an overlay, the picker returns a value, and
          this app never sees the picker's code or grants — just the result:
        </p>
        <div className="ad-ipc-row">
          <span className="ad-color-chip" style={{ background: color }} aria-label={`color ${color}`} />
          <code className="ad-color-val">{color}</code>
          <button type="button" className="ad-run" disabled={picking} onClick={pickColor}>
            {picking ? "Picking…" : "Pick a color"}
          </button>
        </div>
        {pickNote && (
          <p className="ad-escape-sub">
            invokeTask → <span className="ad-err">{pickNote}</span>
          </p>
        )}
      </div>

      <div className="ad-escape">
        <p className="ad-escape-h">Delegate a file to another app (§5.7/§8.7)</p>
        <p className="ad-escape-sub">
          Hand the <code>edit-file</code> app ONE file from your space. The host mints
          an attenuated, task-scoped chroot — the editor can name nothing else, and a
          read-only delegation is a real <code>EROFS</code> wall. Your grant narrows;
          it never amplifies (G7):
        </p>
        <button type="button" className="ad-run" disabled={editing} onClick={editFile}>
          {editing ? "Editing…" : "Edit demo.txt in my space"}
        </button>
        {editNote && (
          <p className="ad-escape-sub">
            edit-file → <span className="ad-err">{editNote}</span>
          </p>
        )}
      </div>

      {log.length > 0 && (
        <ul className="ad-log">
          {log.map((e, i) => (
            <li key={i} className={`ad-logline ${e.result.kind}`}>
              <code>{e.name}</code> →{" "}
              {e.result.kind === "ok" ? (
                <span className="ad-ok">ok</span>
              ) : (
                <span className="ad-err">{e.result.code}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

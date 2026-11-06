import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  buildCode,
  fileToImage,
  getChat,
  getMeta,
  improvePrompt,
  listChats,
  saveChat,
  stopChat,
  streamChat,
  type Build,
  type ChatEvent,
  type ChatSummary,
  type ImageInput,
  type ModeDef,
} from "./api.ts";
import Viewer, { type ViewMode } from "./Viewer.tsx";
import CodePanel from "./CodePanel.tsx";
import TopBar from "./TopBar.tsx";
import { navigate, replaceUrl } from "./router.ts";

type Part =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; name: string; summary: string }
  | { kind: "build"; version: number; ok?: boolean; error?: string; pending?: boolean }
  | { kind: "error"; message: string }
  | { kind: "meta"; costUsd?: number; ms?: number; turns?: number };

type Msg = { role: "user"; text: string; images: string[]; mode?: string } | { role: "assistant"; parts: Part[] };

const FALLBACK_MODE: ModeDef = {
  id: "free",
  label: "Free",
  blurb: "Anything.",
  placeholder: "A bicycle bell with a spring-loaded striker…",
  starters: ["A desk lamp with a two-segment articulated arm and a tilting shade"],
  options: [],
};

export default function App({ chatId }: { chatId?: string }) {
  const [models, setModels] = useState<string[]>(["claude-opus-5-5"]);
  const [model, setModel] = useState("claude-opus-5-5");
  const [sessionId, setSessionId] = useState<string>();
  const [title, setTitle] = useState<string>("New chat");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [builds, setBuilds] = useState<Build[]>([]);
  const [selected, setSelected] = useState<number>();
  const [viewMode, setViewMode] = useState<ViewMode>("glb");
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState("");
  const [images, setImages] = useState<ImageInput[]>([]);
  const [drag, setDrag] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<ChatSummary[]>();
  const [loadingChat, setLoadingChat] = useState(false);
  const [modes, setModes] = useState<ModeDef[]>([FALLBACK_MODE]);
  const [modeId, setModeId] = useState("free");
  const [optionsByMode, setOptionsByMode] = useState<Record<string, Record<string, string>>>({});
  const [improving, setImproving] = useState(false);
  const [undoText, setUndoText] = useState<string | null>(null);
  const [improveError, setImproveError] = useState<string>();
  const scroller = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const dirty = useRef(false);

  useEffect(() => {
    getMeta()
      .then((m) => {
        setModels(m.models);
        if (m.modes?.length) setModes(m.modes);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [messages]);

  /* ── open the chat named in the URL, or start fresh ── */
  useEffect(() => {
    if (busy) return;
    if (!chatId) {
      setSessionId(undefined);
      setTitle("New chat");
      setMessages([]);
      setBuilds([]);
      setSelected(undefined);
      return;
    }
    if (chatId === sessionId) return;
    let live = true;
    setLoadingChat(true);
    getChat(chatId)
      .then((c) => {
        if (!live) return;
        if (!c) return navigate("/");
        setSessionId(c.id);
        setTitle(c.title);
        setMessages(c.messages as Msg[]);
        setBuilds(c.builds);
        if (c.settings) {
          setModeId(c.settings.mode);
          setOptionsByMode((o) => ({ ...o, [c.settings!.mode]: c.settings!.options }));
        }
        setSelected(undefined);
      })
      .finally(() => live && setLoadingChat(false));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId]);

  /* ── save the display log once a turn settles ── */
  useEffect(() => {
    if (busy || !sessionId || !dirty.current) return;
    dirty.current = false;
    saveChat(sessionId, { messages, settings: { mode: modeId, options: optionsByMode[modeId] ?? {} } }).then(() => {
      if (historyOpen) refreshHistory();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, messages, sessionId]);

  const refreshHistory = () => listChats().then(setHistory);
  useEffect(() => {
    if (historyOpen) refreshHistory();
  }, [historyOpen]);

  const current = builds.find((b) => b.version === selected) ?? builds.at(-1);
  const mode = modes.find((m) => m.id === modeId) ?? modes[0];
  const options = optionsByMode[mode.id] ?? {};
  const setOption = (id: string, value: string) =>
    setOptionsByMode((o) => ({ ...o, [mode.id]: { ...(o[mode.id] ?? {}), [id]: value } }));
  const budget = mode.id === "lowpoly" ? Number((options.budget ?? "").replace(/\D/g, "")) || undefined : undefined;

  const improve = async () => {
    if (improving || busy) return;
    setImproving(true);
    setImproveError(undefined);
    const before = text;
    try {
      const next = await improvePrompt({
        sessionId,
        version: current?.version,
        text,
        mode: mode.id,
        options,
        images,
      });
      if (next) {
        setUndoText(before);
        setText(next);
      }
    } catch (e: any) {
      setImproveError(String(e?.message ?? e));
    } finally {
      setImproving(false);
    }
  };

  const patchAssistant = (fn: (parts: Part[]) => Part[]) =>
    setMessages((ms) => {
      const last = ms.at(-1);
      if (!last || last.role !== "assistant") return [...ms, { role: "assistant", parts: fn([]) }];
      return [...ms.slice(0, -1), { role: "assistant", parts: fn(last.parts) }];
    });

  const appendStream = (kind: "text" | "thinking", delta: string) =>
    patchAssistant((parts) => {
      const last = parts.at(-1);
      if (last && last.kind === kind) return [...parts.slice(0, -1), { ...last, text: last.text + delta }];
      return [...parts, { kind, text: delta }];
    });

  const onEvent = (e: ChatEvent) => {
    switch (e.type) {
      case "session":
        setSessionId(e.id);
        setTitle(e.title);
        if (chatId !== e.id) replaceUrl(`/?chat=${e.id}`);
        break;
      case "text":
      case "thinking":
        appendStream(e.type, e.delta);
        break;
      case "tool":
        if (e.name !== "build_model") patchAssistant((p) => [...p, { kind: "tool", name: e.name, summary: e.summary }]);
        break;
      case "building":
        patchAssistant((p) => [...p, { kind: "build", version: e.version, pending: true }]);
        break;
      case "build":
        setBuilds((bs) => [...bs, e.build]);
        setSelected(e.build.version);
        patchAssistant((p) =>
          p.map((x) =>
            x.kind === "build" && x.version === e.build.version
              ? { ...x, pending: false, ok: e.build.ok, error: e.build.error }
              : x,
          ),
        );
        break;
      case "error":
        patchAssistant((p) => [...p, { kind: "error", message: e.message }]);
        break;
      case "done":
        patchAssistant((p) => [...p, { kind: "meta", costUsd: e.costUsd, ms: e.ms, turns: e.turns }]);
        break;
    }
  };

  const send = async (override?: string) => {
    const t = (override ?? text).trim();
    if ((!t && images.length === 0) || busy) return;
    const imgs = images;
    setHistoryOpen(false);
    setMessages((ms) => [
      ...ms,
      { role: "user", text: t, images: imgs.map((i) => i.url), mode: mode.id === "free" ? undefined : mode.label },
      { role: "assistant", parts: [] },
    ]);
    setText("");
    setUndoText(null);
    setImages([]);
    setBusy(true);
    dirty.current = true;
    try {
      await streamChat({ sessionId, text: t, images: imgs, model, mode: mode.id, options }, onEvent);
    } catch (err: any) {
      patchAssistant((p) => [...p, { kind: "error", message: String(err?.message ?? err) }]);
    } finally {
      setBusy(false);
    }
  };

  const runEdited = async (code: string) => {
    const { sessionId: sid, build } = await buildCode(sessionId, code, { title: sessionId ? undefined : "Hand-written program" });
    if (sid !== sessionId) {
      setSessionId(sid);
      replaceUrl(`/?chat=${sid}`);
    }
    setBuilds((bs) => [...bs, build]);
    setSelected(build.version);
    dirty.current = true;
    setMessages((ms) => [
      ...ms,
      { role: "user", text: `Ran my edit of the program by hand.`, images: [] },
      { role: "assistant", parts: [{ kind: "build", version: build.version, ok: build.ok, error: build.error }] },
    ]);
  };

  const addFiles = async (files: FileList | File[]) => {
    const list = [...files].filter((f) => /^image\/(png|jpeg|gif|webp)$/.test(f.type)).slice(0, 4);
    const imgs = await Promise.all(list.map(fileToImage));
    setImages((cur) => [...cur, ...imgs].slice(0, 4));
  };

  const newChat = () => {
    if (busy) return;
    setHistoryOpen(false);
    navigate("/");
  };

  return (
    <div className="app">
      <TopBar page="playground">
        <label className="select">
          <span>Model</span>
          <select value={model} onChange={(e) => setModel(e.target.value)} disabled={busy}>
            {models.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
        </label>
      </TopBar>

      <main className="grid">
        <aside
          className={drag ? "chat is-drag" : "chat"}
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            addFiles(e.dataTransfer.files);
          }}
        >
          <div className="chatbar">
            <button
              className={historyOpen ? "chatbar-title on" : "chatbar-title"}
              onClick={() => setHistoryOpen((o) => !o)}
              title="Chat history"
            >
              <span>{sessionId ? title : "New chat"}</span>
              <i>{historyOpen ? "▴" : "▾"}</i>
            </button>
            <button className="chatbar-new" onClick={newChat} disabled={busy || (!sessionId && !messages.length)}>
              + New chat
            </button>
          </div>

          {historyOpen ? (
            <div className="history">
              {!history && <div className="history-empty">Loading…</div>}
              {history?.length === 0 && <div className="history-empty">No chats yet.</div>}
              {history?.map((c) => (
                <button
                  key={c.id}
                  className={c.id === sessionId ? "hist on" : "hist"}
                  disabled={busy}
                  onClick={() => {
                    setHistoryOpen(false);
                    navigate(`/?chat=${c.id}`);
                  }}
                >
                  <span className="hist-thumb">{c.thumb ? <img src={c.thumb} alt="" loading="lazy" /> : null}</span>
                  <span className="hist-body">
                    <span className="hist-title">{c.title}</span>
                    <span className="hist-sub">
                      {ago(c.updatedAt)} · {c.builds} build{c.builds === 1 ? "" : "s"}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <div className="chat-scroll" ref={scroller}>
              {loadingChat && <div className="history-empty">Opening chat…</div>}
              {!loadingChat && messages.length === 0 && (
                <div className="intro">
                  <h2>Describe a thing.</h2>
                  <p>
                    Claude writes it as a <b>sand3d</b> program, builds it in Blender, looks at the render, fixes it, and
                    hands you a GLB, a URDF with live joints, and the code. Or start from one of{" "}
                    <a
                      href="/explore"
                      onClick={(e) => {
                        e.preventDefault();
                        navigate("/explore");
                      }}
                    >
                      the collection's objects
                    </a>
                    .
                  </p>
                  <div className="starters">
                    {mode.starters.map((s, i) => (
                      <button key={s} onClick={() => send(s)}>
                        <i>{String(i + 1).padStart(2, "0")}</i>
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {messages.map((m, i) =>
                m.role === "user" ? (
                  <div key={i} className="msg msg-user">
                    <div className="who">
                      you{m.mode && <span className="who-mode">{m.mode}</span>}
                    </div>
                    {m.images.length > 0 && (
                      <div className="msg-imgs">
                        {m.images.map((u, k) => (
                          <img key={k} src={u} alt="" />
                        ))}
                      </div>
                    )}
                    {m.text && <div className="msg-text">{m.text}</div>}
                  </div>
                ) : (
                  <div key={i} className="msg msg-ai">
                    <div className="who">claude</div>
                    {m.parts.length === 0 && busy && i === messages.length - 1 && <div className="blink">▮</div>}
                    {m.parts.map((p, k) => (
                      <PartView key={k} part={p} selected={current?.version} onSelect={(v) => setSelected(v)} />
                    ))}
                  </div>
                ),
              )}
            </div>
          )}

          <form
            className="composer"
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
          >
            <div className="modes" role="tablist" aria-label="Mode">
              {modes.map((m) => (
                <button
                  type="button"
                  key={m.id}
                  role="tab"
                  aria-selected={m.id === mode.id}
                  className={m.id === mode.id ? "mode on" : "mode"}
                  title={m.blurb}
                  onClick={() => setModeId(m.id)}
                >
                  {m.label}
                </button>
              ))}
            </div>
            {mode.options.length > 0 && (
              <div className="mode-opts">
                {mode.options.map((o) => (
                  <label key={o.id} className={options[o.id] ? "opt set" : "opt"}>
                    <span>{o.label}</span>
                    <select value={options[o.id] ?? ""} onChange={(e) => setOption(o.id, e.target.value)}>
                      <option value="">auto</option>
                      {o.choices.map((c) => (
                        <option key={c}>{c}</option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
            )}
            {images.length > 0 && (
              <div className="thumbs">
                {images.map((im, k) => (
                  <button
                    type="button"
                    key={k}
                    className="thumb"
                    title="Remove"
                    onClick={() => setImages((cur) => cur.filter((_, j) => j !== k))}
                  >
                    <img src={im.url} alt="" />
                    <span>✕</span>
                  </button>
                ))}
              </div>
            )}
            <textarea
              value={text}
              placeholder={builds.length ? "Change it: taller, add a drawer, make the lid hinge…" : mode.placeholder}
              onChange={(e) => {
                setText(e.target.value);
                setUndoText(null);
              }}
              onPaste={(e) => {
                if (e.clipboardData.files.length) {
                  e.preventDefault();
                  addFiles(e.clipboardData.files);
                }
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              rows={3}
            />
            <div className="composer-row">
              <button type="button" className="btn btn-ghost" onClick={() => fileInput.current?.click()} disabled={busy}>
                + Image
              </button>
              <input
                ref={fileInput}
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                multiple
                hidden
                onChange={(e) => {
                  if (e.target.files) addFiles(e.target.files);
                  e.target.value = "";
                }}
              />
              <button
                type="button"
                className="btn btn-ghost btn-improve"
                onClick={improve}
                disabled={busy || improving || (!text.trim() && images.length === 0 && !current)}
                title={`Rewrite your draft into a full brief for ${mode.label}, using its settings${current ? " and the current model" : ""}`}
              >
                {improving ? "Improving…" : "✦ Improve"}
              </button>
              {undoText !== null && !improving && (
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => {
                    setText(undoText);
                    setUndoText(null);
                  }}
                >
                  Undo
                </button>
              )}
              <span className="hint">{improveError ? <em className="hint-err">{improveError}</em> : "Enter to send"}</span>
              {busy ? (
                <button type="button" className="btn btn-stop" onClick={() => sessionId && stopChat(sessionId)}>
                  Stop
                </button>
              ) : (
                <button type="submit" className="btn btn-go" disabled={!text.trim() && images.length === 0}>
                  Send
                </button>
              )}
            </div>
          </form>
        </aside>

        <section className="work">
          <div className="workbar">
            <div className="seg">
              <button className={viewMode === "glb" ? "on" : ""} onClick={() => setViewMode("glb")}>
                GLB · three.js
              </button>
              <button className={viewMode === "urdf" ? "on" : ""} onClick={() => setViewMode("urdf")}>
                URDF · joints
              </button>
            </div>
            <div className="versions">
              {builds.map((b) => (
                <button
                  key={b.version}
                  className={[
                    "ver",
                    b.ok ? "" : "ver-bad",
                    b.version === current?.version ? "on" : "",
                    b.author === "user" ? "ver-user" : "",
                  ].join(" ")}
                  title={b.ok ? `${b.author} build` : b.error}
                  onClick={() => setSelected(b.version)}
                >
                  v{b.version}
                </button>
              ))}
            </div>
          </div>
          <Viewer build={current} mode={viewMode} triBudget={budget} />
          <CodePanel build={current} busy={busy} onRun={runEdited} />
        </section>
      </main>
    </div>
  );
}

function ago(t: number) {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function PartView({ part, selected, onSelect }: { part: Part; selected?: number; onSelect: (v: number) => void }) {
  switch (part.kind) {
    case "text":
      return <div className="msg-text">{inlineMd(part.text)}</div>;
    case "thinking":
      return (
        <details className="thinking">
          <summary>thinking</summary>
          <div>{part.text}</div>
        </details>
      );
    case "tool":
      return (
        <div className="toolchip">
          <b>{part.name}</b> {part.summary}
        </div>
      );
    case "build":
      return (
        <button
          className={[
            "buildchip",
            part.pending ? "is-pending" : part.ok ? "is-ok" : "is-bad",
            selected === part.version ? "on" : "",
          ].join(" ")}
          disabled={part.pending}
          onClick={() => onSelect(part.version)}
        >
          <b>build v{part.version}</b>
          <span>{part.pending ? "running blender…" : part.ok ? "ok" : `failed · ${part.error ?? ""}`}</span>
        </button>
      );
    case "error":
      return <div className="errchip">{part.message}</div>;
    case "meta":
      return (
        <div className="metachip">
          {part.turns != null && `${part.turns} turns`}
          {part.ms != null && ` · ${(part.ms / 1000).toFixed(1)}s`}
          {part.costUsd != null && ` · $${part.costUsd.toFixed(3)}`}
        </div>
      );
  }
}

/** Just enough markdown for chat: `code`, **bold**. */
function inlineMd(s: string): ReactNode[] {
  return s
    .trim()
    .split(/(`[^`]+`|\*\*[^*]+\*\*)/g)
    .map((tok, i) =>
      tok.startsWith("`") && tok.endsWith("`") ? (
        <code key={i}>{tok.slice(1, -1)}</code>
      ) : tok.startsWith("**") && tok.endsWith("**") ? (
        <b key={i}>{tok.slice(2, -2)}</b>
      ) : (
        tok
      ),
    );
}

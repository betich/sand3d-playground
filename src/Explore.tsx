import { useEffect, useRef, useState } from "react";
import TopBar from "./TopBar.tsx";
import Viewer, { type ViewMode } from "./Viewer.tsx";
import CodePanel from "./CodePanel.tsx";
import { buildCode, saveChat, type Build } from "./api.ts";
import { COLLECTION_URL, DATASETS, fetchPage, withBuild, type DatasetId, type Item } from "./hf.ts";
import { navigate } from "./router.ts";

const PAGE = 24;

const previewId = (it: Item) => ("x-" + it.id.replace(/[^\w-]/g, "-")).slice(0, 80);

/** A Build-shaped wrapper so CodePanel can show a program before (or without) building it. */
const sourceOnly = (code: string): Build => ({ ok: true, version: 0, author: "user", base: "", files: {}, code, ms: 0, at: 0 });

export default function Explore() {
  const [dataset, setDataset] = useState<DatasetId>("sand3d-articraft");
  const [split, setSplit] = useState<"train" | "validation">("train");
  const [offset, setOffset] = useState(0);
  const [query, setQuery] = useState("");
  const [draftQuery, setDraftQuery] = useState("");
  const [items, setItems] = useState<Item[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  const [selected, setSelected] = useState<Item>();
  const [build, setBuild] = useState<Build>();
  const [building, setBuilding] = useState(false);
  const [mode, setMode] = useState<ViewMode>("glb");
  const [starting, setStarting] = useState(false);
  const buildAbort = useRef<AbortController>(null);

  useEffect(() => {
    const ac = new AbortController();
    setLoading(true);
    setError(undefined);
    fetchPage(dataset, split, offset, PAGE, query, ac.signal)
      .then((p) => {
        setItems(p.items);
        setTotal(p.total);
      })
      .catch((e) => {
        if (ac.signal.aborted) return;
        setItems([]);
        setTotal(0);
        setError(String(e?.message ?? e));
      })
      .finally(() => !ac.signal.aborted && setLoading(false));
    return () => ac.abort();
  }, [dataset, split, offset, query]);

  const open = async (it: Item) => {
    buildAbort.current?.abort();
    const ac = new AbortController();
    buildAbort.current = ac;
    setSelected(it);
    setBuild(undefined);
    setBuilding(true);
    try {
      const { build } = await buildCode(previewId(it), withBuild(it.program, it.entry), { signal: ac.signal });
      if (!ac.signal.aborted) setBuild(build);
    } catch (e: any) {
      if (!ac.signal.aborted) setBuild({ ...sourceOnly(it.program), ok: false, error: String(e?.message ?? e) });
    } finally {
      if (!ac.signal.aborted) setBuilding(false);
    }
  };

  const runEdited = async (code: string) => {
    if (!selected) return;
    const { build } = await buildCode(previewId(selected), code);
    setBuild(build);
  };

  /** New chat seeded with this program (or the hand edit on screen). */
  const startChat = async () => {
    if (!selected) return;
    setStarting(true);
    try {
      const code = build?.code ?? withBuild(selected.program, selected.entry);
      const title = `${selected.family || selected.id}`.replace(/_/g, " ");
      const { sessionId, build: b } = await buildCode(undefined, code, { title, render: true });
      await saveChat(sessionId, {
        title,
        messages: [
          {
            role: "assistant",
            parts: [
              { kind: "text", text: `Loaded \`${selected.id}\` from ${selected.dataset}. Tell me what to change.` },
              { kind: "build", version: b.version, ok: b.ok, error: b.error },
            ],
          },
        ],
      });
      navigate(`/?chat=${sessionId}`);
    } finally {
      setStarting(false);
    }
  };

  const ds = DATASETS.find((d) => d.id === dataset)!;
  const shown = build ?? (selected ? sourceOnly(withBuild(selected.program, selected.entry)) : undefined);

  return (
    <div className="app">
      <TopBar page="collection" />
      <main className="explore">
        <section className="browser">
          <div className="browser-head">
            <div className="dstabs">
              {DATASETS.map((d) => (
                <button
                  key={d.id}
                  className={d.id === dataset ? "on" : ""}
                  onClick={() => {
                    setDataset(d.id);
                    setOffset(0);
                  }}
                >
                  {d.label}
                </button>
              ))}
            </div>
            <form
              className="search"
              onSubmit={(e) => {
                e.preventDefault();
                setOffset(0);
                setQuery(draftQuery);
              }}
            >
              <input value={draftQuery} onChange={(e) => setDraftQuery(e.target.value)} placeholder="Search programs…" />
              {query && (
                <button
                  type="button"
                  onClick={() => {
                    setDraftQuery("");
                    setQuery("");
                    setOffset(0);
                  }}
                >
                  clear
                </button>
              )}
            </form>
          </div>

          <div className="browser-meta">
            <span>
              {ds.blurb}.{" "}
              <a href={`https://huggingface.co/datasets/Sandflow/${dataset}`} target="_blank" rel="noreferrer">
                Dataset ↗
              </a>{" "}
              ·{" "}
              <a href={COLLECTION_URL} target="_blank" rel="noreferrer">
                Collection ↗
              </a>
            </span>
            <span className="pager">
              <select
                value={split}
                onChange={(e) => {
                  setSplit(e.target.value as typeof split);
                  setOffset(0);
                }}
              >
                <option value="train">train</option>
                <option value="validation">validation</option>
              </select>
              {total > 0 && (
                <span>
                  {(offset + 1).toLocaleString()}–{Math.min(offset + PAGE, total).toLocaleString()} of {total.toLocaleString()}
                </span>
              )}
              <button disabled={offset === 0 || loading} onClick={() => setOffset((o) => Math.max(0, o - PAGE))}>
                ←
              </button>
              <button disabled={offset + PAGE >= total || loading} onClick={() => setOffset((o) => o + PAGE)}>
                →
              </button>
            </span>
          </div>

          {error && (
            <div className="browser-error">
              Hugging Face said: {error}
              {query && " (search is sometimes down; clear it to browse)"}
            </div>
          )}

          <div className={loading ? "cards is-loading" : "cards"}>
            {items.map((it) => (
              <button key={it.id} className={selected?.id === it.id ? "card on" : "card"} onClick={() => open(it)}>
                <div className="card-img">{it.render ? <img src={it.render} alt="" loading="lazy" /> : null}</div>
                <div className="card-body">
                  <span className="card-title">{(it.family || it.id).replace(/_/g, " ")}</span>
                  <span className="card-sub">
                    {it.nJoints > 0 ? `${it.nJoints} joint${it.nJoints > 1 ? "s" : ""}` : "rigid"} ·{" "}
                    {it.program.split("\n").length} lines
                  </span>
                </div>
              </button>
            ))}
            {loading && items.length === 0 && Array.from({ length: 8 }, (_, i) => <div key={i} className="card ghost" />)}
          </div>
        </section>

        <section className="work preview">
          <div className="workbar">
            <div className="seg">
              <button className={mode === "glb" ? "on" : ""} onClick={() => setMode("glb")}>
                GLB · three.js
              </button>
              <button className={mode === "urdf" ? "on" : ""} onClick={() => setMode("urdf")}>
                URDF · joints
              </button>
            </div>
            {selected && (
              <button className="btn btn-go workbar-act" onClick={startChat} disabled={starting}>
                {starting ? "Starting…" : "New chat from this →"}
              </button>
            )}
          </div>
          {selected && (
            <div className="preview-meta">
              <b>{selected.id}</b>
              <span>
                {selected.license} · sand3d {selected.version} · {selected.attribution}
              </span>
            </div>
          )}
          <Viewer
            build={build}
            mode={mode}
            poster={selected?.render}
            pending={building ? "building in blender…" : undefined}
          />
          {selected ? (
            <CodePanel build={shown} busy={building} onRun={runEdited} />
          ) : (
            <section className="codepanel">
              <div className="code-empty">Pick an object to see its program here.</div>
            </section>
          )}
        </section>
      </main>
    </div>
  );
}

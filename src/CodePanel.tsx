import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { Build } from "./api.ts";

type Tab = "program" | "urdf" | "usda" | "log";

const PY_KW =
  /\b(def|return|import|as|from|for|in|if|elif|else|while|with|lambda|and|or|not|None|True|False|class|try|except|raise|pass|yield)\b/;

/** Tiny tokenizer: comments, strings, numbers, keywords, s3d.verb calls; XML tags/attrs. */
function highlight(src: string, lang: "py" | "xml" | "usd"): ReactNode[] {
  const rules: [RegExp, string][] =
    lang === "xml"
      ? [
          [/<!--[\s\S]*?-->/, "c"],
          [/"[^"]*"/, "s"],
          [/<\/?[\w:.-]+|\/?>/, "k"],
          [/[\w:-]+(?==)/, "a"],
        ]
      : [
          [/#[^\n]*/, "c"],
          [/"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/, "s"],
          [/\bs3d\.\w+/, "f"],
          [lang === "py" ? PY_KW : /\b(def|over|class|uniform|token|float3|matrix4d|double|int|rel|prepend|references)\b/, "k"],
          [/\b-?\d+(?:\.\d+)?(?:e-?\d+)?\b/, "n"],
        ];
  // inner groups become non-capturing so capture index i always maps to rules[i]
  const big = new RegExp(rules.map(([r]) => `(${r.source.replace(/(?<!\\)\((?!\?)/g, "(?:")})`).join("|"), "g");
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of src.matchAll(big)) {
    if (m.index! > last) out.push(src.slice(last, m.index));
    const g = m.slice(1).findIndex((x) => x !== undefined);
    out.push(
      <span key={key++} className={`tk-${rules[g][1]}`}>
        {m[0]}
      </span>,
    );
    last = m.index! + m[0].length;
  }
  out.push(src.slice(last));
  return out;
}

function Code({ text, lang }: { text: string; lang: "py" | "xml" | "usd" }) {
  const tooBig = text.length > 200_000;
  const body = useMemo(() => (tooBig ? [text] : highlight(text, lang)), [text, lang, tooBig]);
  const lines = text.split("\n").length;
  return (
    <div className="code">
      <pre className="code-gutter" aria-hidden>
        {Array.from({ length: lines }, (_, i) => i + 1).join("\n")}
      </pre>
      <pre className="code-body">{body}</pre>
    </div>
  );
}

export default function CodePanel({
  build,
  busy,
  onRun,
}: {
  build?: Build;
  busy: boolean;
  onRun: (code: string) => Promise<void>;
}) {
  const [tab, setTab] = useState<Tab>("program");
  const [draft, setDraft] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setDraft(null);
    if (build && !build.ok) setTab("log");
    else if (tab === "log") setTab("program");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [build]);

  if (!build) {
    return (
      <section className="codepanel">
        <div className="tabs">
          <span className="tab on">program.py</span>
        </div>
        <div className="code-empty">The sand3d program, its URDF and USDA show up here once something is built.</div>
      </section>
    );
  }

  const text =
    tab === "program"
      ? build.code
      : tab === "urdf"
        ? (build.urdf ?? "")
        : tab === "usda"
          ? (build.usda ?? "")
          : [build.error, build.traceback, build.exportErrors && JSON.stringify(build.exportErrors, null, 2)]
              .filter(Boolean)
              .join("\n\n");

  const copy = async () => {
    await navigator.clipboard.writeText(draft ?? text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  const run = async () => {
    if (draft == null) return;
    setRunning(true);
    try {
      await onRun(draft);
    } finally {
      setRunning(false);
    }
  };

  const f = (k: keyof Build["files"]) => (build.files[k] ? build.base + build.files[k] : undefined);
  const downloads: [string, string | undefined][] = [
    ["GLB", f("glb")],
    ["URDF", f("urdf")],
    ["USDA", f("usda")],
    ["STL", f("stl")],
    ["PY", build.base + "program.py"],
  ];

  return (
    <section className="codepanel">
      <div className="tabs">
        <button className={tab === "program" ? "tab on" : "tab"} onClick={() => setTab("program")}>
          program.py
        </button>
        <button className={tab === "urdf" ? "tab on" : "tab"} onClick={() => setTab("urdf")} disabled={!build.urdf}>
          model.urdf
        </button>
        <button className={tab === "usda" ? "tab on" : "tab"} onClick={() => setTab("usda")} disabled={!build.usda}>
          model.usda
        </button>
        {!build.ok && (
          <button className={tab === "log" ? "tab on tab-err" : "tab tab-err"} onClick={() => setTab("log")}>
            error
          </button>
        )}
        <span className="tabs-fill" />
        {tab === "program" &&
          (draft == null ? (
            <button className="tab-act" onClick={() => setDraft(build.code)} disabled={busy}>
              EDIT
            </button>
          ) : (
            <>
              <button className="tab-act" onClick={() => setDraft(null)}>
                DISCARD
              </button>
              <button className="tab-act tab-run" onClick={run} disabled={running || busy}>
                {running ? "building…" : "run ⌘↵"}
              </button>
            </>
          ))}
        <button className="tab-act" onClick={copy}>
          {copied ? "COPIED" : "COPY"}
        </button>
      </div>

      {tab === "program" && draft != null ? (
        <textarea
          className="code-edit"
          value={draft}
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              run();
            } else if (e.key === "Tab") {
              e.preventDefault();
              const t = e.currentTarget;
              const s = t.selectionStart;
              setDraft(draft.slice(0, s) + "    " + draft.slice(t.selectionEnd));
              requestAnimationFrame(() => t.setSelectionRange(s + 4, s + 4));
            }
          }}
        />
      ) : (
        <Code text={text} lang={tab === "urdf" ? "xml" : tab === "usda" ? "usd" : "py"} />
      )}

      <div className="codepanel-foot">
        <span>
          {!build.base
            ? `source program · ${build.code.split("\n").length} lines`
            : `v${build.version} · ${build.author === "user" ? "hand-built" : "model"} · ${(build.ms / 1000).toFixed(1)}s`}
          {build.stats && ` · ${build.stats.parts} parts · ${build.stats.tris.toLocaleString()} tris`}
        </span>
        <span className="downloads">
          {(build.base ? downloads : []).map(([label, href]) =>
            href ? (
              <a key={label} href={href} download>
                ↓{label}
              </a>
            ) : null,
          )}
        </span>
      </div>
    </section>
  );
}

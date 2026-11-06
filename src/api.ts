export interface Build {
  ok: boolean;
  version: number;
  author: "model" | "user";
  base: string;
  files: Partial<Record<"glb" | "urdf" | "usda" | "stl" | "png", string>>;
  code: string;
  urdf?: string;
  usda?: string;
  stats?: { parts: number; verts: number; tris: number; names: string[]; dims?: number[]; unit?: string };
  error?: string;
  traceback?: string;
  exportErrors?: Record<string, string>;
  renderError?: string;
  ms: number;
  at: number;
}

export type ChatEvent =
  | { type: "session"; id: string; title: string }
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "tool"; id: string; name: string; summary: string }
  | { type: "building"; version: number }
  | { type: "build"; build: Build }
  | { type: "done"; costUsd?: number; ms?: number; turns?: number }
  | { type: "error"; message: string };

export interface ImageInput {
  mediaType: string;
  data: string; // base64, no prefix
  url: string; // data URL for display
}

export async function streamChat(
  body: {
    sessionId?: string;
    text: string;
    images: ImageInput[];
    model: string;
    mode?: string;
    options?: Record<string, string>;
  },
  onEvent: (e: ChatEvent) => void,
) {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...body, images: body.images.map(({ mediaType, data }) => ({ mediaType, data })) }),
  });
  if (!res.ok || !res.body) throw new Error(`chat failed: ${res.status} ${await res.text()}`);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value.replace(/\r\n/g, "\n");
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = chunk
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (data) onEvent(JSON.parse(data));
    }
  }
}

export async function stopChat(sessionId: string) {
  await fetch("/api/stop", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId }) });
}

export async function buildCode(
  sessionId: string | undefined,
  code: string,
  opts: { title?: string; render?: boolean; signal?: AbortSignal } = {},
): Promise<{ sessionId: string; build: Build }> {
  const res = await fetch("/api/build", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, code, title: opts.title, render: opts.render }),
    signal: opts.signal,
  });
  if (!res.ok) throw new Error(`build failed: ${res.status}`);
  return res.json();
}

/* ───────── chats ───────── */

export interface ChatSummary {
  id: string;
  title: string;
  updatedAt: number;
  builds: number;
  thumb?: string;
}

export interface ChatRecord {
  id: string;
  title: string;
  messages: unknown[];
  builds: Build[];
  settings?: Settings;
}

export async function listChats(): Promise<ChatSummary[]> {
  const res = await fetch("/api/chats");
  return res.ok ? res.json() : [];
}

export async function getChat(id: string): Promise<ChatRecord | null> {
  const res = await fetch(`/api/chats/${encodeURIComponent(id)}`);
  return res.ok ? res.json() : null;
}

export async function saveChat(id: string, data: { title?: string; messages?: unknown[]; settings?: Settings }) {
  await fetch(`/api/chats/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
  });
}

export interface ModeDef {
  id: string;
  label: string;
  blurb: string;
  placeholder: string;
  starters: string[];
  options: { id: string; label: string; choices: string[] }[];
}

export type Settings = { mode: string; options: Record<string, string> };

export async function getMeta(): Promise<{ models: string[]; modes: ModeDef[] }> {
  const res = await fetch("/api/meta");
  return res.json();
}

/** Rewrite a draft into a fuller brief for the mode, aware of the chat's current model. */
export async function improvePrompt(body: {
  sessionId?: string;
  version?: number;
  text: string;
  mode: string;
  options: Record<string, string>;
  images: ImageInput[];
}): Promise<string> {
  const res = await fetch("/api/improve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...body, images: body.images.map(({ mediaType, data }) => ({ mediaType, data })) }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `improve failed: ${res.status}`);
  return data.text;
}

export function fileToImage(file: File): Promise<ImageInput> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const url = String(r.result);
      resolve({ mediaType: file.type, data: url.slice(url.indexOf(",") + 1), url });
    };
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

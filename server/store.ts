import { mkdir, readFile, readdir, writeFile, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { RUNS_DIR } from "./build.ts";
import type { Session } from "./agent.ts";

/** Explorer preview builds live under ids with this prefix and never show up as chats. */
export const PREVIEW_PREFIX = "x-";
const ID_RE = /^[\w-]{8,80}$/;

const live = new Map<string, Session>();

const file = (id: string) => path.join(RUNS_DIR, id, "session.json");

export async function getSession(id?: string, title?: string): Promise<Session> {
  if (id && live.has(id)) return live.get(id)!;
  if (id && ID_RE.test(id)) {
    try {
      const s = JSON.parse(await readFile(file(id), "utf8")) as Session;
      live.set(id, s);
      return s;
    } catch {}
  }
  const now = Date.now();
  const s: Session = {
    id: id && ID_RE.test(id) ? id : randomUUID(),
    title: title?.trim() || "Untitled",
    createdAt: now,
    updatedAt: now,
    version: 0,
    builds: [],
    modelSeen: 0,
    messages: [],
  };
  live.set(s.id, s);
  await mkdir(path.join(RUNS_DIR, s.id), { recursive: true });
  return s;
}

export async function saveSession(s: Session) {
  s.updatedAt = Date.now();
  const { abort: _abort, ...data } = s;
  const tmp = file(s.id) + ".tmp";
  await writeFile(tmp, JSON.stringify(data));
  await rename(tmp, file(s.id));
}

export interface ChatSummary {
  id: string;
  title: string;
  updatedAt: number;
  builds: number;
  thumb?: string;
}

export async function listSessions(): Promise<ChatSummary[]> {
  let ids: string[] = [];
  try {
    ids = await readdir(RUNS_DIR);
  } catch {
    return [];
  }
  const out: ChatSummary[] = [];
  for (const id of ids) {
    if (id.startsWith(PREVIEW_PREFIX)) continue;
    const s: Session | null = live.get(id) ?? (await readFile(file(id), "utf8").then(JSON.parse, () => null));
    if (!s) continue;
    const withPng = s.builds.findLast((b) => b.ok && b.files.png);
    out.push({
      id,
      title: s.title ?? "Untitled",
      updatedAt: s.updatedAt ?? 0,
      builds: s.builds.length,
      thumb: withPng ? withPng.base + withPng.files.png : undefined,
    });
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

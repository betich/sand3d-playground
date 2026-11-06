import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { runChat, improvePrompt, MODELS, type ChatEvent } from "./agent.ts";
import { modesForClient } from "./modes.ts";
import { runBuild, ROOT } from "./build.ts";
import { getSession, saveSession, listSessions, PREVIEW_PREFIX } from "./store.ts";
import type { Session } from "./agent.ts";

const app = new Hono();

app.get("/api/meta", (c) => c.json({ models: MODELS, modes: modesForClient() }));

/* ───────── chats ───────── */

app.get("/api/chats", async (c) => c.json(await listSessions()));

app.get("/api/chats/:id", async (c) => {
  const s = await getSession(c.req.param("id"));
  if (s.id !== c.req.param("id")) return c.json({ error: "not found" }, 404);
  return c.json({ id: s.id, title: s.title, messages: s.messages, builds: s.builds, settings: s.settings });
});

/** The client owns the display log; it saves it after each turn. */
app.put("/api/chats/:id", async (c) => {
  const s = await getSession(c.req.param("id"));
  const body = await c.req.json<{ title?: string; messages?: unknown[]; settings?: Session["settings"] }>();
  if (body.title) s.title = body.title.slice(0, 120);
  if (body.settings) s.settings = body.settings;
  if (Array.isArray(body.messages)) s.messages = body.messages;
  await saveSession(s);
  return c.json({ ok: true });
});

app.post("/api/chat", async (c) => {
  const body = await c.req.json<{
    sessionId?: string;
    text: string;
    images?: { mediaType: string; data: string }[];
    model: string;
    mode?: string;
    options?: Record<string, string>;
  }>();
  const s = await getSession(body.sessionId, body.text?.slice(0, 80));
  if (s.abort) return c.json({ error: "busy" }, 409);
  if (s.title === "Untitled" && body.text) s.title = body.text.slice(0, 80);

  return streamSSE(c, async (stream) => {
    const send = (e: ChatEvent | { type: "session"; id: string; title: string }) => stream.writeSSE({ data: JSON.stringify(e) });
    await send({ type: "session", id: s.id, title: s.title });
    const queue: Promise<unknown>[] = [];
    const input = { text: body.text ?? "", images: body.images ?? [], model: body.model, mode: body.mode, options: body.options };
    await runChat(s, input, (e) => {
      queue.push(send(e));
    });
    await saveSession(s);
    await Promise.all(queue);
  });
});

/** Rewrite a draft prompt into a fuller brief for the chosen mode, aware of the chat's current model. */
app.post("/api/improve", async (c) => {
  const body = await c.req.json<{
    sessionId?: string;
    version?: number;
    text: string;
    mode?: string;
    options?: Record<string, string>;
    images?: { mediaType: string; data: string }[];
  }>();
  let current;
  if (body.sessionId) {
    const s = await getSession(body.sessionId);
    const b = s.builds.find((x) => x.version === body.version) ?? s.builds.findLast((x) => x.ok);
    if (b) current = { code: b.code, stats: b.stats };
  }
  try {
    const text = await improvePrompt({ ...body, current });
    return c.json({ text });
  } catch (e: any) {
    return c.json({ error: String(e?.message ?? e) }, 500);
  }
});

app.post("/api/stop", async (c) => {
  const { sessionId } = await c.req.json<{ sessionId: string }>();
  (await getSession(sessionId)).abort?.abort();
  return c.json({ ok: true });
});

/**
 * Build a program without the model: a hand edit, a collection preview
 * (sessionId "x-…", cached by code), or the seed of a new chat (title given).
 */
app.post("/api/build", async (c) => {
  const { sessionId, code, title, render } = await c.req.json<{
    sessionId?: string;
    code: string;
    title?: string;
    render?: boolean;
  }>();
  const s = await getSession(sessionId, title);
  const preview = s.id.startsWith(PREVIEW_PREFIX);
  const cached = preview && s.builds.findLast((b) => b.ok && b.code === code);
  if (cached) return c.json({ sessionId: s.id, build: cached });
  const b = await runBuild(s.id, ++s.version, code, "user", !!render);
  s.builds.push(b);
  await saveSession(s);
  return c.json({ sessionId: s.id, build: b });
});

app.use("/runs/*", serveStatic({ root: path.relative(process.cwd(), ROOT) || "." }));

if (process.env.NODE_ENV === "production") {
  const dist = path.join(ROOT, "dist");
  app.use("/*", serveStatic({ root: path.relative(process.cwd(), dist) || "." }));
  // SPA fallback for /explore etc.
  app.get("*", async (c) => c.html(await readFile(path.join(dist, "index.html"), "utf8")));
}

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, () => console.log(`sand3d playground api on http://localhost:${port}`));

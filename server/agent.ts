import { query, tool, createSdkMcpServer, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { runBuild, describeBuild, RUNS_DIR, type BuildResult } from "./build.ts";
import { SYSTEM_PROMPT } from "./prompt.ts";
import { getMode } from "./modes.ts";

export const MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"] as const;

export interface Session {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** the client's display log, saved as-is so a chat can be reopened */
  messages: unknown[];
  sdkSessionId?: string;
  /** last mode and its options, so a reopened chat picks them up */
  settings?: { mode: string; options: Record<string, string> };
  version: number;
  builds: BuildResult[];
  /** latest version the model has seen (built itself or was told about) */
  modelSeen: number;
  abort?: AbortController;
}

export type ChatEvent =
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "tool"; id: string; name: string; summary: string }
  | { type: "building"; version: number }
  | { type: "build"; build: BuildResult }
  | { type: "done"; costUsd?: number; ms?: number; turns?: number }
  | { type: "error"; message: string };

export interface ChatInput {
  text: string;
  images: { mediaType: string; data: string }[];
  model: string;
  mode?: string;
  options?: Record<string, string>;
}

const ALLOWED_IMAGE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export async function runChat(s: Session, input: ChatInput, emit: (e: ChatEvent) => void) {
  const mode = getMode(input.mode);
  const opts = input.options ?? {};
  s.settings = { mode: mode.id, options: opts };
  const buildTool = tool(
    "build_model",
    "Build a complete sand3d program (a Python module defining build() that returns the root). " +
      "Exports GLB/URDF/USDA/STL to the person's viewer. Returns errors, or stats and a rendered PNG of the result.",
    {
      code: z.string().describe("The full Python program. Must define build()."),
      render: z.boolean().optional().describe("Render a preview image for you to check (default true)."),
    },
    async ({ code, render }) => {
      const version = ++s.version;
      emit({ type: "building", version });
      const b = await runBuild(s.id, version, code, "model", render !== false);
      s.builds.push(b);
      s.modelSeen = version;
      emit({ type: "build", build: b });
      const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [
        { type: "text", text: [describeBuild(b), ...(b.ok && mode.check ? mode.check(b, opts) : [])].join("\n") },
      ];
      if (b.files.png) {
        const png = await readFile(path.join(RUNS_DIR, s.id, `v${version}`, b.files.png));
        content.push({ type: "image", data: png.toString("base64"), mimeType: "image/png" });
      }
      return { content, isError: !b.ok };
    },
  );

  const server = createSdkMcpServer({ name: "sand3d", version: "1.0.0", tools: [buildTool] });

  // Tell the model about hand edits made since it last looked.
  let text = input.text.trim() || "(see the attached image)";
  const latest = s.builds.at(-1);
  if (latest && latest.author === "user" && latest.version > s.modelSeen) {
    text =
      `[The person loaded or edited this program by hand and built it as v${latest.version} ` +
      `(${latest.ok ? "build OK" : "build FAILED: " + latest.error}). Their current program:]\n` +
      "```python\n" + latest.code + "\n```\n\n" + text;
    s.modelSeen = latest.version;
  }

  const content: any[] = input.images
    .filter((im) => ALLOWED_IMAGE.has(im.mediaType))
    .map((im) => ({ type: "image", source: { type: "base64", media_type: im.mediaType, data: im.data } }));
  content.push({ type: "text", text });

  async function* prompt(): AsyncGenerator<SDKUserMessage> {
    yield {
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
      origin: { kind: "human" },
    } as SDKUserMessage;
  }

  s.abort = new AbortController();
  const model = pickModel(input.model);

  try {
    const q = query({
      prompt: prompt(),
      options: {
        model,
        systemPrompt: SYSTEM_PROMPT + (mode.guide(opts) ? "\n\n=== CURRENT MODE ===\n" + mode.guide(opts) : ""),
        cwd: path.join(RUNS_DIR, s.id),
        resume: s.sdkSessionId,
        tools: ["WebSearch", "WebFetch"],
        allowedTools: ["mcp__sand3d__build_model", "WebSearch", "WebFetch"],
        permissionMode: "dontAsk",
        settingSources: [], // isolate from the host's CLAUDE.md, hooks, plugins
        mcpServers: { sand3d: server },
        includePartialMessages: true,
        maxTurns: 30,
        abortController: s.abort,
      },
    });

    for await (const m of q) {
      if ("session_id" in m && m.session_id) s.sdkSessionId = m.session_id;
      switch (m.type) {
        case "stream_event": {
          const ev: any = m.event;
          if (ev.type === "content_block_delta") {
            if (ev.delta.type === "text_delta") emit({ type: "text", delta: ev.delta.text });
            else if (ev.delta.type === "thinking_delta") emit({ type: "thinking", delta: ev.delta.thinking });
          }
          break;
        }
        case "assistant": {
          for (const block of m.message.content as any[]) {
            if (block.type === "tool_use") {
              emit({ type: "tool", id: block.id, name: prettyTool(block.name), summary: summarize(block.name, block.input) });
            }
          }
          break;
        }
        case "result": {
          if (m.subtype !== "success") emit({ type: "error", message: `agent stopped: ${m.subtype}` });
          emit({ type: "done", costUsd: m.total_cost_usd, ms: m.duration_ms, turns: m.num_turns });
          break;
        }
      }
    }
  } catch (err: any) {
    if (s.abort.signal.aborted) emit({ type: "done" });
    else emit({ type: "error", message: String(err?.message ?? err) });
  } finally {
    s.abort = undefined;
  }
}

function prettyTool(name: string) {
  return name.replace(/^mcp__sand3d__/, "");
}

function summarize(name: string, input: any): string {
  if (name.endsWith("build_model")) return `${String(input?.code ?? "").split("\n").length} lines`;
  if (name === "WebSearch") return String(input?.query ?? "");
  if (name === "WebFetch") return String(input?.url ?? "");
  return JSON.stringify(input).slice(0, 80);
}

function pickModel(m?: string) {
  return m && (MODELS as readonly string[]).includes(m) ? m : MODELS[0];
}

const IMPROVE_SYSTEM = `You turn a person's rough request for a 3D object into a clear, complete brief for a modeller who writes sand3d programs (parametric 3D in Python; exports GLB and URDF).

Rules:
- Keep their intent and their words where they are specific. Never change what they asked for.
- Fill every gap the checklist names with a concrete, sensible value, and mark each one you invented with "(assumed)" so they can correct it.
- Use numbers with units. Prefer standard parts and sizes.
- If a current model is given, write the brief as a change to it: what to keep, what to change.
- If images are attached, describe what in them matters (shape, proportions, parts, mechanisms).
- Output only the brief: a one-line summary, then short labelled lines ("Size: …", "Parts: …"). At most 160 words. No preamble, no markdown headings, no code.`;

/** Rewrite a draft prompt into a fuller brief, using the mode's checklist and the chat's current model. */
export async function improvePrompt(input: {
  text: string;
  mode?: string;
  options?: Record<string, string>;
  images?: { mediaType: string; data: string }[];
  current?: { code: string; stats?: BuildResult["stats"] };
  model?: string;
}): Promise<string> {
  const mode = getMode(input.mode);
  const opts = Object.entries(input.options ?? {}).filter(([, v]) => v);
  const ctx = [
    `Mode: ${mode.label} — ${mode.blurb}`,
    `A complete request in this mode covers: ${mode.checklist}.`,
    opts.length ? `Settings chosen: ${opts.map(([k, v]) => `${k} = ${v}`).join(", ")}.` : "",
    input.current
      ? `Current model${input.current.stats?.dims ? ` (size ${input.current.stats.dims.map((d) => +d.toFixed(1)).join(" x ")} ${input.current.stats.unit ?? "mm"}, ${input.current.stats.tris} tris)` : ""}:\n\`\`\`python\n${input.current.code.slice(0, 6000)}\n\`\`\``
      : "There is no model yet: this is the first request.",
    `Their draft:\n${input.text.trim() || "(empty: work from the images)"}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const content: any[] = (input.images ?? [])
    .filter((im) => ALLOWED_IMAGE.has(im.mediaType))
    .map((im) => ({ type: "image", source: { type: "base64", media_type: im.mediaType, data: im.data } }));
  content.push({ type: "text", text: ctx });

  async function* prompt(): AsyncGenerator<SDKUserMessage> {
    yield { type: "user", message: { role: "user", content }, parent_tool_use_id: null, origin: { kind: "human" } } as SDKUserMessage;
  }

  let out = "";
  for await (const m of query({
    prompt: prompt(),
    options: {
      model: input.model && (MODELS as readonly string[]).includes(input.model) ? input.model : "claude-sonnet-5-5",
      systemPrompt: IMPROVE_SYSTEM,
      tools: [],
      allowedTools: [],
      permissionMode: "dontAsk",
      settingSources: [],
      maxTurns: 1,
    },
  })) {
    if (m.type === "result") {
      if (m.subtype !== "success") throw new Error(`improve failed: ${m.subtype}`);
      out = m.result;
    }
  }
  return out.trim();
}

import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";

export const ROOT = path.resolve(import.meta.dirname, "..");
export const RUNS_DIR = path.join(ROOT, "runs");
const PYTHON = path.join(ROOT, "engine", ".venv", "bin", "python");
const RUNNER = path.join(ROOT, "engine", "run.py");
const TIMEOUT_MS = 180_000;

export type BuildFiles = Partial<Record<"glb" | "urdf" | "usda" | "stl" | "png", string>>;

export interface BuildResult {
  ok: boolean;
  version: number;
  author: "model" | "user";
  /** URL base for files, e.g. /runs/<sid>/v3/ */
  base: string;
  files: BuildFiles;
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

/** Run one sand3d program into runs/<sid>/v<version>/. */
export async function runBuild(
  sid: string,
  version: number,
  code: string,
  author: BuildResult["author"],
  render: boolean,
): Promise<BuildResult> {
  const dir = path.join(RUNS_DIR, sid, `v${version}`);
  await mkdir(dir, { recursive: true });
  const program = path.join(dir, "program.py");
  await writeFile(program, code);
  const t0 = Date.now();

  const { stdout, stderr, timedOut } = await spawnCollect(
    PYTHON,
    [RUNNER, program, dir, ...(render ? ["--render"] : [])],
    TIMEOUT_MS,
  );

  const line = stdout.split("\n").find((l) => l.startsWith("RESULT:"));
  const base = `/runs/${sid}/v${version}/`;
  const out: BuildResult = { ok: false, version, author, base, files: {}, code, ms: Date.now() - t0, at: Date.now() };

  if (!line) {
    out.error = timedOut ? `build timed out after ${TIMEOUT_MS / 1000}s` : "runner crashed";
    out.traceback = stderr.split("\n").slice(-30).join("\n");
    return out;
  }
  const r = JSON.parse(line.slice("RESULT:".length));
  out.ok = r.ok;
  out.files = r.files ?? {};
  out.stats = r.stats;
  out.error = r.error;
  out.traceback = r.traceback;
  out.exportErrors = r.export_errors;
  out.renderError = r.render_error;
  if (out.files.urdf) out.urdf = await readFile(path.join(dir, out.files.urdf), "utf8").catch(() => undefined);
  if (out.files.usda) out.usda = await readFile(path.join(dir, out.files.usda), "utf8").catch(() => undefined);
  return out;
}

function spawnCollect(cmd: string, args: string[], timeoutMs: number) {
  return new Promise<{ stdout: string; stderr: string; timedOut: boolean }>((resolve) => {
    const p = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, PYTHONUNBUFFERED: "1" } });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const t = setTimeout(() => {
      timedOut = true;
      p.kill("SIGKILL");
    }, timeoutMs);
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", () => {
      clearTimeout(t);
      resolve({ stdout, stderr, timedOut });
    });
  });
}

/** Short text summary of a build for the model. */
export function describeBuild(b: BuildResult): string {
  if (!b.ok) {
    return [`BUILD v${b.version} FAILED`, b.error ?? "", b.traceback ?? ""].join("\n").trim();
  }
  const lines = [
    `BUILD v${b.version} OK in ${(b.ms / 1000).toFixed(1)}s — exported: ${Object.keys(b.files).join(", ")}`,
  ];
  if (b.stats) {
    lines.push(`${b.stats.parts} mesh parts, ${b.stats.tris} tris. Parts: ${b.stats.names.join(", ")}`);
    if (b.stats.dims) lines.push(`Size: ${b.stats.dims.map((d) => +d.toFixed(2)).join(" x ")} ${b.stats.unit ?? "mm"} (X x Y x Z)`);
  }
  if (b.exportErrors) lines.push(`export errors: ${JSON.stringify(b.exportErrors)}`);
  if (b.renderError) lines.push(`render error: ${b.renderError}`);
  if (b.urdf) {
    const joints = [...b.urdf.matchAll(/<joint name="([^"]+)" type="([^"]+)"/g)].map((m) => `${m[1]}(${m[2]})`);
    lines.push(joints.length ? `URDF joints: ${joints.join(", ")}` : "URDF: no joints (single rigid link tree)");
  }
  return lines.join("\n");
}

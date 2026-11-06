/** The sand3d datasets of the Hugging Face collection Sandflow/sand3d, read through datasets-server. */

export const COLLECTION_URL = "https://huggingface.co/collections/Sandflow/sand3d-6aec268fbdcd3bc174236168";

export const DATASETS = [
  { id: "sand3d-objaverse", label: "Objaverse", blurb: "Everyday objects from Objaverse" },
  { id: "sand3d-cad", label: "CAD", blurb: "Mechanical parts from public CAD models" },
  { id: "sand3d-articraft", label: "Articraft", blurb: "Articulated objects, joints declared" },
  { id: "sand3d-simready", label: "SimReady", blurb: "Simulation-ready assets from NVIDIA SimReady" },
  { id: "sand3d-automate", label: "AutoMate", blurb: "Mechanical assemblies from AutoMate" },
] as const;

export type DatasetId = (typeof DATASETS)[number]["id"];

export interface Item {
  id: string;
  dataset: DatasetId;
  family: string;
  source: string;
  program: string;
  entry: string;
  render?: string;
  nJoints: number;
  license: string;
  attribution: string;
  version: string;
}

export interface Page {
  items: Item[];
  total: number;
}

const BASE = "https://datasets-server.huggingface.co";

function toItem(dataset: DatasetId, r: any): Item {
  return {
    id: r.id,
    dataset,
    family: r.family ?? "",
    source: r.source ?? "",
    program: r.program ?? "",
    entry: r.entry ?? "",
    render: r.render?.src,
    nJoints: r.n_joints ?? 0,
    license: r.license ?? "",
    attribution: r.attribution ?? "",
    version: r.sand3d_version ?? "",
  };
}

async function get(url: string, signal?: AbortSignal) {
  const res = await fetch(url, { signal });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data.error ?? `Hugging Face returned ${res.status}`);
  return data;
}

export async function fetchPage(
  dataset: DatasetId,
  split: "train" | "validation",
  offset: number,
  length: number,
  query: string,
  signal?: AbortSignal,
): Promise<Page> {
  const q = new URLSearchParams({
    dataset: `Sandflow/${dataset}`,
    config: "default",
    split,
    offset: String(offset),
    length: String(length),
  });
  const term = query.trim();
  if (term) q.set("query", term);
  const data = await get(`${BASE}/${term ? "search" : "rows"}?${q}`, signal);
  return { items: data.rows.map((r: any) => toItem(dataset, r.row)), total: data.num_rows_total ?? 0 };
}

/** Dataset programs name their entry function; the playground runner wants build(). */
export function withBuild(program: string, entry: string): string {
  if (/^def build\s*\(/m.test(program) || !entry) return program;
  return `${program.trimEnd()}\n\n\ndef build():\n    return ${entry}()\n`;
}

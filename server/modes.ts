import type { BuildResult } from "./build.ts";

/**
 * A mode frames what the person is making. It adds context to Claude's system
 * prompt, a checklist for the prompt improver, option chips in the UI, and
 * checks run against every build.
 */
export interface ModeOption {
  id: string;
  label: string;
  choices: string[];
}

export interface Mode {
  id: string;
  label: string;
  blurb: string;
  placeholder: string;
  starters: string[];
  options: ModeOption[];
  /** appended to the system prompt for turns in this mode */
  guide: (o: Record<string, string>) => string;
  /** what a complete request in this mode says; drives the prompt improver */
  checklist: string;
  /** extra lines for the model after each build */
  check?: (b: BuildResult, o: Record<string, string>) => string[];
}

export const triBudget = (o: Record<string, string>) => Number((o.budget ?? "").replace(/\D/g, "")) || 0;

export const MODES: Mode[] = [
  {
    id: "free",
    label: "Free",
    blurb: "Anything. No extra rules.",
    placeholder: "A bicycle bell with a spring-loaded striker…",
    starters: [
      "A desk lamp with a two-segment articulated arm and a tilting shade",
      "A front-loading washing machine: hinged door, spinning drum, sliding detergent drawer",
      "A kitchen wall cabinet with two doors and a drawer, oak and brushed steel handles",
    ],
    options: [],
    guide: () => "",
    checklist: "what the object is, its rough size, its main parts, what moves, materials",
  },
  {
    id: "engineering",
    label: "Engineering part",
    blurb: "Dimensioned, manufacturable parts.",
    placeholder: "A wall bracket for a 25 mm tube, two M5 screws…",
    starters: [
      "An L-bracket holding a NEMA 17 stepper to a 2020 aluminium extrusion",
      "A flanged bearing housing for a 608 bearing, three M4 mounting holes on a 40 mm PCD",
      "A cable clip for 6 mm cables that screws down with one M3 countersunk screw",
    ],
    options: [
      { id: "process", label: "Process", choices: ["FDM 3D print", "SLA resin print", "CNC milling", "Sheet metal", "Injection molding"] },
      { id: "material", label: "Material", choices: ["PETG", "PLA", "ABS", "Nylon", "Aluminium 6061", "Steel", "Stainless steel"] },
      { id: "tolerance", label: "Fit", choices: ["General ±0.2", "Fine ±0.05", "Loose ±0.4"] },
    ],
    guide: (o) => `MODE: ENGINEERING PART${o.process ? ` · process ${o.process}` : ""}${o.material ? ` · material ${o.material}` : ""}${o.tolerance ? ` · fit ${o.tolerance}` : ""}
- Work in millimetres. Every dimension that matters is a named parameter at the top of the program (UPPER_CASE constants or keyword defaults), so the person can tweak it.
- Model design intent, not looks: start from the functional faces (mounting faces, bores, mating surfaces), then add material around them.
- Standard hardware: clearance holes ISO medium (M2 2.4, M2.5 2.9, M3 3.4, M4 4.5, M5 5.5, M6 6.6, M8 9), counterbores and countersinks with \`hole(cbore=…/csk=…)\`; heat-set insert holes M3 4.0 x 5 deep; bearings by their real size (608: 22 x 8, bore 8).
- Respect the process: FDM/SLA wall >= 1.6 mm, no unsupported overhangs past 45° where avoidable, chamfer bottom edges instead of filleting them; CNC: inside corners get fillets >= tool radius (3 mm), no undercuts; sheet metal: one uniform thickness, bends with inner radius = thickness; injection molding: uniform walls, 1–2° draft, ribs at 60% of wall.
- Fillet or chamfer exposed edges (0.5–2 mm) unless the process forbids it.
- Use one solid per manufactured part; use \`assembly\` only for multi-part designs, and joints only for real mechanisms.
- Use a realistic material (\`aluminium\`, \`steel\`, \`plastic\`…) and a plain colour.
- In your reply give the overall size (W x D x H) and the key features with their dimensions, and say what you assumed.`,
    checklist:
      "function / what it holds or connects; overall envelope; critical dimensions with numbers; mating parts and fasteners (standard sizes); " +
      "mounting and load direction; manufacturing process; material; fits/tolerances; edge treatment",
    check: (b) => {
      const s = b.stats;
      if (!s?.dims) return [];
      return [`Overall size at rest: ${s.dims.map((d) => +d.toFixed(2)).join(" x ")} ${s.unit ?? "mm"} (X x Y x Z). Check it against the requested dimensions.`];
    },
  },
  {
    id: "lowpoly",
    label: "Low-poly asset",
    blurb: "Game-ready meshes on a triangle budget.",
    placeholder: "A low-poly wooden treasure chest, lid opens…",
    starters: [
      "A low-poly treasure chest with an opening lid, wood and gold trim",
      "A stylised low-poly street lamp for a city builder",
      "A low-poly sci-fi supply crate with a sliding door",
    ],
    options: [
      { id: "budget", label: "Budget", choices: ["500 tris", "1,500 tris", "3,000 tris", "8,000 tris"] },
      { id: "style", label: "Style", choices: ["Flat colours", "Limited palette (4–6)", "Toon / bold", "Realistic proportions"] },
      { id: "target", label: "Target", choices: ["Game engine (glTF)", "Web (three.js)", "VR / mobile"] },
    ],
    guide: (o) => {
      const budget = triBudget(o);
      return `MODE: LOW-POLY ASSET${budget ? ` · budget ${budget} triangles` : ""}${o.style ? ` · style ${o.style}` : ""}${o.target ? ` · target ${o.target}` : ""}
- Stay ${budget ? `under ${budget} triangles in total` : "as light as the shape allows"}: the build reports the count. Build from boxes, wedges, prisms and low-sided shapes: \`polygon(n, d)\` profiles with n = 6–12 instead of circles, \`cylinder\`/\`cone\` only for small parts.
- No \`fillet\`, \`soften\`, \`knurl\`, \`thread\`, \`text\` or dense \`spline\`/\`loft\`: they cost triangles. Suggest bevels with a one-segment \`chamfer\` at most, only on large silhouette edges.
- Silhouette first: exaggerate proportions slightly and keep shapes readable from a distance.
- Colour with flat materials (\`plastic\` or \`painted_metal\`, matte, no metallic shine unless asked), from a small palette; one material per part.
- Real-world scale; the object stands on z = 0, centred, facing -Y (front).
- Parts that animate in a game (lids, doors, wheels, levers) are separate named parts with joints, so the GLB and URDF carry them.
- In your reply give the triangle count against the budget and the palette you used.`;
    },
    checklist: "what it is and its role in the game/scene; triangle budget; art style and colour palette; size; which parts animate and how; engine/target",
    check: (b, o) => {
      const budget = triBudget(o);
      const tris = b.stats?.tris;
      if (!budget || tris == null) return [];
      return tris > budget
        ? [`OVER BUDGET: ${tris} triangles against ${budget}. Simplify: fewer segments, merge small details, drop rounded edges.`]
        : [`Triangle budget OK: ${tris} / ${budget}.`];
    },
  },
  {
    id: "mechanism",
    label: "Mechanism / robot",
    blurb: "Linkages and robots with clean URDF.",
    placeholder: "A 4-DOF desktop robot arm with a parallel gripper…",
    starters: [
      "A 4-DOF desktop robot arm with a parallel gripper, servo-sized joints",
      "A pan-tilt camera mount driven by two micro servos",
      "A two-wheeled differential-drive robot base with a caster",
    ],
    options: [
      { id: "actuation", label: "Actuation", choices: ["Hobby servos", "Stepper / BLDC", "Linear actuators", "Passive / manual"] },
      { id: "target", label: "Target", choices: ["ROS / URDF", "MuJoCo", "Isaac Sim (USD)", "Web demo"] },
    ],
    guide: (o) => `MODE: MECHANISM / ROBOT${o.actuation ? ` · actuation ${o.actuation}` : ""}${o.target ? ` · target ${o.target}` : ""}
- Plan the kinematic tree first: a fixed base, then each link and the joint that carries it. Name parts and joints like a URDF (base, shoulder_link, shoulder_joint…).
- Every joint has a real axis and real limits; continuous only for wheels and spinners. Put each pivot where the physical axle is (\`bbox\`, \`face\`, \`local\`), not at a part's centre.
- Size the actuators: ${o.actuation === "Hobby servos" ? "servo bodies about 40 x 20 x 38 mm (standard) or 23 x 12 x 29 mm (micro), horn on the output shaft" : "show a motor or actuator body at each driven joint"}.
- Keep links clear of each other across the joint ranges; leave 1–2 mm gaps at pivots.
- In your reply list each joint: name, type, axis, range, and which way positive moves it.`,
    checklist: "what it does; degrees of freedom and each joint's range; link lengths / reach; payload; actuators; base mounting; target simulator",
    check: (b) => {
      if (!b.urdf) return [];
      const joints = [...b.urdf.matchAll(/<joint name="([^"]+)" type="([^"]+)">([\s\S]*?)<\/joint>/g)];
      if (!joints.length) return ["No joints in the URDF yet: a mechanism needs them."];
      const fmt = ([, name, type, body]: RegExpMatchArray) => {
        const axis = body.match(/<axis xyz="([^"]+)"/)?.[1] ?? "?";
        const lim = body.match(/<limit lower="([^"]+)" upper="([^"]+)"/);
        const range = !lim
          ? ""
          : type === "prismatic"
            ? ` ${(+lim[1] * 1000).toFixed(0)}..${(+lim[2] * 1000).toFixed(0)} mm`
            : ` ${((+lim[1] * 180) / Math.PI).toFixed(0)}..${((+lim[2] * 180) / Math.PI).toFixed(0)}°`;
        return `${name} ${type} axis(${axis})${range}`;
      };
      return ["Joints: " + joints.map(fmt).join("; ")];
    },
  },
];

export const getMode = (id?: string) => MODES.find((m) => m.id === id) ?? MODES[0];

/** What the client needs to render modes. */
export const modesForClient = () =>
  MODES.map(({ id, label, blurb, placeholder, starters, options }) => ({ id, label, blurb, placeholder, starters, options }));

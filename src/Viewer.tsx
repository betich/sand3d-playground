import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import URDFLoader, { type URDFRobot, type URDFJoint } from "urdf-loader";
import type { Build } from "./api.ts";

export type ViewMode = "glb" | "urdf";

export interface JointInfo {
  name: string;
  type: string;
  min: number;
  max: number;
  value: number;
}

/** Imperative three.js stage. One per mounted viewer. */
class Stage {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(40, 1, 0.001, 1000);
  controls: OrbitControls;
  grid: THREE.GridHelper;
  content = new THREE.Group();
  robot?: URDFRobot;
  private raf = 0;
  private ro: ResizeObserver;
  private token = 0;

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.9;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.appendChild(this.renderer.domElement);

    // a dim environment for reflections, and directional lights for readable form:
    // a key from above-front, a weak fill from the other side, a rim from behind
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.35;
    this.scene.background = new THREE.Color("#f1f1ee");
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(3, 5, 4);
    const fill = new THREE.DirectionalLight(0xdfe6ff, 0.45);
    fill.position.set(-4, 1.5, -1);
    const rim = new THREE.DirectionalLight(0xffffff, 0.6);
    rim.position.set(-1, 3, -5);
    this.scene.add(key, fill, rim, new THREE.HemisphereLight(0xffffff, 0x3a3a38, 0.35));

    this.grid = new THREE.GridHelper(2, 20, 0x9a9a95, 0xdcdcd8);
    this.scene.add(this.grid, this.content);

    this.camera.position.set(0.6, 0.45, 0.6);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.resize();
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    };
    loop();
  }

  resize() {
    const { clientWidth: w, clientHeight: h } = this.host;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  clear() {
    this.token++;
    this.robot = undefined;
    this.content.clear();
  }

  frame(keepView: boolean) {
    const box = new THREE.Box3().setFromObject(this.content);
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(size.length() / 2, 1e-3);
    // sit the grid under the object, scaled to it (grid cells stay powers of ten)
    const step = 10 ** Math.floor(Math.log10(radius * 2));
    const span = Math.ceil((radius * 4) / step) * step;
    this.grid.scale.setScalar(span / 2);
    this.grid.position.set(center.x, box.min.y, center.z);
    this.camera.near = radius / 100;
    this.camera.far = radius * 200;
    this.camera.updateProjectionMatrix();
    if (keepView) return;
    this.controls.target.copy(center);
    const dir = new THREE.Vector3(1, 0.75, 1.15).normalize();
    const dist = (radius / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2))) * 1.05;
    this.camera.position.copy(center).addScaledVector(dir, dist);
  }

  async loadGlb(url: string, keepView: boolean) {
    const t = ++this.token;
    const gltf = await new GLTFLoader().loadAsync(url);
    if (t !== this.token) return;
    this.robot = undefined;
    this.content.clear();
    this.content.add(gltf.scene);
    this.frame(keepView);
  }

  /** Material per part name from the GLB, so the URDF view keeps its colours. */
  private async glbMaterials(url?: string) {
    const map = new Map<string, THREE.Material>();
    if (!url) return map;
    try {
      const gltf = await new GLTFLoader().loadAsync(url);
      gltf.scene.traverse((o: any) => {
        if (o.isMesh) map.set(o.name, o.material);
      });
    } catch {}
    return map;
  }

  async loadUrdf(url: string, glbUrl: string | undefined, keepView: boolean): Promise<JointInfo[]> {
    const t = ++this.token;
    const mats = await this.glbMaterials(glbUrl);
    const fallback = new THREE.MeshStandardMaterial({ color: "#9a968c", roughness: 0.6, metalness: 0.1 });
    const manager = new THREE.LoadingManager();
    const loader = new URDFLoader(manager);
    loader.parseCollision = false;
    loader.loadMeshCb = (path, mgr, _urdfMaterial, done) => {
      new OBJLoader(mgr).load(
        path,
        (obj) => {
          const part = decodeURIComponent(path.split("/").pop()!.replace(/\.obj$/i, ""));
          obj.traverse((o: any) => {
            if (o.isMesh) o.material = mats.get(part) ?? fallback;
          });
          done(obj);
        },
        undefined,
        (err) => done(null as any, err as Error),
      );
    };
    // urdf-loader registers the URDF and every mesh with the manager: onLoad = all done.
    let robot: URDFRobot | undefined;
    await new Promise<void>((resolve, reject) => {
      manager.onLoad = () => resolve();
      loader.load(url, (r) => (robot = r), undefined, reject);
    });
    if (t !== this.token || !robot) return [];
    robot.rotation.x = -Math.PI / 2; // URDF is Z-up, three is Y-up
    this.content.clear();
    this.content.add(robot);
    this.robot = robot;
    this.frame(keepView);
    return Object.values(robot.joints)
      .filter((j: URDFJoint) => j.jointType !== "fixed")
      .map((j: URDFJoint) => {
        const cont = j.jointType === "continuous";
        const min = cont ? -Math.PI : Number(j.limit.lower);
        const max = cont ? Math.PI : Number(j.limit.upper);
        return { name: j.name, type: j.jointType, min, max, value: Number(j.angle ?? 0) };
      });
  }

  setJoint(name: string, value: number) {
    this.robot?.setJointValue(name, value);
  }

  /**
   * Make loaded geometry read well on the light background: parts with no
   * material of their own (glTF's default white) get a mid grey, and every
   * mesh gets dark feature edges, like a CAD view.
   */
  style(root: THREE.Object3D, edges: boolean) {
    const grey = new THREE.MeshStandardMaterial({ color: "#8d8d88", roughness: 0.55, metalness: 0.05 });
    const meshes: THREE.Mesh[] = [];
    root.traverse((o: any) => o.isMesh && meshes.push(o));
    for (const m of meshes) {
      const mats = [m.material].flat() as THREE.MeshStandardMaterial[];
      const isDefault = mats.every((mt) => !mt.name && !mt.map && mt.color?.getHex() === 0xffffff);
      if (isDefault) m.material = grey;
      const lines = new THREE.LineSegments(
        new THREE.EdgesGeometry(m.geometry, 28),
        new THREE.LineBasicMaterial({ color: 0x1a1a1a, transparent: true, opacity: 0.55 }),
      );
      lines.name = "__edges";
      lines.raycast = () => {};
      lines.visible = edges;
      m.add(lines);
    }
  }

  setEdges(on: boolean) {
    this.content.traverse((o) => {
      if (o.name === "__edges") o.visible = on;
    });
  }

  setWire(on: boolean) {
    this.content.traverse((o: any) => {
      if (!o.isMesh) return;
      for (const m of [o.material].flat()) m.wireframe = on;
    });
  }

  snapshot() {
    return this.renderer.domElement.toDataURL("image/png");
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

export default function Viewer({
  build,
  mode,
  poster,
  pending,
  triBudget,
}: {
  build?: Build;
  mode: ViewMode;
  /** image shown until a build arrives (e.g. a dataset render) */
  poster?: string;
  /** label while a build is running */
  pending?: string;
  /** low-poly mode: flag the triangle count against this */
  triBudget?: number;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Stage | null>(null);
  const lastSession = useRef<string>("");
  const [joints, setJoints] = useState<JointInfo[]>([]);
  const [status, setStatus] = useState<string>("");
  const [wire, setWire] = useState(false);
  const [grid, setGrid] = useState(true);
  const [edges, setEdges] = useState(true);
  useEffect(() => stageRef.current?.setEdges(edges), [edges]);

  useEffect(() => {
    const stage = new Stage(hostRef.current!);
    stageRef.current = stage;
    return () => stage.dispose();
  }, []);

  useEffect(() => {
    const stage = stageRef.current!;
    setJoints([]);
    if (!build?.ok) {
      stage.clear();
      return;
    }
    // keep the camera while iterating on the same session's object
    const session = build.base.split("/")[2];
    const keepView = lastSession.current === session && stage.content.children.length > 0;
    lastSession.current = session;
    const glb = build.files.glb ? build.base + build.files.glb : undefined;
    const urdf = build.files.urdf ? build.base + build.files.urdf : undefined;
    setStatus("loading…");
    const job =
      mode === "urdf" && urdf
        ? stage.loadUrdf(urdf, glb, keepView).then(setJoints)
        : glb
          ? stage.loadGlb(glb, keepView)
          : Promise.resolve();
    job
      .then(() => {
        stage.style(stage.content, edges);
        stage.setWire(wire);
        setStatus("");
      })
      .catch((e) => setStatus("load failed: " + String(e?.message ?? e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [build, mode]);

  useEffect(() => stageRef.current?.setWire(wire), [wire]);
  useEffect(() => {
    if (stageRef.current) stageRef.current.grid.visible = grid;
  }, [grid]);

  const snap = () => {
    const a = document.createElement("a");
    a.href = stageRef.current!.snapshot();
    a.download = `sand3d-v${build?.version ?? 0}.png`;
    a.click();
  };

  return (
    <div className="viewer">
      <div className="viewer-canvas" ref={hostRef} />
      {poster && !build?.ok && <img className="viewer-poster" src={poster} alt="" />}
      {!build && !poster && (
        <div className="viewer-empty">
          <span>No model yet</span>
          <small>Describe an object in the chat. Attach a photo if you have one.</small>
        </div>
      )}
      {build && !build.ok && (
        <div className={poster ? "viewer-empty is-error has-poster" : "viewer-empty is-error"}>
          <span>{build.version ? `Build v${build.version} failed` : "Build failed"}</span>
          <small>{build.error}</small>
        </div>
      )}
      {(pending || status) && <div className="viewer-status">{pending || status}</div>}
      {build?.ok && build.stats && (
        <div className="viewer-readout">
          {build.stats.dims && (
            <span>
              {build.stats.dims.map((d) => (d >= 100 ? d.toFixed(0) : +d.toFixed(1))).join(" × ")} {build.stats.unit ?? "mm"}
            </span>
          )}
          <span className={triBudget && build.stats.tris > triBudget ? "over" : ""}>
            {build.stats.tris.toLocaleString()}
            {triBudget ? ` / ${triBudget.toLocaleString()}` : ""} tris
          </span>
        </div>
      )}
      <div className="viewer-tools">
        <button className={wire ? "on" : ""} onClick={() => setWire((w) => !w)}>
          WIRE
        </button>
        <button className={edges ? "on" : ""} onClick={() => setEdges((v) => !v)}>
          edges
        </button>
        <button className={grid ? "on" : ""} onClick={() => setGrid((g) => !g)}>
          GRID
        </button>
        <button onClick={() => stageRef.current?.frame(false)}>FIT</button>
        <button onClick={snap} disabled={!build?.ok}>
          PNG
        </button>
      </div>
      {mode === "urdf" && joints.length > 0 && (
        <div className="joints">
          <div className="joints-head">joints · {joints.length}</div>
          {joints.map((j, i) => (
            <label key={j.name} className="joint">
              <span className="joint-name">
                {j.name}
                <em>{j.type}</em>
              </span>
              <input
                type="range"
                min={j.min}
                max={j.max}
                step={(j.max - j.min) / 400 || 0.001}
                value={j.value}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  stageRef.current?.setJoint(j.name, v);
                  setJoints((js) => js.map((x, k) => (k === i ? { ...x, value: v } : x)));
                }}
              />
              <span className="joint-val">
                {j.type === "prismatic"
                  ? `${(j.value * 1000).toFixed(0)}mm`
                  : `${THREE.MathUtils.radToDeg(j.value).toFixed(0)}°`}
              </span>
            </label>
          ))}
        </div>
      )}
      {mode === "urdf" && build?.ok && joints.length === 0 && !status && (
        <div className="joints joints-none">No moving joints. Ask for some.</div>
      )}
    </div>
  );
}

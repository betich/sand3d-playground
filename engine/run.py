"""Build a sand3d program and export it.

usage: python run.py <program.py> <out_dir> [--render]

The program must define `build()` returning the root object (a solid,
group or assembly). Writes model.glb, urdf/model.urdf (+ meshes),
model.usda, model.stl and, with --render, preview.png. Prints one JSON
line on stdout prefixed with RESULT: .
"""

import json
import os
import runpy
import sys
import traceback


def main() -> int:
    program, out = sys.argv[1], sys.argv[2]
    want_render = "--render" in sys.argv
    os.makedirs(out, exist_ok=True)
    result: dict = {"ok": False, "files": {}}
    try:
        import sand3d as s3d

        s3d.empty_scene()
        ns = runpy.run_path(program, run_name="__sand3d__")
        root = entry_point(ns, program)()
        if root is None:
            raise RuntimeError("build() returned None")

        targets = {
            "glb": "model.glb",
            "urdf": os.path.join("urdf", "model.urdf"),
            "usda": "model.usda",
            "stl": "model.stl",
        }
        for kind, rel in targets.items():
            path = os.path.join(out, rel)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            try:
                s3d.export(root, path)
                result["files"][kind] = rel
            except Exception as e:  # one format failing should not hide the rest
                result.setdefault("export_errors", {})[kind] = f"{type(e).__name__}: {e}"

        result["stats"] = scene_stats()
        if want_render:
            try:
                render(os.path.join(out, "preview.png"))
                result["files"]["png"] = "preview.png"
            except Exception as e:
                result["render_error"] = f"{type(e).__name__}: {e}"
        result["ok"] = "glb" in result["files"]
    except Exception as e:
        tb = traceback.format_exc()
        # keep frames from the user's program + the final error: short for the model
        lines = [l for l in tb.splitlines() if program in l or not l.startswith("  File")]
        result["error"] = f"{type(e).__name__}: {e}"
        result["traceback"] = "\n".join(lines[-25:])
    print("RESULT:" + json.dumps(result), flush=True)
    return 0


def entry_point(ns: dict, program: str):
    """build() if defined, else the last top-level function callable with no arguments."""
    import inspect

    if callable(ns.get("build")):
        return ns["build"]
    fns = [
        f
        for f in ns.values()
        if inspect.isfunction(f)
        and getattr(f.__code__, "co_filename", "") == program
        and all(p.default is not p.empty for p in inspect.signature(f).parameters.values())
    ]
    if not fns:
        # a flat script (e.g. the sand3d-cad dataset): the scene it left behind is the result
        return scene_root
    # the entry point is the one no other function calls (helpers are called by it)
    called = {n for f in ns.values() if inspect.isfunction(f) for n in f.__code__.co_names}
    roots = [f for f in fns if f.__name__ not in called] or fns
    return max(roots, key=lambda f: f.__code__.co_firstlineno)


def scene_root():
    """The top-level objects a flat script left in the scene: one, or a group of them."""
    import bpy
    import sand3d as s3d

    tops = [o for o in bpy.context.scene.objects if o.parent is None and o.type in ("MESH", "EMPTY")]
    if not tops:
        raise RuntimeError("program built nothing: define build() returning the root object")
    return tops[0] if len(tops) == 1 else s3d.group("root", *tops)


def scene_stats() -> dict:
    import bpy

    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    verts = sum(len(o.data.vertices) for o in meshes)
    tris = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in meshes)
    out = {"parts": len(meshes), "verts": verts, "tris": tris, "names": [o.name for o in meshes][:60]}
    if meshes:
        import sand3d as s3d
        from mathutils import Vector

        pts = [o.matrix_world @ Vector(c) for o in meshes for c in o.bound_box]
        size = [max(p[i] for p in pts) - min(p[i] for p in pts) for i in range(3)]
        out["dims"] = [round(v, 3) for v in size]  # X (width), Y (depth), Z (height) at rest
        out["unit"] = s3d.units()
    return out


def render(path: str) -> None:
    """Quick workbench render from a 3/4 view, framed on the scene bounds."""
    import bpy
    from mathutils import Vector

    scene = bpy.context.scene
    meshes = [o for o in scene.objects if o.type == "MESH" and o.visible_get()]
    if not meshes:
        raise RuntimeError("nothing to render")
    pts = [o.matrix_world @ Vector(c) for o in meshes for c in o.bound_box]
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    center, size = (lo + hi) / 2, max((hi - lo).length, 1e-6)

    cam_data = bpy.data.cameras.new("pg_cam")
    cam_data.lens = 50
    cam_data.clip_start = size * 0.001
    cam_data.clip_end = size * 20
    cam = bpy.data.objects.new("pg_cam", cam_data)
    scene.collection.objects.link(cam)
    direction = Vector((1.0, -1.25, 0.85)).normalized()
    cam.location = center + direction * size * 1.55
    cam.rotation_euler = (center - cam.location).to_track_quat("-Z", "Y").to_euler()
    scene.camera = cam

    scene.render.engine = "BLENDER_WORKBENCH"
    shading = scene.display.shading
    shading.light = "STUDIO"
    shading.color_type = "MATERIAL"
    shading.show_cavity = True
    shading.show_object_outline = True
    scene.render.resolution_x = 768
    scene.render.resolution_y = 576
    scene.render.image_settings.file_format = "PNG"
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)


if __name__ == "__main__":
    sys.exit(main())

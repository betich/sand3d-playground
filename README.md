<img src="assets/icon.svg" width="64" height="64" alt="">

# sand3d playground

Chat with Claude to make 3D objects with [sand3d](https://github.com/Sandflow-ai/sand3d).
Claude writes a sand3d program and builds it in Blender (`bpy`). It looks at a render of the result and fixes
what's wrong. You get a three.js GLB preview, a URDF view with a slider per joint, and the raw
program / URDF / USDA under the preview.

## Run

```bash
cd engine && uv sync && cd ..   # Python 3.13 + sand3d + bpy
npm install
npm run dev                     # API on :8787, UI on http://localhost:5173
```

Auth goes through the Claude Agent SDK, which uses your Claude Code login or `ANTHROPIC_API_KEY`.

## How it fits together

- `server/agent.ts`: Agent SDK `query()` with one in-process MCP tool, `build_model(code)`.
  The system prompt carries sand3d's `docs/api.md` and `docs/guidelines.md`. Sessions resume across turns,
  and images you attach go in as image content blocks.
- `engine/run.py`: runs a program's `build()`, exports GLB / URDF / USDA / STL, and renders a
  workbench PNG that goes back to the model so it can check its own work.
- `src/`: React + Vite + three.js, with `urdf-loader` for the joints view.
  You can edit the program by hand and run it without the model. The next chat turn tells Claude about your edit.
- Every build is kept in `runs/<session>/v<n>/`. Each chat is saved to `runs/<session>/session.json`
  and listed under the chat title's ▾ menu, with a link of the form `/?chat=<id>`.
- **Modes** (`server/modes.ts`): Free, Engineering part, Low-poly asset, and Mechanism / robot. Each mode
  adds its own rules to Claude's system prompt, has option chips (process/material, triangle budget/style,
  actuation/target), and runs checks after each build (overall size, triangles against the budget, joint list).
  **✦ Improve** rewrites your draft into a full brief using the mode, its options, attached images and
  the current model. Anything it guessed is marked "(assumed)".
- `/explore` browses the [sand3d collection](https://huggingface.co/collections/Sandflow/sand3d-6aec268fbdcd3bc174236168)
  (Objaverse, CAD, Articraft, SimReady, AutoMate) through HF datasets-server. Clicking an object builds its
  program locally and shows the code under the preview, and *New chat from this* starts a chat from it.

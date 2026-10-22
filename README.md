# Mirror Maze

A walkable mirror maze in the browser and in VR, built with [A-Frame](https://aframe.io) 1.7.1.
The maze and avatar were modelled in Blender and exported as glTF (`models/`).

**Controls**
- Desktop: click to look around, **W A S D** to walk, **Esc** to release the mouse.
- VR headset: press **VR** (bottom right), left stick to walk, right stick to snap-turn.

## How the live mirrors work

- Mirror walls are found automatically: any material with metalness ≥ 0.9 and roughness ≤ 0.1.
  Coplanar mirror triangles are grouped into "mirror planes" (about 330 in this maze).
- Rendering all of them live would be far too slow, so a small pool of live mirrors
  (`js/reflector.js`, adapted from three.js's `Reflector`) is shared: each frame a few rays
  are cast through the view, and the pool goes to the mirror planes that cover the most
  of the screen (then the nearest ones). Desktop uses 4 live mirrors, VR uses 2.
- Other mirror walls still look like polished metal (environment map).
- The avatar is on its own render layer: your camera doesn't draw it, but the mirrors do,
  so you see yourself only in reflections.

Settings are attributes on `<a-scene>` in `index.html`, e.g.
`mirror-maze="pool: 4; vrPool: 2; resolution: 0.75"`.

## Run locally

```
python -m http.server 8000
```
then open http://localhost:8000 (opening `index.html` directly from disk won't load the models).

## Updating the models

Re-export from Blender with File → Export → glTF 2.0 (.glb), "Selected Objects" and
"Apply Modifiers" on, and replace the files in `models/`.

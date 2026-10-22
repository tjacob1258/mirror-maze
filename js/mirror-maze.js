/*
 * Mirror maze components for A-Frame 1.7
 *
 *  mirror-maze   (on <a-scene>)  live mirrors on the maze's mirror walls
 *  walk-avatar   (on the avatar) follows you; hidden from you, visible in mirrors
 *  wall-collide  (on the camera) stops you walking through walls (desktop)
 *  stick-walk    (on a VR controller) thumbstick walking + snap turn in VR
 *
 * How the mirrors work (same idea as the Blender version):
 *  - Every triangle whose material looks like a mirror (metalness >= 0.9,
 *    roughness <= 0.1) is grouped with coplanar triangles into a "mirror plane".
 *  - A small pool of Reflectors (live planar mirrors) is shared between them.
 *    A grid of rays through your view counts how much of the screen each mirror
 *    plane covers; the pool goes to the most visible ones, then the nearest.
 *  - Mirrors without a Reflector still look like polished metal (environment map),
 *    you just can't see the avatar in them.
 */
(function () {
  const THREE = AFRAME.THREE;
  const AVATAR_LAYER = 3; // 1 and 2 are used by WebXR for the left/right eye
  const MIRROR_LAYER = 4;

  const isMirrorMaterial = (m) =>
    m && m.metalness !== undefined && m.metalness >= 0.9 && m.roughness <= 0.1;

  // Triangle grid ----------------------------------------------------------
  // The maze is mostly vertical walls, so bucketing triangles into 1 m columns
  // on the ground plane makes each ray test only the walls it passes near.
  class TriGrid {
    constructor(meshes, cell = 1.0) {
      const tris = [], mirror = [];
      const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
      for (const mesh of meshes) {
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        const g = mesh.geometry, p = g.attributes.position, idx = g.index;
        const groups = g.groups.length ? g.groups
          : [{ start: 0, count: idx ? idx.count : p.count, materialIndex: 0 }];
        for (const grp of groups) {
          const isM = isMirrorMaterial(mats[grp.materialIndex] || mats[0]);
          for (let k = grp.start; k < grp.start + grp.count; k += 3) {
            const i0 = idx ? idx.getX(k) : k, i1 = idx ? idx.getX(k + 1) : k + 1,
              i2 = idx ? idx.getX(k + 2) : k + 2;
            a.fromBufferAttribute(p, i0).applyMatrix4(mesh.matrixWorld);
            b.fromBufferAttribute(p, i1).applyMatrix4(mesh.matrixWorld);
            c.fromBufferAttribute(p, i2).applyMatrix4(mesh.matrixWorld);
            tris.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
            mirror.push(isM ? 1 : 0);
          }
        }
      }
      this.tris = new Float32Array(tris);
      this.mirror = new Uint8Array(mirror);
      this.count = mirror.length;
      this.normals = new Float32Array(this.count * 3);
      let minx = Infinity, minz = Infinity, maxx = -Infinity, maxz = -Infinity;
      const T = this.tris;
      for (let t = 0; t < this.count; t++) {
        const o = t * 9;
        for (let v = 0; v < 3; v++) {
          minx = Math.min(minx, T[o + 3 * v]); maxx = Math.max(maxx, T[o + 3 * v]);
          minz = Math.min(minz, T[o + 3 * v + 2]); maxz = Math.max(maxz, T[o + 3 * v + 2]);
        }
        a.set(T[o], T[o + 1], T[o + 2]); b.set(T[o + 3], T[o + 4], T[o + 5]);
        c.set(T[o + 6], T[o + 7], T[o + 8]);
        const n = b.sub(a).cross(c.sub(a)).normalize();
        this.normals[3 * t] = n.x; this.normals[3 * t + 1] = n.y; this.normals[3 * t + 2] = n.z;
      }
      this.cell = cell;
      this.minx = minx - 1e-3; this.minz = minz - 1e-3;
      this.nx = Math.max(1, Math.ceil((maxx - this.minx) / cell) + 1);
      this.nz = Math.max(1, Math.ceil((maxz - this.minz) / cell) + 1);
      const buckets = Array.from({ length: this.nx * this.nz }, () => []);
      for (let t = 0; t < this.count; t++) {
        const o = t * 9;
        const x0 = Math.min(T[o], T[o + 3], T[o + 6]), x1 = Math.max(T[o], T[o + 3], T[o + 6]);
        const z0 = Math.min(T[o + 2], T[o + 5], T[o + 8]), z1 = Math.max(T[o + 2], T[o + 5], T[o + 8]);
        const cx0 = this.cx(x0), cx1 = this.cx(x1), cz0 = this.cz(z0), cz1 = this.cz(z1);
        for (let i = cx0; i <= cx1; i++) for (let j = cz0; j <= cz1; j++) buckets[j * this.nx + i].push(t);
      }
      this.buckets = buckets.map((l) => Int32Array.from(l));
      this.stamp = new Uint32Array(this.count);
      this.ray = 0;
    }
    cx(x) { return Math.min(this.nx - 1, Math.max(0, Math.floor((x - this.minx) / this.cell))); }
    cz(z) { return Math.min(this.nz - 1, Math.max(0, Math.floor((z - this.minz) / this.cell))); }

    // Moller-Trumbore, double sided. Returns distance or Infinity.
    hitTri(t, ox, oy, oz, dx, dy, dz) {
      const T = this.tris, o = t * 9;
      const e1x = T[o + 3] - T[o], e1y = T[o + 4] - T[o + 1], e1z = T[o + 5] - T[o + 2];
      const e2x = T[o + 6] - T[o], e2y = T[o + 7] - T[o + 1], e2z = T[o + 8] - T[o + 2];
      const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (Math.abs(det) < 1e-12) return Infinity;
      const inv = 1 / det;
      const sx = ox - T[o], sy = oy - T[o + 1], sz = oz - T[o + 2];
      const u = (sx * px + sy * py + sz * pz) * inv;
      if (u < 0 || u > 1) return Infinity;
      const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
      const v = (dx * qx + dy * qy + dz * qz) * inv;
      if (v < 0 || u + v > 1) return Infinity;
      const d = (e2x * qx + e2y * qy + e2z * qz) * inv;
      return d > 1e-6 ? d : Infinity;
    }

    // Nearest hit along a normalised ray: {t, tri} or null. Walks the grid (2D DDA).
    raycast(o, d, far) {
      const stamp = ++this.ray;
      let best = far, bestTri = -1;
      const test = (cellIndex) => {
        const list = this.buckets[cellIndex];
        for (let k = 0; k < list.length; k++) {
          const t = list[k];
          if (this.stamp[t] === stamp) continue;
          this.stamp[t] = stamp;
          const h = this.hitTri(t, o.x, o.y, o.z, d.x, d.y, d.z);
          if (h < best) { best = h; bestTri = t; }
        }
      };
      let ix = this.cx(o.x), iz = this.cz(o.z);
      const hlen = Math.hypot(d.x, d.z);
      if (hlen < 1e-6) { test(iz * this.nx + ix); return bestTri < 0 ? null : { t: best, tri: bestTri }; }
      const stepX = d.x > 0 ? 1 : -1, stepZ = d.z > 0 ? 1 : -1;
      const nextX = this.minx + (ix + (stepX > 0 ? 1 : 0)) * this.cell;
      const nextZ = this.minz + (iz + (stepZ > 0 ? 1 : 0)) * this.cell;
      let tMaxX = Math.abs(d.x) > 1e-9 ? (nextX - o.x) / d.x : Infinity;
      let tMaxZ = Math.abs(d.z) > 1e-9 ? (nextZ - o.z) / d.z : Infinity;
      const tDX = Math.abs(d.x) > 1e-9 ? this.cell / Math.abs(d.x) : Infinity;
      const tDZ = Math.abs(d.z) > 1e-9 ? this.cell / Math.abs(d.z) : Infinity;
      let tCell = 0;
      while (tCell <= best) {
        if (ix >= 0 && iz >= 0 && ix < this.nx && iz < this.nz) test(iz * this.nx + ix);
        else if ((stepX > 0 && ix >= this.nx) || (stepX < 0 && ix < 0) ||
                 (stepZ > 0 && iz >= this.nz) || (stepZ < 0 && iz < 0)) break;
        if (tMaxX < tMaxZ) { tCell = tMaxX; tMaxX += tDX; ix += stepX; }
        else { tCell = tMaxZ; tMaxZ += tDZ; iz += stepZ; }
      }
      return bestTri < 0 ? null : { t: best, tri: bestTri };
    }
  }

  // Shared helpers --------------------------------------------------------
  const MazeShared = { grid: null, ready: false, floorY: 0 };
  window.MazeShared = MazeShared;

  // true if moving from a to b (world space) would bring you within `radius` of a wall
  MazeShared.blocked = function (a, b, radius) {
    const grid = MazeShared.grid;
    if (!grid) return false;
    const dir = new THREE.Vector3().subVectors(b, a);
    dir.y = 0;
    const len = dir.length();
    if (len < 1e-6) return false;
    dir.divideScalar(len);
    for (const h of [0.35, 1.2]) {
      // check at knee and chest height above the floor
      const o = new THREE.Vector3(a.x, MazeShared.floorY + h, a.z);
      if (grid.raycast(o, dir, len + radius)) return true;
    }
    return false;
  };

  function makeEnvironment(renderer) {
    // Simple sky/ground gradient so polished metal reads as a mirror
    const scene = new THREE.Scene();
    const geo = new THREE.SphereGeometry(50, 32, 16);
    const cols = [];
    const pos = geo.attributes.position;
    const sky = new THREE.Color('#9cc4ea'), horizon = new THREE.Color('#e9eef2'),
      ground = new THREE.Color('#4a4a4a');
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i) / 50;
      const c = y > 0 ? horizon.clone().lerp(sky, Math.pow(y, 0.6))
                      : horizon.clone().lerp(ground, Math.min(1, -y * 4));
      cols.push(c.r, c.g, c.b);
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    scene.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      vertexColors: true, side: THREE.BackSide })));
    const pmrem = new THREE.PMREMGenerator(renderer);
    const env = pmrem.fromScene(scene, 0.02).texture;
    pmrem.dispose();
    return env;
  }

  // ---------------------------------------------------------------- mirror-maze
  AFRAME.registerComponent('mirror-maze', {
    schema: {
      model: { type: 'selector', default: '#maze' },
      pool: { default: 4 },            // live mirrors on desktop
      vrPool: { default: 2 },          // live mirrors in VR (each renders twice)
      rays: { type: 'vec2', default: { x: 12, y: 7 } },
      raysPerFrame: { default: 12 },   // spread the ray grid over several frames
      maxDistance: { default: 40 },
      minArea: { default: 0.05 },
      resolution: { default: 0.75 },   // mirror texture size vs. screen
      debug: { default: false },
    },

    init() {
      this.planes = [];
      this.pool = [];
      this.assigned = new Map(); // plane index -> reflector
      this.hits = new Map();
      this.rayCursor = 0;
      this.raycaster = new THREE.Raycaster();
      this.raycaster.layers.set(0);
      this.ndc = new THREE.Vector2();
      this.tmpV = new THREE.Vector3();
      this.inVR = false;
      this.stats = { live: 0, planes: 0 };
      window.mirrorMaze = this; // handy for debugging in the browser console

      const onLoad = () => this.build();
      if (this.data.model.getObject3D('mesh')) onLoad();
      else this.data.model.addEventListener('model-loaded', onLoad, { once: true });

      this.el.addEventListener('enter-vr', () => { this.inVR = true; this.resize(); });
      this.el.addEventListener('exit-vr', () => { this.inVR = false; this.resize(); });
      window.addEventListener('resize', () => setTimeout(() => this.resize(), 50));
    },

    build() {
      const renderer = this.el.renderer;
      const sceneObj = this.el.object3D;
      sceneObj.environment = makeEnvironment(renderer);

      const root = this.data.model.getObject3D('mesh');
      root.updateWorldMatrix(true, true);
      const meshes = [];
      root.traverse((o) => { if (o.isMesh) meshes.push(o); });
      MazeShared.floorY = new THREE.Box3().setFromObject(root).min.y;
      MazeShared.grid = this.grid = new TriGrid(meshes);
      MazeShared.ready = true;

      // Group mirror triangles into planes (world space)
      const groups = new Map();
      const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
      const e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
      const r2 = (x) => Math.round(x * 100) / 100;
      for (const mesh of meshes) {
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        if (!mats.some(isMirrorMaterial)) continue;
        mats.forEach((m) => { if (isMirrorMaterial(m)) { m.envMapIntensity = 1.0; } });
        const g = mesh.geometry;
        const p = g.attributes.position;
        const idx = g.index;
        const triCount = idx ? idx.count / 3 : p.count / 3;
        for (let t = 0; t < triCount; t++) {
          const i0 = idx ? idx.getX(3 * t) : 3 * t;
          const i1 = idx ? idx.getX(3 * t + 1) : 3 * t + 1;
          const i2 = idx ? idx.getX(3 * t + 2) : 3 * t + 2;
          a.fromBufferAttribute(p, i0).applyMatrix4(mesh.matrixWorld);
          b.fromBufferAttribute(p, i1).applyMatrix4(mesh.matrixWorld);
          c.fromBufferAttribute(p, i2).applyMatrix4(mesh.matrixWorld);
          const n = e1.subVectors(b, a).cross(e2.subVectors(c, a));
          const area = n.length() / 2;
          if (area < 1e-6) continue;
          n.normalize();
          const d = n.dot(a);
          const key = `${r2(n.x)},${r2(n.y)},${r2(n.z)},${r2(d)}`;
          let grp = groups.get(key);
          if (!grp) groups.set(key, (grp = { nsum: new THREE.Vector3(), area: 0, pts: [] }));
          grp.nsum.addScaledVector(n, area);
          grp.area += area;
          grp.pts.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
        }
      }

      const up = new THREE.Vector3();
      const tmp = new THREE.Vector3();
      for (const grp of groups.values()) {
        if (grp.area < this.data.minArea) continue;
        const n = grp.nsum.clone().normalize();
        up.set(0, Math.abs(n.y) < 0.9 ? 1 : 0, Math.abs(n.y) < 0.9 ? 0 : 1);
        const u = new THREE.Vector3().crossVectors(up, n).normalize();
        const v = new THREE.Vector3().crossVectors(n, u).normalize();
        const pts = grp.pts;
        let umin = Infinity, umax = -Infinity, vmin = Infinity, vmax = -Infinity, dsum = 0;
        const o = new THREE.Vector3(pts[0], pts[1], pts[2]);
        for (let i = 0; i < pts.length; i += 3) {
          tmp.set(pts[i], pts[i + 1], pts[i + 2]);
          dsum += n.dot(tmp);
          tmp.sub(o);
          const pu = tmp.dot(u), pv = tmp.dot(v);
          umin = Math.min(umin, pu); umax = Math.max(umax, pu);
          vmin = Math.min(vmin, pv); vmax = Math.max(vmax, pv);
        }
        const d = dsum / (pts.length / 3);
        const center = o.clone().addScaledVector(u, (umin + umax) / 2)
          .addScaledVector(v, (vmin + vmax) / 2);
        center.addScaledVector(n, d - n.dot(center));
        // Local geometry: the actual mirror triangles, flattened onto the plane
        const local = new Float32Array(pts.length);
        for (let i = 0; i < pts.length; i += 3) {
          tmp.set(pts[i], pts[i + 1], pts[i + 2]).sub(center);
          local[i] = tmp.dot(u); local[i + 1] = tmp.dot(v); local[i + 2] = 0;
        }
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(local, 3));
        geometry.computeBoundingSphere();
        const matrix = new THREE.Matrix4().makeBasis(u, v, n)
          .setPosition(center.clone().addScaledVector(n, 0.004));
        this.planes.push({ n, u, v, c: center, d, hu: (umax - umin) / 2,
          hv: (vmax - vmin) / 2, area: grp.area, geometry, matrix });
      }
      // normal (1 decimal) -> [[d, planeIndex]] for mapping ray hits to planes
      this.lut = new Map();
      this.planes.forEach((pl, i) => {
        const k = `${pl.n.x.toFixed(1)},${pl.n.y.toFixed(1)},${pl.n.z.toFixed(1)}`;
        if (!this.lut.has(k)) this.lut.set(k, []);
        this.lut.get(k).push([pl.d, i]);
      });
      this.stats.planes = this.planes.length;

      // Reflector pool
      const max = Math.max(this.data.pool, this.data.vrPool);
      for (let i = 0; i < max; i++) {
        const r = new window.MirrorReflector(new THREE.BufferGeometry(), {
          extraLayers: [AVATAR_LAYER],
        });
        r.layers.set(MIRROR_LAYER);
        r.matrixAutoUpdate = false;
        r.visible = false;
        r.planeIndex = -1;
        sceneObj.add(r);
        this.pool.push(r);
      }
      this.resize();
      this.built = true;
      this.el.emit('mirrors-ready', { planes: this.planes.length });
      if (this.data.debug) console.log('[mirror-maze]', this.planes.length, 'mirror planes');
    },

    resize() {
      if (!this.pool.length) return;
      const size = this.el.renderer.getDrawingBufferSize(new THREE.Vector2());
      let w = size.x * this.data.resolution, h = size.y * this.data.resolution;
      if (this.inVR) { w = 1024; h = 1024; }
      this.pool.forEach((r) => r.setSize(w, h));
    },

    planeForHit(point, normal) {
      const k = `${normal.x.toFixed(1)},${normal.y.toFixed(1)},${normal.z.toFixed(1)}`;
      const list = this.lut.get(k);
      if (!list) return -1;
      let best = -1, err = 0.05;
      for (const [d, i] of list) {
        const e = Math.abs(normal.dot(point) - d);
        if (e < err) { err = e; best = i; }
      }
      return best;
    },

    castSomeRays(camera) {
      const { x: gx, y: gy } = this.data.rays;
      const total = gx * gy;
      const nrm = this.tmpV;
      for (let k = 0; k < this.data.raysPerFrame; k++) {
        if (this.rayCursor > 0 && this.rayCursor % total === 0) {
          // Finished one sweep of the grid: re-assign the mirrors
          this.reassign(camera);
          this.hits = new Map();
        }
        const i = this.rayCursor++ % total;
        const ix = i % gx, iy = (i / gx) | 0;
        this.ndc.set(((ix + 0.5) / gx) * 2 - 1, ((iy + 0.5) / gy) * 2 - 1);
        this.raycaster.setFromCamera(this.ndc, camera);
        const ray = this.raycaster.ray;
        const hit = this.grid.raycast(ray.origin, ray.direction, this.data.maxDistance);
        if (hit && this.grid.mirror[hit.tri]) {
          const N = this.grid.normals;
          nrm.set(N[3 * hit.tri], N[3 * hit.tri + 1], N[3 * hit.tri + 2]);
          if (nrm.dot(ray.direction) >= 0) continue; // seeing the back of a wall
          const point = ray.at(hit.t, new THREE.Vector3());
          const p = this.planeForHit(point, nrm);
          if (p >= 0) this.hits.set(p, (this.hits.get(p) || 0) + 1);
        }
      }
    },

    nearestPlanes(eye, fwd, count, exclude) {
      const out = [];
      const rel = new THREE.Vector3(), closest = new THREE.Vector3(), to = new THREE.Vector3();
      this.planes.forEach((pl, i) => {
        if (exclude.has(i)) return;
        rel.subVectors(eye, pl.c);
        if (rel.dot(pl.n) <= 0.01) return; // you're behind this mirror
        const cu = THREE.MathUtils.clamp(rel.dot(pl.u), -pl.hu, pl.hu);
        const cv = THREE.MathUtils.clamp(rel.dot(pl.v), -pl.hv, pl.hv);
        closest.copy(pl.c).addScaledVector(pl.u, cu).addScaledVector(pl.v, cv);
        to.subVectors(closest, eye);
        const dist = to.length();
        if (dist > this.data.maxDistance) return;
        if (dist > 1.5 && to.normalize().dot(fwd) < -0.2) return; // behind you
        out.push([dist, i]);
      });
      out.sort((p, q) => p[0] - q[0]);
      return out.slice(0, count).map((p) => p[1]);
    },

    reassign(camera) {
      const poolSize = this.inVR ? this.data.vrPool : this.data.pool;
      const chosen = [...this.hits.entries()].sort((p, q) => q[1] - p[1])
        .map((e) => e[0]).slice(0, poolSize);
      const eye = camera.getWorldPosition(new THREE.Vector3());
      const fwd = camera.getWorldDirection(new THREE.Vector3());
      if (chosen.length < poolSize) {
        chosen.push(...this.nearestPlanes(eye, fwd, poolSize - chosen.length, new Set(chosen)));
      }
      const want = new Set(chosen);
      // Keep reflectors that are already on a wanted plane (no flicker)
      const free = [];
      this.pool.forEach((r, idx) => {
        if (idx >= poolSize || !want.has(r.planeIndex)) {
          r.visible = false;
          r.planeIndex = -1;
          if (idx < poolSize) free.push(r);
        } else {
          want.delete(r.planeIndex);
        }
      });
      for (const pi of want) {
        const r = free.shift();
        if (!r) break;
        const pl = this.planes[pi];
        r.geometry = pl.geometry;
        r.matrix.copy(pl.matrix);
        r.matrixWorld.copy(pl.matrix);
        r.planeIndex = pi;
        r.visible = true;
      }
      this.stats.live = this.pool.filter((r) => r.visible).length;
      this.stats.assigned = this.pool.filter((r) => r.visible).map((r) => r.planeIndex);
    },

    tick() {
      if (!this.built) return;
      const camera = this.el.camera;
      if (!camera) return;
      camera.layers.enable(MIRROR_LAYER);   // you see the live mirrors...
      camera.layers.disable(AVATAR_LAYER);  // ...but not your own avatar
      this.castSomeRays(camera);
    },
  });

  // ---------------------------------------------------------------- walk-avatar
  AFRAME.registerComponent('walk-avatar', {
    schema: {
      node: { default: 'WalkAvatar' },
      backOffset: { default: 0.3 },
      hideFromViewer: { default: true },
    },
    init() {
      this.fwd = new THREE.Vector3();
      this.eye = new THREE.Vector3();
      this.el.addEventListener('model-loaded', () => {
        const mesh = this.el.getObject3D('mesh');
        this.node = mesh.getObjectByName(this.data.node) || mesh;
        mesh.traverse((o) => {
          if (this.data.hideFromViewer) o.layers.set(AVATAR_LAYER);
          o.frustumCulled = false;
        });
      });
    },
    tick() {
      const cam = this.el.sceneEl.camera;
      if (!this.node || !cam) return;
      cam.getWorldPosition(this.eye);
      cam.getWorldDirection(this.fwd);
      this.fwd.y = 0;
      if (this.fwd.lengthSq() < 1e-6) return;
      this.fwd.normalize();
      const floorY = MazeShared.ready ? MazeShared.floorY : 0;
      this.node.position.set(
        this.eye.x - this.fwd.x * this.data.backOffset,
        floorY,
        this.eye.z - this.fwd.z * this.data.backOffset
      );
      this.node.quaternion.setFromAxisAngle(THREE.Object3D.DEFAULT_UP,
        Math.atan2(this.fwd.x, this.fwd.z));
    },
  });

  // --------------------------------------------------------------- wall-collide
  AFRAME.registerComponent('wall-collide', {
    schema: { radius: { default: 0.3 } },
    init() {
      this.prevLocal = this.el.object3D.position.clone();
      this.prevWorld = new THREE.Vector3();
      this.curWorld = new THREE.Vector3();
      this.el.object3D.getWorldPosition(this.prevWorld);
    },
    tick() {
      const o = this.el.object3D;
      o.updateWorldMatrix(true, false);
      o.getWorldPosition(this.curWorld);
      if (this.el.sceneEl.is('vr-mode')) {
        // In VR your real head moves the camera; stick-walk handles collisions
        this.prevLocal.copy(o.position);
        this.prevWorld.copy(this.curWorld);
        return;
      }
      if (this.curWorld.distanceToSquared(this.prevWorld) > 1e-8 &&
          MazeShared.blocked(this.prevWorld, this.curWorld, this.data.radius)) {
        // Try sliding along the wall: keep only one axis of the move
        const moved = o.position.clone();
        let ok = false;
        for (const axis of ['x', 'z']) {
          o.position.copy(this.prevLocal);
          o.position[axis] = moved[axis];
          o.updateWorldMatrix(true, false);
          o.getWorldPosition(this.curWorld);
          if (!MazeShared.blocked(this.prevWorld, this.curWorld, this.data.radius)) {
            ok = true; break;
          }
        }
        if (!ok) o.position.copy(this.prevLocal);
        o.updateWorldMatrix(true, false);
        o.getWorldPosition(this.curWorld);
      }
      this.prevLocal.copy(o.position);
      this.prevWorld.copy(this.curWorld);
    },
  });

  // ----------------------------------------------------------------- stick-walk
  AFRAME.registerComponent('stick-walk', {
    schema: {
      rig: { type: 'selector', default: '#rig' },
      speed: { default: 1.6 },   // m/s
      snapTurn: { default: 30 }, // degrees, right stick
    },
    init() {
      this.axis = { x: 0, y: 0 };
      this.turnReady = true;
      this.el.addEventListener('thumbstickmoved', (e) => {
        const hand = (this.el.getAttribute('meta-touch-controls') ||
          this.el.getAttribute('oculus-touch-controls') || {}).hand;
        if (hand === 'right') {
          if (Math.abs(e.detail.x) > 0.7 && this.turnReady) {
            this.data.rig.object3D.rotation.y -= THREE.MathUtils.degToRad(
              this.data.snapTurn) * Math.sign(e.detail.x);
            this.turnReady = false;
          } else if (Math.abs(e.detail.x) < 0.3) this.turnReady = true;
        } else {
          this.axis.x = e.detail.x; this.axis.y = e.detail.y;
        }
      });
    },
    tick(t, dt) {
      if (!dt || (Math.abs(this.axis.x) < 0.15 && Math.abs(this.axis.y) < 0.15)) return;
      const cam = this.el.sceneEl.camera;
      const fwd = cam.getWorldDirection(new THREE.Vector3());
      fwd.y = 0; fwd.normalize();
      const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
      const step = new THREE.Vector3()
        .addScaledVector(fwd, -this.axis.y).addScaledVector(right, this.axis.x)
        .multiplyScalar(this.data.speed * dt / 1000);
      const rig = this.data.rig.object3D;
      const from = cam.getWorldPosition(new THREE.Vector3());
      const to = from.clone().add(step);
      if (!MazeShared.blocked(from, to, 0.3)) rig.position.add(step);
    },
  });
})();

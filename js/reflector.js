/*
 * Planar mirror for A-Frame, adapted from three.js's examples/jsm/objects/Reflector.js
 * (MIT licence). Uses A-Frame's bundled THREE so there is only one copy of three.js.
 *
 * Each frame it renders the scene from the mirror-image of the viewer's camera
 * into a texture and shows that texture on its geometry. That is what lets the
 * avatar behind you appear in front of you.
 *
 * Geometry must lie in the object's local XY plane, facing local +Z.
 */
(function () {
  const THREE = AFRAME.THREE;

  const vertexShader = /* glsl */ `
    uniform mat4 textureMatrix;
    varying vec4 vUv;
    #include <common>
    #include <logdepthbuf_pars_vertex>
    void main() {
      vUv = textureMatrix * vec4(position, 1.0);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      #include <logdepthbuf_vertex>
    }`;

  const fragmentShader = /* glsl */ `
    uniform vec3 tint;
    uniform sampler2D tDiffuse;
    varying vec4 vUv;
    #include <logdepthbuf_pars_fragment>
    void main() {
      #include <logdepthbuf_fragment>
      vec4 base = texture2DProj(tDiffuse, vUv);
      gl_FragColor = vec4(base.rgb * tint, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`;

  class Reflector extends THREE.Mesh {
    constructor(geometry, options = {}) {
      super(geometry);
      this.isReflector = true;
      this.type = 'Reflector';
      this.frustumCulled = true;

      const scope = this;
      const clipBias = options.clipBias || 0.003;
      const virtualCamera = (this.camera = new THREE.PerspectiveCamera());
      // What the mirror sees: normal scene (layer 0) + things only mirrors see
      virtualCamera.layers.set(0);
      (options.extraLayers || []).forEach((l) => virtualCamera.layers.enable(l));

      const reflectorPlane = new THREE.Plane();
      const normal = new THREE.Vector3();
      const reflectorWorldPosition = new THREE.Vector3();
      const cameraWorldPosition = new THREE.Vector3();
      const rotationMatrix = new THREE.Matrix4();
      const lookAtPosition = new THREE.Vector3(0, 0, -1);
      const clipPlane = new THREE.Vector4();
      const view = new THREE.Vector3();
      const target = new THREE.Vector3();
      const q = new THREE.Vector4();
      const textureMatrix = new THREE.Matrix4();

      this.renderTarget = new THREE.WebGLRenderTarget(
        options.textureWidth || 512,
        options.textureHeight || 512,
        { samples: options.multisample || 0, type: THREE.HalfFloatType }
      );

      this.material = new THREE.ShaderMaterial({
        name: 'ReflectorMaterial',
        uniforms: {
          tint: { value: new THREE.Color(options.tint || 0xe8e8e8) },
          tDiffuse: { value: this.renderTarget.texture },
          textureMatrix: { value: textureMatrix },
        },
        vertexShader,
        fragmentShader,
      });

      this.onBeforeRender = function (renderer, scene, camera) {
        reflectorWorldPosition.setFromMatrixPosition(scope.matrixWorld);
        cameraWorldPosition.setFromMatrixPosition(camera.matrixWorld);
        rotationMatrix.extractRotation(scope.matrixWorld);
        normal.set(0, 0, 1).applyMatrix4(rotationMatrix);

        view.subVectors(reflectorWorldPosition, cameraWorldPosition);
        // Avoid rendering when the mirror is facing away from the viewer
        if (view.dot(normal) > 0) return;

        view.reflect(normal).negate();
        view.add(reflectorWorldPosition);

        rotationMatrix.extractRotation(camera.matrixWorld);
        lookAtPosition.set(0, 0, -1).applyMatrix4(rotationMatrix);
        lookAtPosition.add(cameraWorldPosition);

        target.subVectors(reflectorWorldPosition, lookAtPosition);
        target.reflect(normal).negate();
        target.add(reflectorWorldPosition);

        virtualCamera.position.copy(view);
        virtualCamera.up.set(0, 1, 0).applyMatrix4(rotationMatrix).reflect(normal);
        virtualCamera.lookAt(target);
        virtualCamera.far = camera.far;
        virtualCamera.updateMatrixWorld();
        virtualCamera.projectionMatrix.copy(camera.projectionMatrix);

        // Map clip space -> texture space
        textureMatrix.set(
          0.5, 0.0, 0.0, 0.5,
          0.0, 0.5, 0.0, 0.5,
          0.0, 0.0, 0.5, 0.5,
          0.0, 0.0, 0.0, 1.0
        );
        textureMatrix.multiply(virtualCamera.projectionMatrix);
        textureMatrix.multiply(virtualCamera.matrixWorldInverse);
        textureMatrix.multiply(scope.matrixWorld);

        // Oblique near plane = mirror plane, so nothing behind the glass is drawn
        // (Lengyel, "Oblique View Frustum Depth Projection and Clipping")
        reflectorPlane.setFromNormalAndCoplanarPoint(normal, reflectorWorldPosition);
        reflectorPlane.applyMatrix4(virtualCamera.matrixWorldInverse);
        clipPlane.set(
          reflectorPlane.normal.x, reflectorPlane.normal.y,
          reflectorPlane.normal.z, reflectorPlane.constant
        );
        const pm = virtualCamera.projectionMatrix;
        q.x = (Math.sign(clipPlane.x) + pm.elements[8]) / pm.elements[0];
        q.y = (Math.sign(clipPlane.y) + pm.elements[9]) / pm.elements[5];
        q.z = -1.0;
        q.w = (1.0 + pm.elements[10]) / pm.elements[14];
        clipPlane.multiplyScalar(2.0 / clipPlane.dot(q));
        pm.elements[2] = clipPlane.x;
        pm.elements[6] = clipPlane.y;
        pm.elements[10] = clipPlane.z + 1.0 - clipBias;
        pm.elements[14] = clipPlane.w;

        scope.visible = false;
        const currentRenderTarget = renderer.getRenderTarget();
        const currentXrEnabled = renderer.xr.enabled;
        const currentShadowAutoUpdate = renderer.shadowMap.autoUpdate;
        renderer.xr.enabled = false; // avoid the XR camera replacing ours
        renderer.shadowMap.autoUpdate = false;
        renderer.setRenderTarget(scope.renderTarget);
        renderer.state.buffers.depth.setMask(true);
        if (renderer.autoClear === false) renderer.clear();
        renderer.render(scene, virtualCamera);
        renderer.xr.enabled = currentXrEnabled;
        renderer.shadowMap.autoUpdate = currentShadowAutoUpdate;
        renderer.setRenderTarget(currentRenderTarget);
        const viewport = camera.viewport;
        if (viewport !== undefined) renderer.state.viewport(viewport);
        scope.visible = true;
      };
    }

    setSize(w, h) {
      this.renderTarget.setSize(Math.max(1, w | 0), Math.max(1, h | 0));
    }

    dispose() {
      this.renderTarget.dispose();
      this.material.dispose();
    }
  }

  window.MirrorReflector = Reflector;
})();

import { Matrix4, Uniform, Vector2 } from 'three';
import { BlendFunction, Effect, EffectAttribute } from 'postprocessing';

/**
 * VelocityMotionBlurEffect — true velocity-based motion blur for WebGLRenderer.
 *
 * Unlike frame-accumulation trails (AfterimagePass), this reconstructs a
 * per-pixel velocity vector every frame: each pixel's world position is
 * rebuilt from the depth buffer, reprojected with last frame's
 * view-projection matrix, and the UV-space difference drives a symmetric
 * gather blur along the motion direction. Fast camera rotations and moving
 * objects get a smooth, directional smear instead of discrete ghost slices.
 */
export class VelocityMotionBlurEffect extends Effect {
  /**
   * @param {THREE.Camera} camera - The main camera.
   * @param {Object} [options]
   * @param {Number} [options.intensity=1.0] - Scales the blur vector length.
   * @param {Number} [options.samples=16] - Gather taps along the motion vector.
   * @param {Number} [options.maxVelocity=0.075] - Max blur length in UV units.
   */
  constructor(camera, { intensity = 1.0, samples = 16, maxVelocity = 0.075 } = {}) {
    const fragmentShader = /* glsl */ `
      uniform mat4 prevViewProjectionMatrix;
      uniform mat4 viewProjectionMatrixInverse;
      uniform float velocityScale;
      uniform float maxVelocity;
      uniform vec2 exclusionCenter;
      uniform vec2 exclusionRadii;
      uniform float exclusionEnabled;

      void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
        // readDepth() + depthBuffer are injected by the framework because
        // this effect declares EffectAttribute.DEPTH.
        float depth = readDepth(uv);

        // World position from depth (works for skybox/HDR background too,
        // which lands on the far plane and blurs correctly on rotation).
        vec4 clipPos = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
        vec4 worldPos = viewProjectionMatrixInverse * clipPos;
        worldPos /= max(worldPos.w, 1e-6);

        // Where that world point was on screen last frame.
        vec4 prevClip = prevViewProjectionMatrix * worldPos;
        vec2 prevUv = prevClip.xy / max(prevClip.w, 1e-6) * 0.5 + 0.5;
        vec2 velocity = (uv - prevUv) * velocityScale;

        float len = length(velocity);
        if (len > maxVelocity) velocity *= maxVelocity / len;

        // Symmetric box gather along the motion vector: smooth directional
        // smear, no ghosting slices.
        vec3 acc = inputColor.rgb;
        for (int i = 1; i <= ${samples}; i++) {
          float t = float(i) / float(${samples}) - 0.5;
          vec2 suv = clamp(uv + velocity * t, vec2(0.001), vec2(0.999));
          acc += texture2D(inputBuffer, suv).rgb;
        }
        outputColor = vec4(acc / float(${samples} + 1), inputColor.a);

        // Exclusion mask (e.g. the carried vacuum): keep this screen region
        // crystal clear by blending back to the sharp original input.
        vec2 ed = (uv - exclusionCenter) / max(exclusionRadii, vec2(1e-4));
        float keep = (1.0 - smoothstep(0.75, 1.0, length(ed))) * exclusionEnabled;
        outputColor = vec4(mix(outputColor.rgb, inputColor.rgb, keep), inputColor.a);
      }
    `;

    super('VelocityMotionBlurEffect', fragmentShader, {
      blendFunction: BlendFunction.NORMAL,
      attributes: EffectAttribute.DEPTH,
      uniforms: new Map([
        ['prevViewProjectionMatrix', new Uniform(new Matrix4())],
        ['viewProjectionMatrixInverse', new Uniform(new Matrix4())],
        ['velocityScale', new Uniform(intensity)],
        ['maxVelocity', new Uniform(maxVelocity)],
        ['exclusionCenter', new Uniform(new Vector2(0.5, 0.5))],
        ['exclusionRadii', new Uniform(new Vector2(0.2, 0.2))],
        ['exclusionEnabled', new Uniform(0)],
      ]),
    });

    this.camera = camera;
    this._currentVP = new Matrix4();
    this._prevVP = new Matrix4();
    this._primed = false;
  }

  get intensity() {
    return this.uniforms.get('velocityScale').value;
  }

  set intensity(value) {
    this.uniforms.get('velocityScale').value = value;
  }

  /**
   * Excludes an elliptical screen region (UV space) from the blur, e.g. to
   * keep a carried object crystal clear.
   */
  setExclusion(u, v, radiusU, radiusV) {
    this.uniforms.get('exclusionCenter').value.set(u, v);
    this.uniforms.get('exclusionRadii').value.set(radiusU, radiusV);
    this.uniforms.get('exclusionEnabled').value = 1;
  }

  /** Re-enables blur across the full screen. */
  clearExclusion() {
    this.uniforms.get('exclusionEnabled').value = 0;
  }

  /**
   * Refreshes current/previous view-projection matrices. Runs after the
   * RenderPass each frame, so the camera matrices are current.
   */
  update() {
    const cam = this.camera;
    cam.updateMatrixWorld();
    this._currentVP.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    if (!this._primed) {
      // First frame: no previous frame exists, so report zero velocity.
      this._prevVP.copy(this._currentVP);
      this._primed = true;
    }
    this.uniforms.get('prevViewProjectionMatrix').value.copy(this._prevVP);
    this.uniforms
      .get('viewProjectionMatrixInverse')
      .value.copy(this._currentVP)
      .invert();
    this._prevVP.copy(this._currentVP);
  }
}

import * as THREE from 'three';

/**
 * DirtLayer — procedural dirt overlay that the robot vacuum cleans.
 *
 * A single transparent plane sits just above the floor. Its CanvasTexture
 * starts fully "dirty" (procedural brown/gray blotches + grain) so the
 * tiles look grimy. As the vacuum moves, cleanAt() erases (destination-out)
 * a soft circle under the robot, restoring the pristine floor beneath.
 */
export class DirtLayer {
  constructor({ min, max, floorY, size = 1024, lift = 0.02 }) {
    this.min = min.clone();
    this.max = max.clone();
    this.size = size;
    this.width = Math.max(0.001, this.max.x - this.min.x);
    this.depth = Math.max(0.001, this.max.z - this.min.z);

    this.canvas = document.createElement('canvas');
    this.canvas.width = size;
    this.canvas.height = size;
    this.ctx = this.canvas.getContext('2d');

    this._paintDirt();

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;

    const geo = new THREE.PlaneGeometry(this.width, this.depth);
    const mat = new THREE.MeshStandardMaterial({
      map: this.texture,
      transparent: true,
      roughness: 1.0,
      metalness: 0.0,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.rotation.x = -Math.PI / 2;
    this.mesh.position.set(
      (this.min.x + this.max.x) / 2,
      floorY + lift,
      (this.min.z + this.max.z) / 2
    );
    this.mesh.receiveShadow = true;
    this.mesh.renderOrder = 1;

    this._lastX = null;
    this._lastZ = null;

    // Downsampled readback canvas for cheap cleaned-fraction estimates.
    this._sampleSize = 64;
    this._sampleCanvas = document.createElement('canvas');
    this._sampleCanvas.width = this._sampleSize;
    this._sampleCanvas.height = this._sampleSize;
    this._sampleCtx = this._sampleCanvas.getContext('2d', { willReadFrequently: true });
    this._initialDirty = this._countDirty();
  }

  /** Fill the canvas with procedural grime: blotches + speckles. */
  _paintDirt() {
    const { ctx, size } = this;
    ctx.clearRect(0, 0, size, size);

    // Seeded PRNG (mulberry32) so the dirt pattern is stable per load.
    let seed = 1337;
    const rand = () => {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    // Large soft brown/gray patches.
    for (let i = 0; i < 260; i++) {
      const x = rand() * size;
      const y = rand() * size;
      const r = 6 + rand() * 34;
      const tone = 40 + Math.floor(rand() * 50); // dark warm gray
      const alpha = 0.05 + rand() * 0.12;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(${tone + 25},${tone + 8},${tone - 8},${alpha})`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }

    // Fine speckle grain for close-up texture variation.
    for (let i = 0; i < 4500; i++) {
      const x = rand() * size;
      const y = rand() * size;
      const r = 0.5 + rand() * 1.8;
      const alpha = 0.04 + rand() * 0.1;
      const v = 30 + Math.floor(rand() * 60);
      ctx.fillStyle = `rgba(${v + 20},${v + 5},${v - 10},${alpha})`;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /** Count dirty pixels on a 64x64 downsample (alpha > 10). */
  _countDirty() {
    const s = this._sampleSize;
    this._sampleCtx.clearRect(0, 0, s, s);
    this._sampleCtx.drawImage(this.canvas, 0, 0, s, s);
    const data = this._sampleCtx.getImageData(0, 0, s, s).data;
    let dirty = 0;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] > 10) dirty++;
    }
    return dirty;
  }

  /** Fraction of dirt cleaned so far (0..1). Drives the task-list progress. */
  estimateCleaned() {
    if (!this._initialDirty) return 1;
    const f = 1 - this._countDirty() / this._initialDirty;
    return THREE.MathUtils.clamp(f, 0, 1);
  }

  /** World (x,z) -> canvas pixels. Returns [px, py]. */
  _worldToPixel(x, z) {
    const u = (x - this.min.x) / this.width;
    const v = 1 - (z - this.min.z) / this.depth;
    return [u * this.size, v * this.size];
  }

  /**
   * Erase dirt under the given world position.
   * @param {number} x world x
   * @param {number} z world z
   * @param {number} radiusWorld cleaning radius in meters
   */
  cleanAt(x, z, radiusWorld = 0.9) {
    // Skip tiny steps to avoid redundant texture uploads.
    if (this._lastX !== null) {
      const dx = x - this._lastX;
      const dz = z - this._lastZ;
      if (dx * dx + dz * dz < 0.0004) return;
    }
    this._lastX = x;
    this._lastZ = z;

    const [px, py] = this._worldToPixel(x, z);
    // Canvas px per meter (assume square-ish mapping).
    const ppm = this.size / Math.max(this.width, this.depth);
    const r = Math.max(2, radiusWorld * ppm);

    const { ctx } = this;
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    const g = ctx.createRadialGradient(px, py, 0, px, py, r);
    g.addColorStop(0, 'rgba(0,0,0,1)');
    g.addColorStop(0.7, 'rgba(0,0,0,0.9)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    this.texture.needsUpdate = true;
  }
}

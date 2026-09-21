import * as THREE from 'three';
import { OBB } from 'three/examples/jsm/math/OBB.js';

/**
 * Bob — rigged pigeon enemy (models/bob.glb).
 *
 * - Spawns near the player, Minecraft-style "Bob" name tag (canvas sprite).
 * - Collision: a live oriented box (OBB) captured from the model's own
 *   geometry and re-posed every frame, so bullets and body collisions track
 *   the mesh exactly (including the sideways death fall).
 * - Aggro: within aggroRange, smoothly yaw toward player (turn-first,
 *   move only when roughly facing), chases; if player sprints away Bob is
 *   effectively slower and gets left behind.
 * - Vacuum hiding: while player possesses the vacuum (isPossessed), AI
 *   loses track entirely (idles).
 * - Combat: on contact deals 30 dmg with cooldown; player HP lives in main.js.
 * - Death: 6 gun hits -> falls sideways, fades, removed from scene.
 */
export class Bob {
  constructor(scene, roomMesh = null) {
    this.scene = scene;
    this.roomMesh = roomMesh;
    this.mesh = null;
    this.mixer = null;
    this.headBone = null;

    this.nameTag = null;
    this.nameTagHeight = 1.1;
    this._tagCanvas = null;
    this._tagCtx = null;

    this.state = 'idle'; // idle | chase | attack | dying | dead
    this.aggroRange = 17.5;
    this.attackRange = 1.4;
    this.baseSpeed = 3.2;
    // Smooth turn-first tracking.
    this.turnSpeed = 3.5; // rad/s
    this.faceThreshold = 0.5; // rad — move only when facing within this

    this.hitsTaken = 0;
    this.maxHits = 6;
    this.attackDamage = 30;
    this.attackCooldown = 1.0;
    this.attackTimer = 0;

    // Death sequence phases: 'fall' -> 'fade' -> done.
    this.deathTimer = 0;
    this.deathFallDur = 0.8;
    this.deathFadeDur = 2.0;
    this.deathStartZ = 0;

    this.floorMin = null;
    this.floorMax = null;

    // Live oriented collision box wrapping the model: local-space bounds
    // are captured from the geometry once, then re-posed from the mesh's
    // world matrix every frame (same pattern as the TV collider).
    this.obb = new OBB();
    this.localBox = new THREE.Box3();
    this.localCenter = new THREE.Vector3();
    this.broadphaseBox = new THREE.Box3();
    this.colliderReady = false;

    this._dir = new THREE.Vector3();
    this._raycaster = new THREE.Raycaster();
    this._down = new THREE.Vector3(0, -1, 0);
    this._rayO = new THREE.Vector3();
    this._cM4 = new THREE.Matrix4();
    this._cInv = new THREE.Matrix4();
    this._cQuat = new THREE.Quaternion();
    this._cCorner = new THREE.Vector3();
    this._cRay = new THREE.Ray();
    this._cHit = new THREE.Vector3();
  }

  setFloorBounds(min, max) {
    this.floorMin = min.clone();
    this.floorMax = max.clone();
  }

  setMesh(mesh, animations = []) {
    this.mesh = mesh;
    this.mesh.traverse((obj) => {
      if (obj.isMesh) {
        obj.castShadow = true;
        obj.receiveShadow = true;
        obj.frustumCulled = true;
        // Clone materials per-instance so death fade / hit flash on one
        // Bob does not affect the other 7 sharing the same glTF material.
        if (obj.material) {
          if (Array.isArray(obj.material)) obj.material = obj.material.map((m) => m.clone());
          else obj.material = obj.material.clone();
        }
      }
    });
    // Play embedded rig animation if the model ships one (walk/idle loop).
    if (animations && animations.length > 0) {
      this.mixer = new THREE.AnimationMixer(this.mesh);
      for (const clip of animations) {
        const action = this.mixer.clipAction(clip);
        action.play();
      }
    }
    // Best-effort head bone for head tracking (body yaw always applies too).
    this.mesh.traverse((obj) => {
      if (!this.headBone && /head/i.test(obj.name) && (obj.isBone || obj.isObject3D)) {
        this.headBone = obj;
      }
    });
    // Capture the collision box from the model's own geometry (wraps the
    // custom model tightly, whatever its shape), converted to mesh-local
    // space so it can be re-posed every frame as Bob moves/turns/falls.
    this.mesh.updateMatrixWorld(true);
    this.localBox.setFromObject(this.mesh);
    this.localBox.applyMatrix4(this._cInv.copy(this.mesh.matrixWorld).invert());
    this.localBox.getCenter(this.localCenter);
    this.localBox.getSize(this._cCorner);
    this.obb.halfSize.copy(this._cCorner).multiplyScalar(0.5);
    this.colliderReady = true;
    this.updateCollider();
    this.attachNameTag();
  }

  /**
   * Re-pose the oriented collider from the mesh's current world matrix and
   * refresh the axis-aligned broadphase from its 8 rotated corners. Cheap
   * (no geometry traversal) — runs every frame so the box wraps the mesh
   * exactly through chasing, turning, and the sideways death fall.
   */
  updateCollider() {
    if (!this.mesh || !this.colliderReady) return;
    this.mesh.updateMatrixWorld(true);
    this.mesh.getWorldQuaternion(this._cQuat);
    this._cM4.makeRotationFromQuaternion(this._cQuat);
    this.obb.rotation.setFromMatrix4(this._cM4);
    this.obb.center.copy(this.localCenter).applyMatrix4(this.mesh.matrixWorld);
    this.broadphaseBox.makeEmpty();
    for (let i = 0; i < 8; i++) {
      this._cCorner
        .set(
          i & 1 ? this.localBox.max.x : this.localBox.min.x,
          i & 2 ? this.localBox.max.y : this.localBox.min.y,
          i & 4 ? this.localBox.max.z : this.localBox.min.z
        )
        .applyMatrix4(this.mesh.matrixWorld);
      this.broadphaseBox.expandByPoint(this._cCorner);
    }
  }

  /**
   * Hitscan test of a world-space ray against Bob's collision box.
   * Transforms the ray into mesh-local space and intersects the tight
   * local bounds (robust for rigged/skinned meshes where per-triangle
   * raycasts are costly and pose-sensitive). Returns the world-space hit
   * distance, or null when inactive / missed.
   */
  rayHitDistance(worldRay) {
    if (!this.mesh || !this.colliderReady) return null;
    if (this.state === 'dying' || this.state === 'dead') return null;
    this.mesh.updateMatrixWorld(true);
    this._cInv.copy(this.mesh.matrixWorld).invert();
    this._cRay.copy(worldRay).applyMatrix4(this._cInv);
    const localHit = this._cRay.intersectBox(this.localBox, this._cHit);
    if (!localHit) return null;
    // Back to world space for a scale-independent distance.
    this._cCorner.copy(localHit).applyMatrix4(this.mesh.matrixWorld);
    return worldRay.origin.distanceTo(this._cCorner);
  }

  /** Minecraft-style floating text: pixel font, dark plate, white + shadow. */
  attachNameTag() {
    // Canvas doubles as nameplate + mini HP bar so both match the "E"
    // prompt theme: dark translucent plate, thin white border, 'Patrick
    // Hand SC' HUD lettering with a soft glow (shadowBlur) + hard offset
    // shadow for readability.
    this._tagCanvas = document.createElement('canvas');
    this._tagCanvas.width = 256;
    this._tagCanvas.height = 104;
    this._tagCtx = this._tagCanvas.getContext('2d');
    const tex = new THREE.CanvasTexture(this._tagCanvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      depthTest: false,
    });
    this.nameTag = new THREE.Sprite(mat);
    this.nameTag.scale.set(1.2, 0.49, 1);
    this.nameTag.renderOrder = 999;
    this.drawNameTag();
    this.updateNameTagPos();
    this.scene.add(this.nameTag);
    // The HUD webfont may load after first draw — redraw so the plate
    // picks up 'Patrick Hand SC' instead of the fallback cursive.
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => this.drawNameTag()).catch(() => {});
    }
  }

  /** Redraws the plate + "Bob" label + mini HP bar (call on spawn + hit). */
  drawNameTag() {
    const ctx = this._tagCtx;
    if (!ctx) return;
    const W = this._tagCanvas.width;
    ctx.clearRect(0, 0, W, this._tagCanvas.height);
    // Plate: E-prompt style dark fill + thin light border.
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(48, 6, 160, 50, 10);
    else ctx.rect(48, 6, 160, 50);
    ctx.fill();
    ctx.stroke();
    // Label in the game HUD font.
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    try {
      ctx.letterSpacing = '2px';
    } catch {
      // letterSpacing unsupported — non-fatal.
    }
    ctx.font = '32px "Patrick Hand SC", cursive';
    // Glow pass (HUD-style) + hard offset shadow for readability.
    ctx.shadowColor = 'rgba(255, 255, 255, 0.6)';
    ctx.shadowBlur = 8;
    ctx.fillStyle = '#000000';
    ctx.fillText('Bob', 130, 34);
    ctx.fillStyle = '#ffffff';
    ctx.fillText('Bob', 128, 32);
    ctx.shadowBlur = 0;
    // Mini HP bar directly below the plate: green depleting to red.
    const frac = Math.max(0, (this.maxHits - this.hitsTaken) / this.maxHits);
    const bw = 160;
    const bx = (W - bw) / 2;
    const by = 62;
    const bh = 12;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(bx, by, bw, bh, 6);
    else ctx.rect(bx, by, bw, bh);
    ctx.fill();
    ctx.stroke();
    if (frac > 0) {
      ctx.fillStyle = frac > 0.5 ? '#2ecc71' : frac > 0.25 ? '#f39c12' : '#e74c3c';
      const fw = Math.max(bh, (bw - 4) * frac);
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(bx + 2, by + 2, fw, bh - 4, 4);
      else ctx.rect(bx + 2, by + 2, fw, bh - 4);
      ctx.fill();
    }
    if (this.nameTag) this.nameTag.material.map.needsUpdate = true;
  }

  updateNameTagPos() {
    if (!this.nameTag || !this.mesh) return;
    // Reuse the live broadphase box (no per-frame geometry traversal).
    const top = this.colliderReady ? this.broadphaseBox.max.y : this.mesh.position.y + 1.0;
    this.nameTag.position.copy(this.mesh.position);
    this.nameTag.position.y = top + 0.35;
  }

  groundYAt(x, yRef, z, fallback) {
    return this.floorMin ? this.floorMin.y : fallback;
  }

  static angleLerp(a, b, t) {
    let d = (b - a) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return a + d * THREE.MathUtils.clamp(t, 0, 1);
  }

  /** Called by the gun hitscan. Returns true if this hit killed Bob. */
  registerHit() {
    if (!this.mesh || this.state === 'dying' || this.state === 'dead') return false;
    this.hitsTaken += 1;
    this.drawNameTag();
    // Hit flash: brief emissive pulse on all meshes.
    this.mesh.traverse((obj) => {
      if (obj.isMesh && obj.material && obj.material.emissive) {
        obj.material.emissive.setHex(0x661111);
        setTimeout(() => {
          if (obj.material && obj.material.emissive) obj.material.emissive.setHex(0x000000);
        }, 120);
      }
    });
    if (this.hitsTaken >= this.maxHits) {
      this.startDeath();
      return true;
    }
    return false;
  }

  startDeath() {
    this.state = 'dying';
    this.deathTimer = 0;
    this.deathStartZ = this.mesh.rotation.z;
    // Dead men tell no tales (and block no bullets/bodies): freeze the
    // box and zero its extents so the shared OBB resolvers skip it too.
    this.colliderReady = false;
    this.obb.halfSize.set(0, 0, 0);
    // Make all materials fade-able.
    this.mesh.traverse((obj) => {
      if (obj.isMesh) {
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const m of mats) {
          m.transparent = true;
          m.needsUpdate = true;
        }
      }
    });
  }

  updateDeath(delta) {
    this.deathTimer += delta;
    const t = this.deathTimer;
    if (t < this.deathFallDur) {
      // Fall sideways: roll onto side.
      const k = t / this.deathFallDur;
      const eased = 1 - (1 - k) * (1 - k);
      this.mesh.rotation.z = this.deathStartZ + eased * (Math.PI / 2);
    } else {
      this.mesh.rotation.z = this.deathStartZ + Math.PI / 2;
      // Slowly fade away.
      const fadeT = (t - this.deathFallDur) / this.deathFadeDur;
      const opacity = Math.max(0, 1 - fadeT);
      this.mesh.traverse((obj) => {
        if (obj.isMesh) {
          const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
          for (const m of mats) m.opacity = opacity;
        }
      });
      if (this.nameTag) this.nameTag.material.opacity = opacity;
      if (fadeT >= 1) {
        this.scene.remove(this.mesh);
        if (this.nameTag) {
          this.scene.remove(this.nameTag);
          this.nameTag.material.map?.dispose();
          this.nameTag.material.dispose();
        }
        this.mesh = null;
        this.nameTag = null;
        this.state = 'dead';
      }
    }
  }

  /**
   * @param {number} delta
   * @param {THREE.Vector3} playerPos
   * @param {{ hidden: boolean, active?: boolean, playerSprinting: boolean, playerMoving: boolean }} opts
   * @param {(dmg: number) => void} onAttack — called when Bob lands a hit.
   */
  update(delta, playerPos, opts, onAttack) {
    if (!this.mesh || this.state === 'dead') return;
    // Keep the collision box glued to the mesh (one frame behind the pose
    // changes below — same staleness contract as the TV collider).
    this.updateCollider();
    // Pre-game: completely idle and stationary — no animation ticking,
    // no tracking, no rotation, no movement. (Dying still plays out if
    // somehow triggered, so that branch stays below this gate.)
    if (opts.active === false && this.state !== 'dying') {
      this.state = 'idle';
      return;
    }
    // Only tick animation when near player (saves 8 mixers)
    const _d = playerPos ? playerPos.distanceTo(this.mesh.position) : 0;
    const _near = _d < 18;
    if (this.mixer && _near) this.mixer.update(delta);
    if (this.state === 'dying') {
      this.updateDeath(delta);
      return;
    }

    if (this.attackTimer > 0) this.attackTimer -= delta;

    // Vacuum hiding: possessed player is untrackable — Bob idles in place.
    if (opts.hidden) {
      this.state = 'idle';
      this.updateNameTagPos();
      return;
    }

    const bp = this.mesh.position;
    const dx = playerPos.x - bp.x;
    const dz = playerPos.z - bp.z;
    const distXZ = Math.sqrt(dx * dx + dz * dz);

    if (distXZ > this.aggroRange) {
      this.state = 'idle';
      // Skip nameTag pos update when far (sprite offscreen)
      if (_near) this.updateNameTagPos();
      return;
    }

    // Face the player smoothly (body yaw + optional head assist).
    const desiredYaw = Math.atan2(dx, dz);
    const cur = this.mesh.rotation.y;
    let diff = (desiredYaw - cur) % (Math.PI * 2);
    if (diff > Math.PI) diff -= Math.PI * 2;
    if (diff < -Math.PI) diff += Math.PI * 2;
    this.mesh.rotation.y = Bob.angleLerp(cur, desiredYaw, this.turnSpeed * delta);
    if (this.headBone) {
      // Head leads the turn slightly, clamped so the neck never snaps.
      this.headBone.rotation.y = THREE.MathUtils.clamp(diff * 0.6, -0.7, 0.7);
    }

    // Attack in range.
    if (distXZ <= this.attackRange) {
      this.state = 'attack';
      if (this.attackTimer <= 0) {
        this.attackTimer = this.attackCooldown;
        if (onAttack) onAttack(this.attackDamage);
      }
      this.updateNameTagPos();
      return;
    }

    // Chase — but only moves once roughly facing the player (turn-first).
    this.state = 'chase';
    if (Math.abs(diff) < this.faceThreshold) {
      let speed = this.baseSpeed;
      // Player sprinting away: Bob is slower and gets left behind.
      if (opts.playerSprinting && opts.playerMoving) speed *= 0.55;
      else if (distXZ > this.aggroRange * 0.6) speed *= 0.75;
      this._dir.set(Math.sin(this.mesh.rotation.y), 0, Math.cos(this.mesh.rotation.y));
      bp.x += this._dir.x * speed * delta;
      bp.z += this._dir.z * speed * delta;
      if (this.floorMin && this.floorMax) {
        bp.x = Math.max(this.floorMin.x, Math.min(this.floorMax.x, bp.x));
        bp.z = Math.max(this.floorMin.z, Math.min(this.floorMax.z, bp.z));
      }
      const floorY = this.groundYAt(bp.x, bp.y, bp.z, bp.y);
      if (floorY !== null) bp.y = floorY;
    }
    this.updateNameTagPos();
  }
}

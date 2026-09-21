import * as THREE from 'three';

// Scratch vector for throw-momentum math (avoids per-throw allocation).
const _throwBoost = new THREE.Vector3();
// Scratch ray values reused every frame (Raycaster.set copies them in).
const _DOWN = new THREE.Vector3(0, -1, 0);
const _rayO = new THREE.Vector3();

/**
 * Volleyball — bouncy pickup ball placed near the TV.
 *
 * - Free physics: gravity, floor bounce (restitution), wall bounce,
 *   friction/rolling, player push, TV-obstacle bounce.
 * - Carried: attached to the camera (single-item inventory in main.js).
 * - Thrown: released with camera direction + player momentum so it keeps
 *   flying instead of dropping straight down.
 * - Out of bounds: teleports back to its original spawn position.
 */
export class Volleyball {
  constructor(scene, roomMesh = null) {
    this.scene = scene;
    this.roomMesh = roomMesh;
    this.mesh = null;

    this.isCarried = false;
    this.velocity = new THREE.Vector3();
    this.spawnPos = new THREE.Vector3();
    this.hasSpawn = false;
    // Post-release grace: the hand sits inside player-collision range, so
    // player shoves are ignored briefly after a throw (no snap/kick).
    this.releaseGrace = 0;

    this.radius = 0.15;
    // Heavy ball feel: 3.6x mass makes pushes, rolls, and throws weightier.
    this.mass = 3.6;
    // Strong gravity gives thrown balls a sharp, weighty downward arc
    // instead of floating or traveling too far.
    this.gravity = 34.0;
    this.restitution = 0.6;
    this.airDrag = 0.08;
    this.groundFriction = 4.5;
    this.stopEpsilon = 0.35;
    // Vertical distance from the mesh origin down to the model's lowest
    // point — the ball rests at floorY + groundOffset (never clipping).
    this.groundOffset = 0.15;

    this.floorMin = new THREE.Vector3();
    this.floorMax = new THREE.Vector3();
    this.obstacles = [];
    this.playerRadius = 0.4;

    this._raycaster = new THREE.Raycaster();
    this._obbM = new THREE.Matrix3();
    this._obbV = new THREE.Vector3();
  }

  setMesh(mesh) {
    this.mesh = mesh;
    // Measure collision bounds from the model so physics matches the visual.
    // Horizontal radius covers walls/obstacles/player; groundOffset covers
    // the floor rest height (handles any model origin, e.g. origin-at-base).
    const box = new THREE.Box3().setFromObject(mesh);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    // Recenter the model on the group origin: the ball's GLTF origin sits
    // at its base, so rolling rotation swung the sphere below the floor.
    // With the origin at the bounding-box center, spins stay in place and
    // the bottom rests exactly at origin - halfHeight (absolutely solid).
    mesh.updateMatrixWorld(true);
    const localCenter = mesh.worldToLocal(center.clone());
    for (const child of mesh.children) child.position.sub(localCenter);
    // Keep the visual exactly where it was: move the group origin to the
    // old bounding-box center. Bottom now rests at origin - halfHeight.
    mesh.position.copy(center);
    mesh.updateMatrixWorld(true);
    this.radius = Math.max(size.x, size.z) * 0.5 || 0.15;
    this.groundOffset = Math.max(0.01, size.y * 0.5) || 0.15;
    // Remember the original spawn for out-of-bounds respawn.
    this.spawnPos.copy(mesh.position);
    this.hasSpawn = true;
    this.velocity.set(0, 0, 0);
  }

  setRoomMesh(roomMesh) {
    this.roomMesh = roomMesh;
  }

  setFloorBounds(min, max) {
    this.floorMin.copy(min);
    this.floorMax.copy(max);
  }

  addObstacle(box) {
    this.obstacles.push(box);
  }

  floorYAt(x, z, fallbackY) {
    return this.floorMin ? this.floorMin.y : fallbackY;
  }

  respawn() {
    if (!this.mesh || !this.hasSpawn) return;
    this.mesh.position.copy(this.spawnPos);
    this.velocity.set(0, 0, 0);
  }

  isOutOfBounds() {
    if (!this.mesh || !this.hasSpawn) return false;
    const p = this.mesh.position;
    const margin = 1.5;
    if (
      p.x < this.floorMin.x - margin ||
      p.x > this.floorMax.x + margin ||
      p.z < this.floorMin.z - margin ||
      p.z > this.floorMax.z + margin ||
      p.y < this.floorMin.y - 10
    ) {
      return true;
    }
    return false;
  }

  pickup(camera) {
    if (!this.mesh || this.isCarried) return false;
    if (camera.position.distanceTo(this.mesh.position) >= 3.0) return false;
    this.isCarried = true;
    this.releaseGrace = 0;
    this.velocity.set(0, 0, 0);
    camera.add(this.mesh);
    this.mesh.position.set(0.55, -0.45, -1.1);
    this.mesh.rotation.set(0, 0, 0);
    return true;
  }

  /**
   * Throw toward the exact crosshair target: releases smoothly from the
   * hand's current world position (zero teleport) with a velocity aimed
   * from the hand through the distant crosshair point, so the arc is
   * predictable and converges onto the aim ray. Only a small capped share
   * of horizontal player momentum is added, so the launch never veers off.
   */
  throwBall(camera, playerVel) {
    if (!this.mesh || !this.isCarried) return;
    camera.updateMatrixWorld(true);
    const camDir = new THREE.Vector3();
    camera.getWorldDirection(camDir);
    camDir.normalize();
    // Exact hand position while still attached (matrices fresh, no snap).
    const start = new THREE.Vector3();
    this.mesh.getWorldPosition(start);
    this.isCarried = false;
    this.scene.add(this.mesh);
    this.mesh.position.copy(start);
    this.mesh.rotation.set(0, 0, 0);
    this.mesh.updateMatrixWorld(true);
    // Aim from the hand through a far point on the crosshair ray.
    const aim = new THREE.Vector3().copy(camera.position).addScaledVector(camDir, 30);
    const dir = aim.sub(start).normalize();
    const THROW_SPEED = 12.0;
    this.velocity.copy(dir).multiplyScalar(THROW_SPEED);
    // Heavy ball: only a fraction of the player's run momentum transfers.
    if (playerVel) {
      _throwBoost.set(playerVel.x, 0, playerVel.z).multiplyScalar(0.25 / this.mass);
      if (_throwBoost.length() > 2.0) _throwBoost.setLength(2.0);
      this.velocity.add(_throwBoost);
    }
    // Hard cap so throws stay on-aim instead of flying too far.
    if (this.velocity.length() > 16) this.velocity.setLength(16);
    // Brief immunity to player shoves so the release isn't kicked off-aim.
    // (No obstacle snap here either — per-frame resolution eases out gently.)
    this.releaseGrace = 0.3;
  }

  /** Kick/push when the player walks into the free ball. */
  resolvePlayerCollision(playerPos, playerVel) {
    if (!this.mesh || this.isCarried) return;
    const pos = this.mesh.position;
    const minDist = this.radius + this.playerRadius;
    const dx = pos.x - playerPos.x;
    const dz = pos.z - playerPos.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    const verticallyNear = Math.abs(pos.y - (playerPos.y - 1.0)) < 1.2;
    if (dist < minDist && verticallyNear) {
      let nx = dx;
      let nz = dz;
      let d = dist;
      if (d < 1e-4) {
        nx = 1;
        nz = 0;
        d = 1;
      }
      nx /= d;
      nz /= d;
      pos.x = playerPos.x + nx * minDist;
      pos.z = playerPos.z + nz * minDist;
      // Heavy ball (3.6x mass): player shoves transfer far less velocity,
      // so it feels weighty to push and kick around.
      const push = 3.0 / this.mass;
      this.velocity.x += nx * push + (playerVel ? (playerVel.x * 0.6) / this.mass : 0);
      this.velocity.z += nz * push + (playerVel ? (playerVel.z * 0.6) / this.mass : 0);
      if (this.velocity.y < 1.0) this.velocity.y += 0.8 / this.mass;
    }
  }

  resolveObstacleCollisions() {
    if (!this.mesh) return;
    const pos = this.mesh.position;
    for (const box of this.obstacles) {
      if (box.isEmpty && box.isEmpty()) continue;
      // Oriented box (e.g. the TV's live collider, which rotates with the
      // mesh when shot): circle-vs-OBB in the box's local frame.
      if (box.halfSize !== undefined) {
        this.resolveObbCollision(pos, box);
        continue;
      }
      if (pos.y > box.max.y || pos.y + this.radius < box.min.y) continue;
      const closestX = Math.max(box.min.x, Math.min(pos.x, box.max.x));
      const closestZ = Math.max(box.min.z, Math.min(pos.z, box.max.z));
      let dx = pos.x - closestX;
      let dz = pos.z - closestZ;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < this.radius) {
        if (dist < 1e-4) {
          const pushLeft = pos.x - (box.min.x - this.radius);
          const pushRight = box.max.x + this.radius - pos.x;
          const pushBack = pos.z - (box.min.z - this.radius);
          const pushFront = box.max.z + this.radius - pos.z;
          const m = Math.min(pushLeft, pushRight, pushBack, pushFront);
          if (m === pushLeft) {
            pos.x = box.min.x - this.radius;
            this.velocity.x = -Math.abs(this.velocity.x) * this.restitution;
          } else if (m === pushRight) {
            pos.x = box.max.x + this.radius;
            this.velocity.x = Math.abs(this.velocity.x) * this.restitution;
          } else if (m === pushBack) {
            pos.z = box.min.z - this.radius;
            this.velocity.z = -Math.abs(this.velocity.z) * this.restitution;
          } else {
            pos.z = box.max.z + this.radius;
            this.velocity.z = Math.abs(this.velocity.z) * this.restitution;
          }
        } else {
          const nx = dx / dist;
          const nz = dz / dist;
          pos.x = closestX + nx * this.radius;
          pos.z = closestZ + nz * this.radius;
          const vn = this.velocity.x * nx + this.velocity.z * nz;
          if (vn < 0) {
            this.velocity.x -= (1 + this.restitution) * vn * nx;
            this.velocity.z -= (1 + this.restitution) * vn * nz;
          }
        }
      }
    }
  }

  /**
   * Circle-vs-OBB in XZ with velocity reflection about the world-space
   * contact normal. The rotation matrix is column-major: world.x =
   * e[0]*lx + e[6]*lz, world.z = e[2]*lx + e[8]*lz.
   */
  resolveObbCollision(pos, obb) {
    const hs = obb.halfSize;
    if (hs.x + hs.y + hs.z < 1e-6) return; // collider not initialized yet
    const e = obb.rotation.elements;
    // World-space vertical half-extent for the overlap check.
    const ey = Math.abs(e[1]) * hs.x + Math.abs(e[4]) * hs.y + Math.abs(e[7]) * hs.z;
    if (pos.y > obb.center.y + ey || pos.y + this.radius < obb.center.y - ey) return;
    this._obbM.copy(obb.rotation).transpose();
    this._obbV.subVectors(pos, obb.center).applyMatrix3(this._obbM);
    const cx = Math.max(-hs.x, Math.min(this._obbV.x, hs.x));
    const cz = Math.max(-hs.z, Math.min(this._obbV.z, hs.z));
    const dx = this._obbV.x - cx;
    const dz = this._obbV.z - cz;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist >= this.radius) return;
    let nx;
    let nz;
    if (dist < 1e-4) {
      // Center inside the footprint: least-penetration local axis to world.
      const px = hs.x - Math.abs(this._obbV.x) + this.radius;
      const pz = hs.z - Math.abs(this._obbV.z) + this.radius;
      let lx = 0;
      let lz = 0;
      if (px <= pz) lx = this._obbV.x >= 0 ? px : -px;
      else lz = this._obbV.z >= 0 ? pz : -pz;
      nx = e[0] * lx + e[6] * lz;
      nz = e[2] * lx + e[8] * lz;
      const nl = Math.sqrt(nx * nx + nz * nz) || 1;
      nx /= nl;
      nz /= nl;
      // Push fully out along the normal (penetration + radius included).
      const pen = px <= pz ? px : pz;
      pos.x += nx * pen;
      pos.z += nz * pen;
    } else {
      nx = (e[0] * dx + e[6] * dz) / dist;
      nz = (e[2] * dx + e[8] * dz) / dist;
      pos.x = obb.center.x + (e[0] * cx + e[6] * cz) + nx * this.radius;
      pos.z = obb.center.z + (e[2] * cx + e[8] * cz) + nz * this.radius;
    }
    const vn = this.velocity.x * nx + this.velocity.z * nz;
    if (vn < 0) {
      this.velocity.x -= (1 + this.restitution) * vn * nx;
      this.velocity.z -= (1 + this.restitution) * vn * nz;
    }
  }

  update(delta, playerPos, playerVel) {
    if (!this.mesh || this.isCarried) return;
    if (this.isOutOfBounds()) {
      this.respawn();
      return;
    }
    // Tick down post-throw immunity to player shoves.
    if (this.releaseGrace > 0) this.releaseGrace -= delta;
    // The floor is static within a frame: raycast once and reuse the
    // height across all substeps instead of raycasting per substep.
    const pos = this.mesh.position;
    const floorY = this.floorYAt(pos.x, pos.z, this.floorMin.y);
    const restY = floorY + this.groundOffset;
    // Substep integration so fast throws can't tunnel through the floor.
    const steps = 3;
    const h = delta / steps;
    for (let i = 0; i < steps; i++) {
      this.velocity.y -= this.gravity * h;
      this.velocity.multiplyScalar(Math.max(0, 1 - this.airDrag * h));

      pos.addScaledVector(this.velocity, h);

      // Floor rest: the model's lowest point sits exactly on the surface.
      if (pos.y < restY) {
        pos.y = restY;
        if (Math.abs(this.velocity.y) > 1.2) {
          this.velocity.y = -this.velocity.y * this.restitution;
        } else {
          this.velocity.y = 0;
        }
        // Heavier rolling resistance on the ground.
        const f = Math.max(0, 1 - this.groundFriction * h);
        this.velocity.x *= f;
        this.velocity.z *= f;
        if (this.velocity.length() < this.stopEpsilon) this.velocity.set(0, 0, 0);
      }

      // Wall bounce inside padded platform bounds.
      if (pos.x - this.radius < this.floorMin.x) {
        pos.x = this.floorMin.x + this.radius;
        this.velocity.x = Math.abs(this.velocity.x) * this.restitution;
      } else if (pos.x + this.radius > this.floorMax.x) {
        pos.x = this.floorMax.x - this.radius;
        this.velocity.x = -Math.abs(this.velocity.x) * this.restitution;
      }
      if (pos.z - this.radius < this.floorMin.z) {
        pos.z = this.floorMin.z + this.radius;
        this.velocity.z = Math.abs(this.velocity.z) * this.restitution;
      } else if (pos.z + this.radius > this.floorMax.z) {
        pos.z = this.floorMax.z - this.radius;
        this.velocity.z = -Math.abs(this.velocity.z) * this.restitution;
      }
    }

    // Final safety clamp: never rest below the surface.
    if (pos.y < restY) pos.y = restY;

    this.resolveObstacleCollisions();
    // No player shove during release grace — the hand starts inside
    // collision range and would otherwise kick/teleport the throw.
    if (this.releaseGrace <= 0) this.resolvePlayerCollision(playerPos, playerVel);

    // Rolling look: spin proportional to horizontal speed.
    const hSpeed = Math.sqrt(
      this.velocity.x * this.velocity.x + this.velocity.z * this.velocity.z
    );
    if (hSpeed > 0.1) {
      this.mesh.rotation.x += (hSpeed / Math.max(this.radius, 0.01)) * delta;
      this.mesh.rotation.y += delta * 0.8;
    }

    if (this.isOutOfBounds()) this.respawn();
  }
}

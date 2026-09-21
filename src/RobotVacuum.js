import * as THREE from 'three';

// Shared scratch values (Raycaster.set copies them; avoids per-frame allocs).
const _DOWN = new THREE.Vector3(0, -1, 0);

/**
 * RobotVacuum — roaming robotic vacuum AI controller.
 *
 * Behaviors:
 *  - cleaning: wander between random targets inside the floor bounding box
 *    at 0.5x speed (slow).
 *  - following: slowly follow the player when within followDistance.
 *  - circling: when right below the player, drive a HALF circle (PI radians)
 *    around the player while following them — the orbit center tracks the
 *    player but the robot drives at its own speed (no magic sticking).
 *  - cooldown: after circling, completely ignore the player and keep cleaning
 *    for 15 seconds before detecting the player again.
 *  - carried: picked up by the player (E key), skips all AI updates.
 */
export class RobotVacuum {
  constructor(scene, roomMesh = null) {
    this.scene = scene;
    this.roomMesh = roomMesh;

    this.mesh = null;
    this.state = 'cleaning';
    this.isCarried = false;
    // Possession mode: player directly drives the robot (main.js handles
    // movement); AI update is suspended and pickup is blocked.
    this.isPossessed = false;
    // Thrown-flight state: launched with momentum, tumbles mid-air under
    // gravity, then lands flat/upright and resumes cleaning AI.
    this.isFlying = false;
    this.velocity = new THREE.Vector3();
    this.angularVelocity = new THREE.Vector3();
    // Heavy downward arc for thrown flight — sharp and weighty, no floating.
    this.flyGravity = 34.0;
    // AI state suspended while carried. Pickup/drop never resets timers —
    // the 15s cooldown (and half-circle) continue uninterrupted (see update).
    this.suspendedState = null;

    // 0.5x speed: original base was 2.5, halved to 1.25.
    this.robotSpeed = 1.25;
    this.followDistance = 5.0;
    this.circleTriggerDistance = 1.5; // horizontal XZ distance to start circling
    this.circleRadius = 1.2;
    // Half-circle orbit: primary exit is swept angle >= PI (~3s at this
    // speed).
    this.circleDuration = 8.0;
    this.cooldownDuration = 15.0; // ignore period in seconds
    this.circleCenter = new THREE.Vector3();
    this.circleSwept = 0;
    this.circleInterrupted = false;
    this.circleResume = false;

    this.target = new THREE.Vector3();
    this.floorBox = new THREE.Box3();
    this.floorMin = new THREE.Vector3();
    this.floorMax = new THREE.Vector3();

    // Dynamic cleaning: procedural dirt layer erased as the robot drives.
    this.dirtLayer = null;
    this.cleanRadius = 0.9;

    // Solid collision data: world-space obstacle boxes (e.g. TV + legs)
    // registered by reference, plus body radii for circle-based resolution.
    this.obstacles = [];
    this.robotRadius = 0.45;
    this.robotHeight = 0.35;
    this.playerRadius = 0.4;

    this.cleaningTimer = 0;
    this.cooldownTimer = 0;
    this.circleTimer = 0;
    this.circleAngle = 0;

    this._raycaster = new THREE.Raycaster();
    this._tmp = new THREE.Vector3();
    this._rayO = new THREE.Vector3();
    this._followDir = new THREE.Vector3();
    this._obbM = new THREE.Matrix3();
    this._obbV = new THREE.Vector3();
  }

  setMesh(mesh) {
    this.mesh = mesh;
    this.pickNewCleaningTarget();
  }

  setRoomMesh(roomMesh) {
    this.roomMesh = roomMesh;
  }

  /** Attach the procedural dirt overlay the robot cleans as it drives. */
  setDirtLayer(layer) {
    this.dirtLayer = layer;
  }

  setFloorBounds(min, max) {
    this.floorMin.copy(min);
    this.floorMax.copy(max);
    this.floorBox.min.copy(min);
    this.floorBox.max.copy(max);
  }

  /** Register a world-space obstacle Box3 (stored by reference). */
  addObstacle(box) {
    this.obstacles.push(box);
  }

  setObstacles(boxes) {
    this.obstacles = boxes;
  }

  /**
   * Push the robot out of any overlapping obstacle box (circle-vs-AABB in XZ).
   * Covers the TV body and its legs since the TV collider spans the whole model.
   * Entries may also be oriented boxes (OBB, duck-typed via `halfSize`) —
   * e.g. the TV's live collider, which rotates with the mesh when shot.
   */
  resolveObstacleCollisions() {
    if (!this.mesh) return;
    const pos = this.mesh.position;
    for (const box of this.obstacles) {
      if (box.isEmpty && box.isEmpty()) continue;
      if (box.halfSize !== undefined) {
        this.resolveObbCollision(pos, box);
        continue;
      }
      // Only collide when vertically overlapping (robot occupies pos.y..pos.y+height).
      if (pos.y > box.max.y || pos.y + this.robotHeight < box.min.y) continue;
      const closestX = Math.max(box.min.x, Math.min(pos.x, box.max.x));
      const closestZ = Math.max(box.min.z, Math.min(pos.z, box.max.z));
      let dx = pos.x - closestX;
      let dz = pos.z - closestZ;
      let dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < this.robotRadius) {
        if (dist < 1e-4) {
          // Center inside the box: push out along smallest-penetration axis.
          const pushLeft = pos.x - (box.min.x - this.robotRadius);
          const pushRight = box.max.x + this.robotRadius - pos.x;
          const pushBack = pos.z - (box.min.z - this.robotRadius);
          const pushFront = box.max.z + this.robotRadius - pos.z;
          const m = Math.min(pushLeft, pushRight, pushBack, pushFront);
          if (m === pushLeft) pos.x = box.min.x - this.robotRadius;
          else if (m === pushRight) pos.x = box.max.x + this.robotRadius;
          else if (m === pushBack) pos.z = box.min.z - this.robotRadius;
          else pos.z = box.max.z + this.robotRadius;
        } else {
          const push = (this.robotRadius - dist) / dist;
          pos.x += dx * push;
          pos.z += dz * push;
        }
        pos.x = Math.max(this.floorMin.x, Math.min(this.floorMax.x, pos.x));
        pos.z = Math.max(this.floorMin.z, Math.min(this.floorMax.z, pos.z));
      }
    }
  }

  /**
   * Circle-vs-OBB in XZ: transforms the robot into the box's local frame
   * (rotation is orthonormal, so the transpose is the inverse), resolves
   * there, and pushes back in world space. The rotation matrix is
   * column-major: world.x = e[0]*lx + e[6]*lz, world.z = e[2]*lx + e[8]*lz.
   */
  resolveObbCollision(pos, obb) {
    const hs = obb.halfSize;
    if (hs.x + hs.y + hs.z < 1e-6) return; // collider not initialized yet
    const e = obb.rotation.elements;
    // World-space vertical half-extent for the overlap check.
    const ey = Math.abs(e[1]) * hs.x + Math.abs(e[4]) * hs.y + Math.abs(e[7]) * hs.z;
    if (pos.y > obb.center.y + ey || pos.y + this.robotHeight < obb.center.y - ey) return;
    this._obbM.copy(obb.rotation).transpose();
    this._obbV.subVectors(pos, obb.center).applyMatrix3(this._obbM);
    const cx = Math.max(-hs.x, Math.min(this._obbV.x, hs.x));
    const cz = Math.max(-hs.z, Math.min(this._obbV.z, hs.z));
    const dx = this._obbV.x - cx;
    const dz = this._obbV.z - cz;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist >= this.robotRadius) return;
    if (dist < 1e-4) {
      // Center inside the footprint: least-penetration local axis to world.
      const px = hs.x - Math.abs(this._obbV.x) + this.robotRadius;
      const pz = hs.z - Math.abs(this._obbV.z) + this.robotRadius;
      let lx = 0;
      let lz = 0;
      if (px <= pz) lx = this._obbV.x >= 0 ? px : -px;
      else lz = this._obbV.z >= 0 ? pz : -pz;
      pos.x += e[0] * lx + e[6] * lz;
      pos.z += e[2] * lx + e[8] * lz;
    } else {
      const push = (this.robotRadius - dist) / dist;
      pos.x += (e[0] * dx + e[6] * dz) * push;
      pos.z += (e[2] * dx + e[8] * dz) * push;
    }
    pos.x = Math.max(this.floorMin.x, Math.min(this.floorMax.x, pos.x));
    pos.z = Math.max(this.floorMin.z, Math.min(this.floorMax.z, pos.z));
  }

  /**
   * Keep the robot from clipping through the player: enforce a minimum
   * XZ separation (block / bounce off) by pushing the robot out.
   */
  resolvePlayerCollision(playerPos) {
    if (!this.mesh) return;
    const pos = this.mesh.position;
    const minDist = this.robotRadius + this.playerRadius;
    const dx = pos.x - playerPos.x;
    const dz = pos.z - playerPos.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < minDist) {
      if (dist < 1e-4) {
        pos.x = playerPos.x + minDist;
      } else {
        const push = (minDist - dist) / dist;
        pos.x += dx * push;
        pos.z += dz * push;
      }
      pos.x = Math.max(this.floorMin.x, Math.min(this.floorMax.x, pos.x));
      pos.z = Math.max(this.floorMin.z, Math.min(this.floorMax.z, pos.z));
    }
  }

  groundYAt(x, yRef, z) {
    // Flat floor fast path - cached y from floor bounds
    if (this.floorMin) return this.floorMin.y;
    return null;
  }

  pickNewCleaningTarget() {
    if (!this.mesh) return;
    const rx = THREE.MathUtils.randFloat(this.floorMin.x, this.floorMax.x);
    const rz = THREE.MathUtils.randFloat(this.floorMin.z, this.floorMax.z);

    // Raycast down to find floor Y at target.
    let targetY = this.mesh.position.y;
    const hitY = this.groundYAt(rx, this.floorMax.y, rz);
    if (hitY !== null) targetY = hitY;
    this.target.set(rx, targetY, rz);
  }

  moveTowardsTarget(delta) {
    const pos = this.mesh.position;
    const dir = this._tmp.subVectors(this.target, pos);
    dir.y = 0;
    const distToTarget = dir.length();

    if (distToTarget < 0.5 || this.cleaningTimer > 15.0) {
      this.cleaningTimer = 0;
      this.pickNewCleaningTarget();
    } else {
      this.cleaningTimer += delta;
      dir.normalize();
      pos.addScaledVector(dir, this.robotSpeed * delta);
      this.mesh.rotation.y = Math.atan2(dir.x, dir.z);
    }

    pos.x = Math.max(this.floorMin.x, Math.min(this.floorMax.x, pos.x));
    pos.z = Math.max(this.floorMin.z, Math.min(this.floorMax.z, pos.z));
  }

  startCircling(playerPos) {
    const pos = this.mesh.position;
    this.circleTimer = 0;
    // Resume existing progress if circle interrupted, otherwise restart.
    if (!this.circleResume) {
      this.circleSwept = 0;
      this.circleAngle = Math.atan2(pos.z - playerPos.z, pos.x - playerPos.x);
    }
    // Orbit center starts on the player; it tracks them each frame.
    this.circleCenter.set(playerPos.x, pos.y, playerPos.z);
    this.state = 'circling';
    this.circleInterrupted = false;
  }

  update(delta, playerPos) {
    if (!this.mesh) return;
    if (this.isPossessed) return;
    if (this.isCarried) {
      // Pause circling if player carries the robot.
      if (this.state === 'circling') {
        this.circleInterrupted = true;
        this.circleResume = true;
      }
      return;
    }

    // Thrown flight: gravity arc + natural tumble, then snap flat/upright
    // on touchdown so cleaning resumes smoothly.
    if (this.isFlying) {
      this.updateFlight(delta);
      return;
    }

    const pos = this.mesh.position;
    const dx = pos.x - playerPos.x;
    const dz = pos.z - playerPos.z;
    const distXZ = Math.sqrt(dx * dx + dz * dz);

    switch (this.state) {
      case 'cleaning': {
        if (distXZ <= this.circleTriggerDistance) {
          this.startCircling(playerPos);
          break;
        }
        if (distXZ < this.followDistance) {
          this.state = 'following';
          break;
        }
        this.moveTowardsTarget(delta);
        break;
      }

      case 'following': {
        if (distXZ <= this.circleTriggerDistance) {
          this.startCircling(playerPos);
          break;
        }
        if (distXZ > this.followDistance * 1.5) {
          this.state = 'cleaning';
          this.pickNewCleaningTarget();
          break;
        }
        const followDir = this._followDir.subVectors(playerPos, pos);
        followDir.y = 0;
        followDir.normalize();
        pos.addScaledVector(followDir, this.robotSpeed * 0.7 * delta);
        if (followDir.lengthSq() > 0.001) {
          this.mesh.rotation.y = Math.atan2(followDir.x, followDir.z);
        }
        break;
      }

      case 'circling': {
        // Interruption check: player ran away.
        if (distXZ > this.circleTriggerDistance * 1.8) {
          this.state = 'cleaning';
          this.circleInterrupted = true;
          this.circleResume = true;
          this.pickNewCleaningTarget();
          break;
        }

        // Half-circle orbit that FOLLOWS the player.
        const angularSpeed = this.robotSpeed / this.circleRadius;
        const angleStep = angularSpeed * delta;
        this.circleAngle += angleStep;
        this.circleSwept += Math.abs(angleStep);
        this.circleTimer += delta;
        if (this.circleSwept >= Math.PI || this.circleTimer >= this.circleDuration) {
          this.state = 'cooldown';
          this.cooldownTimer = 0;
          this.circleResume = false;
          this.pickNewCleaningTarget();
          break;
        }
        // Follow the player.
        const followX = playerPos.x - this.circleCenter.x;
        const followZ = playerPos.z - this.circleCenter.z;
        pos.x += followX;
        pos.z += followZ;
        this.circleCenter.x = playerPos.x;
        this.circleCenter.z = playerPos.z;

        // Orbit target on the half-circle path.
        const targetX = this.circleCenter.x + Math.cos(this.circleAngle) * this.circleRadius;
        const targetZ = this.circleCenter.z + Math.sin(this.circleAngle) * this.circleRadius;
        const toX = targetX - pos.x;
        const toZ = targetZ - pos.z;
        const distToOrbit = Math.sqrt(toX * toX + toZ * toZ);
        if (distToOrbit > 1e-4) {
          const maxStep = this.robotSpeed * delta;
          const t = Math.min(1, maxStep / distToOrbit);
          pos.x += toX * t;
          pos.z += toZ * t;
          if (distToOrbit > 0.05) this.mesh.rotation.y = Math.atan2(toX, toZ);
        }
        pos.x = Math.max(this.floorMin.x, Math.min(this.floorMax.x, pos.x));
        pos.z = Math.max(this.floorMin.z, Math.min(this.floorMax.z, pos.z));
        break;
      }

      case 'cooldown': {
        this.cooldownTimer += delta;
        this.moveTowardsTarget(delta);
        if (this.cooldownTimer >= this.cooldownDuration) {
          this.state = 'cleaning';
          this.pickNewCleaningTarget();
        }
        break;
      }

      default:
        break;
    }

    // Solid interactions: never clip through obstacles or the player.
    this.resolvePlayerCollision(playerPos);
    this.resolveObstacleCollisions();

    // Keep robot locked to floor height.
    const floorY = this.groundYAt(pos.x, pos.y, pos.z);
    if (floorY !== null) pos.y = floorY;

    // Dynamic cleaning: restore pristine tiles under/in the robot's path.
    if (this.dirtLayer && !this.isCarried) {
      this.dirtLayer.cleanAt(pos.x, pos.z, this.cleanRadius);
    }
  }

  /**
   * Airborne flight step: gravity arc + tumble. On touchdown the robot
   * snaps flat/upright on its base and resumes its suspended AI state.
   * Substepped so fast throws can't tunnel through the floor.
   */
  updateFlight(delta) {
    // Floor is static within a frame: raycast once up front.
    const pos = this.mesh.position;
    const floorY = this.groundYAt(pos.x, pos.y, pos.z);
    const steps = 3;
    const h = delta / steps;
    for (let i = 0; i < steps; i++) {
      this.velocity.y -= this.flyGravity * h;
      pos.addScaledVector(this.velocity, h);
      this.mesh.rotation.x += this.angularVelocity.x * h;
      this.mesh.rotation.z += this.angularVelocity.z * h;
      this.mesh.rotation.y += this.angularVelocity.y * h;

      // Wall clamp with a soft bounce while airborne.
      pos.x = Math.max(this.floorMin.x, Math.min(this.floorMax.x, pos.x));
      pos.z = Math.max(this.floorMin.z, Math.min(this.floorMax.z, pos.z));

      // Landing check (robot origin sits at its base).
      if (floorY !== null && pos.y <= floorY && this.velocity.y <= 0) {
        pos.y = floorY;
        this.isFlying = false;
        this.velocity.set(0, 0, 0);
        this.angularVelocity.set(0, 0, 0);
        // Always land flat and upright on its base; keep the landing yaw.
        const yaw = this.mesh.rotation.y;
        this.mesh.rotation.set(0, yaw, 0);
        this.state = this.suspendedState || 'cleaning';
        this.suspendedState = null;
        this.resolveObstacleCollisions();
        this.pickNewCleaningTarget();
        return;
      }
    }
    // Safety clamp: never sink below the surface mid-flight.
    if (floorY !== null && pos.y < floorY) pos.y = floorY;
  }

  /**
   * Throw the carried vacuum toward the exact crosshair target: releases
   * smoothly from the hand's current world position (zero teleport) with a
   * velocity aimed from the hand through the distant crosshair point, plus
   * a small capped share of horizontal player momentum.
   */
  throwVacuum(camera, playerVel) {
    if (!this.mesh || !this.isCarried) return;
    camera.updateMatrixWorld(true);
    const camDir = new THREE.Vector3();
    camera.getWorldDirection(camDir);
    camDir.normalize();
    // Exact hand position while still attached (matrices fresh, no snap).
    const start = new THREE.Vector3();
    this.mesh.getWorldPosition(start);
    this.isCarried = false;
    // AI state restores on landing (see updateFlight), not here.
    this.scene.add(this.mesh);
    this.mesh.position.copy(start);
    this.mesh.updateMatrixWorld(true);
    // Aim from the hand through a far point on the crosshair ray.
    const aim = new THREE.Vector3().copy(camera.position).addScaledVector(camDir, 30);
    const dir = aim.sub(start).normalize();
    const THROW_SPEED = 10.0;
    this.velocity.copy(dir).multiplyScalar(THROW_SPEED);
    if (playerVel) {
      this._tmp.set(playerVel.x, 0, playerVel.z).multiplyScalar(0.2);
      if (this._tmp.length() > 2.5) this._tmp.setLength(2.5);
      this.velocity.add(this._tmp);
    }
    if (this.velocity.length() > 15) this.velocity.setLength(15);
    // Natural tumble/flip while airborne (randomized direction).
    const flip = 4.0 + Math.random() * 3.0;
    this.angularVelocity.set(
      flip * (Math.random() < 0.5 ? -1 : 1),
      (Math.random() - 0.5) * 2.0,
      flip * (Math.random() < 0.5 ? -1 : 1)
    );
    this.isFlying = true;
  }

  /**
   * Try to pick up the vacuum. Returns true on success.
   * Preserves the current AI state + all timers so the 15s cooldown
   * (and half-circle) continue uninterrupted while carried.
   */
  pickup(camera) {
    if (!this.mesh || this.isCarried || this.isFlying || this.isPossessed) return false;
    if (camera.position.distanceTo(this.mesh.position) >= 3.0) return false;
    this.suspendedState = this.state === 'carried' ? this.suspendedState : this.state;
    this.isCarried = true;
    this.state = 'carried';
    camera.add(this.mesh);
    this.mesh.position.set(0.6, -0.5, -1.2);
    this.mesh.rotation.set(0, 0, 0);
    return true;
  }

  /**
   * Drop the vacuum ~2m in front of the player onto the floor.
   * Restores the suspended AI state and leaves cooldown/circle/cleaning
   * timers untouched — the 15s ignore timer continues uninterrupted.
   */
  drop(camera, raycaster) {
    if (!this.mesh || !this.isCarried) return;
    this.isCarried = false;
    this.state = this.suspendedState || 'cleaning';
    this.suspendedState = null;
    this.scene.add(this.mesh);

    const camDir = new THREE.Vector3();
    camera.getWorldDirection(camDir);
    camDir.y = 0;
    camDir.normalize();

    const dropPos = camera.position.clone().addScaledVector(camDir, 2.0);
    raycaster.set(this._rayO.set(dropPos.x, dropPos.y + 5.0, dropPos.z), _DOWN);
    if (this.roomMesh) {
      const hits = raycaster.intersectObject(this.roomMesh, true);
      if (hits.length > 0) dropPos.y = hits[0].point.y;
    }
    // Clamp drop inside floor bounds.
    dropPos.x = Math.max(this.floorMin.x, Math.min(this.floorMax.x, dropPos.x));
    dropPos.z = Math.max(this.floorMin.z, Math.min(this.floorMax.z, dropPos.z));
    this.mesh.position.copy(dropPos);
    // Keep the drop from spawning inside an obstacle (e.g. TV/legs).
    this.resolveObstacleCollisions();
    // NOTE: intentionally no timer resets and no pickNewCleaningTarget() here —
    // the AI resumes exactly where its uninterrupted timers say it should be.
  }
}

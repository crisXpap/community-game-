import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js';
import { OBB } from 'three/examples/jsm/math/OBB.js';
import { RobotVacuum } from './RobotVacuum.js';
import { Volleyball } from './Ball.js';
import { DirtLayer } from './DirtLayer.js';
import { Bob } from './Bob.js';
import {
  initMobileControls,
  mobileMove,
  mobileState,
} from './mobileControls.js';

let camera, scene, renderer, controls;
let roomMesh = null;
let dirtLayer = null;
const raycaster = new THREE.Raycaster();
let cachedFloorY = 0; // flat floor assumption - avoids per-frame raycasts

const vacuum = new RobotVacuum(null, null);
const ball = new Volleyball(null, null);
const bob = new Bob(null, null);
const bobs = [bob]; // 8 total Bobs spread around the map
// --- Edible pie pickups: 7 scattered heal items, +180 HP each ---
const pies = []; // { mesh, eaten }
const PIE_COUNT = 7;
const PIE_HEAL = 180;
// --- Shootable leaves: forest of leaf.glb, 3 hits each, shake on hit, Bob-style death ---
// PERF: leaves render as ONE InstancedMesh (1 draw call for all 2385) with
// shared geometry/material, so +500 leaves costs ~zero CPU (no per-leaf
// objects, materials, or matrix updates while static). Original look is
// restored via per-instance size/rotation/tint variety (no material clones).
const leaves = []; // { index, hitsTaken, maxHits, shake, state, deathTimer, ... }
const LEAF_COUNT = 2385; // 985 original + 500 + 400 + 500 more
const LEAF_SURVIVORS = 100; // bomb wipe always leaves this many alive
const LEAF_HITS = 3;
let leafInst = null; // InstancedMesh for the whole forest
const _leafDummy = new THREE.Object3D();
const _leafColor = new THREE.Color();
// --- Decorative trees: forest of tree.glb, 100 instances, same instancing ---
// Bomb blast topples them (they stay lying on the floor — never removed).
const TREE_COUNT = 100;
const treeInstMeshes = []; // one InstancedMesh per source mesh in tree.glb
const trees = []; // { x, z, rotY, s, yOff, state, fallTimer, fallDur, fallAxis, tipX, tipZ, topY }
const _treeDummy = new THREE.Object3D();
const _tipV = new THREE.Vector3();
const TREE_FALL_DUR = 0.9; // seconds to tip over after the blast
const TRUNK_R = 0.45; // trunk half-thickness (local units, × scale) — also the collider radius
let treeHeight = 7.8; // local-space tree height, measured from tree.glb at load
// --- Gifts: 3x gift.glb around the map, E to open, each bursts gold coins ---
const gifts = []; // { mesh, opened }
const GIFT_COUNT = 3;
const GIFT_COINS = 12; // gold coins dropped per gift
const coins = []; // { mesh, vel, spin, settled }
let coinGeo = null;
let coinMat = null;
// --- Explosion particles (Bob 50% death explosion) ---
const explosions = []; // { group, flash, parts: [{mesh, vel}], life, maxLife }
// --- Player health (Bob combat): starts at 500, bottom-middle bar + counter ---
// Styled to match the "E" interaction prompt theme: dark translucent plate,
// thin white border, 'Patrick Hand SC' HUD font with soft glow lettering.
const MAX_PLAYER_HEALTH = 500;
let playerHealth = MAX_PLAYER_HEALTH;
let healthEl = null;
let healthFillEl = null;
let healthLabelEl = null;
function initHealthHUD() {
  if (healthEl) return;
  healthEl = document.createElement('div');
  healthEl.id = 'player-health';
  healthEl.style.cssText =
    'position:fixed;bottom:18px;left:50%;transform:translateX(-50%);' +
    'display:flex;flex-direction:column;align-items:center;gap:4px;' +
    'background:rgba(0,0,0,0.55);border:2px solid rgba(255,255,255,0.35);' +
    'border-radius:10px;padding:8px 18px 10px;z-index:30;pointer-events:none;';
  healthLabelEl = document.createElement('div');
  healthLabelEl.style.cssText =
    "color:#fff;font-family:'Patrick Hand SC',cursive;font-size:18px;" +
    'letter-spacing:2px;white-space:nowrap;' +
    'text-shadow:0 0 8px rgba(255,255,255,0.6),0 1px 2px rgba(0,0,0,0.9);';
  const barTrack = document.createElement('div');
  barTrack.style.cssText =
    'width:220px;height:12px;border-radius:6px;overflow:hidden;' +
    'background:rgba(255,255,255,0.15);border:1px solid rgba(255,255,255,0.35);';
  healthFillEl = document.createElement('div');
  healthFillEl.style.cssText =
    'height:100%;width:100%;border-radius:6px;background:#2ecc71;' +
    'transition:width 0.2s ease,background 0.2s ease;';
  barTrack.appendChild(healthFillEl);
  healthEl.appendChild(healthLabelEl);
  healthEl.appendChild(barTrack);
  document.body.appendChild(healthEl);
  updateHealthHUD();
}
function updateHealthHUD() {
  const clamped = Math.max(0, playerHealth);
  const frac = clamped / MAX_PLAYER_HEALTH;
  if (healthLabelEl) healthLabelEl.textContent = `HP: ${clamped} / ${MAX_PLAYER_HEALTH}`;
  if (healthFillEl) {
    healthFillEl.style.width = `${frac * 100}%`;
    // Green -> amber -> red as health depletes, matching the E-ring accent.
    healthFillEl.style.background = frac > 0.5 ? '#2ecc71' : frac > 0.25 ? '#f39c12' : '#e74c3c';
  }
}
function damagePlayer(amount) {
  if (playerHealth <= 0) return;
  playerHealth -= amount;
  updateHealthHUD();
  // Red flash feedback on hit.
  if (healthEl) {
    healthEl.style.borderColor = '#ff3333';
    setTimeout(() => {
      if (!healthEl) return;
      healthEl.style.borderColor = 'rgba(255,255,255,0.35)';
    }, 150);
  }
  if (playerHealth <= 0) window.location.reload();
}
function healPlayer(amount) {
  if (playerHealth <= 0) return;
  playerHealth = Math.min(MAX_PLAYER_HEALTH, playerHealth + amount);
  updateHealthHUD();
  // Green flash feedback on heal.
  if (healthEl) {
    healthEl.style.borderColor = '#2ecc71';
    setTimeout(() => {
      if (!healthEl) return;
      healthEl.style.borderColor = 'rgba(255,255,255,0.35)';
    }, 250);
  }
}
/** Consume a pie: remove it from the world and restore player health. */
function eatPie(index) {
  const pie = pies[index];
  if (!pie || pie.eaten || !pie.mesh) return;
  pie.eaten = true;
  scene.remove(pie.mesh);
  healPlayer(PIE_HEAL);
  console.log(`Pie eaten — +${PIE_HEAL} HP.`);
}
/** Index of the nearest uneaten pie in range, or -1 when none qualifies. */
function nearestPieIndex() {
  if (!controls.isLocked || isPossessed || isFlying) return -1;
  let best = -1;
  let bestD = PICKUP_RANGE;
  for (let i = 0; i < pies.length; i++) {
    if (pies[i].eaten || !pies[i].mesh) continue;
    const d = camera.position.distanceTo(pies[i].mesh.position);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}
/** Index of the nearest unopened gift in range, or -1 when none qualifies. */
function nearestGiftIndex() {
  if (!controls.isLocked || isPossessed || isFlying) return -1;
  let best = -1;
  let bestD = PICKUP_RANGE;
  for (let i = 0; i < gifts.length; i++) {
    if (gifts[i].opened || !gifts[i].mesh) continue;
    const d = camera.position.distanceTo(gifts[i].mesh.position);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}
/** Open a gift: it vanishes and bursts GIFT_COINS gold coins with physics. */
function openGift(index) {
  const gift = gifts[index];
  if (!gift || gift.opened || !gift.mesh) return;
  gift.opened = true;
  const at = gift.mesh.position.clone();
  at.y += 0.6;
  scene.remove(gift.mesh);
  gift.mesh = null;
  playCoinSound();
  if (!coinGeo) {
    coinGeo = new THREE.CylinderGeometry(0.18, 0.18, 0.045, 24);
  }
  if (!coinMat) {
    coinMat = new THREE.MeshStandardMaterial({
      color: 0xd4af37,
      metalness: 0.9,
      roughness: 0.25,
    });
  }
  for (let i = 0; i < GIFT_COINS; i++) {
    const m = new THREE.Mesh(coinGeo, coinMat);
    m.castShadow = false;
    m.receiveShadow = false;
    m.frustumCulled = true;
    m.position.copy(at);
    const th = Math.random() * Math.PI * 2;
    const push = 1.5 + Math.random() * 3.0;
    m.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
    scene.add(m);
    coins.push({
      mesh: m,
      vel: new THREE.Vector3(
        Math.cos(th) * push,
        4.0 + Math.random() * 4.0,
        Math.sin(th) * push
      ),
      spin: new THREE.Vector3(
        (Math.random() * 2 - 1) * 12,
        (Math.random() * 2 - 1) * 8,
        (Math.random() * 2 - 1) * 12
      ),
      settled: false,
    });
  }
  console.log(`Gift opened — ${GIFT_COINS} gold coins!`);
}
/** Coin physics: burst flight, floor bounce, settle flat, slow idle spin. */
function updateCoins(delta) {
  if (coins.length === 0) return;
  const restY = cachedFloorY + 0.05;
  for (const coin of coins) {
    if (!coin.mesh) continue;
    if (!coin.settled) {
      coin.vel.y -= 18 * delta; // coin gravity
      coin.mesh.position.addScaledVector(coin.vel, delta);
      coin.mesh.rotation.x += coin.spin.x * delta;
      coin.mesh.rotation.y += coin.spin.y * delta;
      coin.mesh.rotation.z += coin.spin.z * delta;
      // Floor bounce on the flat floor, then settle.
      if (coin.mesh.position.y <= restY) {
        coin.mesh.position.y = restY;
        if (Math.abs(coin.vel.y) > 1.5) {
          coin.vel.y *= -0.45;
          coin.vel.x *= 0.7;
          coin.vel.z *= 0.7;
          coin.spin.multiplyScalar(0.6);
        } else {
          coin.settled = true;
          coin.vel = null;
          // Lie flat with a random facing, like a dropped coin.
          coin.mesh.rotation.set(0, Math.random() * Math.PI * 2, 0);
        }
      }
      if (vacuum.floorMin && vacuum.floorMax) {
        coin.mesh.position.x = THREE.MathUtils.clamp(coin.mesh.position.x, vacuum.floorMin.x, vacuum.floorMax.x);
        coin.mesh.position.z = THREE.MathUtils.clamp(coin.mesh.position.z, vacuum.floorMin.z, vacuum.floorMax.z);
      }
      if (coin.mesh.position.y < -10) {
        coin.settled = true;
        coin.vel = null;
        coin.mesh.position.y = restY;
        coin.mesh.rotation.set(0, Math.random() * Math.PI * 2, 0);
      }
    } else {
      // Settled coins glint with a slow spin so they catch the eye.
      coin.mesh.rotation.y += delta * 0.8;
    }
  }
}
// Live player velocity (m/s) — feeds throw momentum so released items
// retain momentum instead of dropping straight down.
const playerVel = new THREE.Vector3();
const _prevPlayerPos = new THREE.Vector3();
let _hasPrevPlayerPos = false;

let moveForward = false;
let moveBackward = false;
let moveLeft = false;
let moveRight = false;
let isGrounded = false;
let isSprinting = false;

// --- Mobile touch controls (src/mobileControls.js) ---
// touchUI is non-null only on touch-capable devices. touchPlaying mirrors
// controls.isLocked: Pointer Lock doesn't exist on mobile, so starting the
// game on touch sets controls.isLocked = true artificially and the touch UI
// becomes visible. All existing isLocked-gated game logic then runs unchanged.
let touchUI = null;
const touchPlaying = { value: false };
function isSprintingNow() {
  return isSprinting || mobileState.sprint;
}

let verticalVelocity = 0;
const gravity = 30.0;
const jumpForce = 9.0;
const walkSpeed = 40.0;
const sprintSpeedMultiplier = 1.8;

let prevTime = performance.now();
let fpsTime = prevTime;
let frameCount = 0;
const fpsElement = document.getElementById('fps');
const velocity = new THREE.Vector3();
const direction = new THREE.Vector3();

// Hold-to-interact (Roblox-style): hold E for exactly 0.75s for all interactions.
const HOLD_DURATION = 0.75;
const PICKUP_RANGE = 3.0;

// Solid player collision data.
const PLAYER_RADIUS = 0.4;
const ROBOT_RADIUS = 0.45;
const TV_SPAWN_DISTANCE = 6.0; // meters directly in front of player spawn
// TV fixing uses the exact same interaction range as the robot (PICKUP_RANGE).
// Solid TV collider: an oriented box (OBB) that rotates with the mesh in
// real time, plus a refreshed axis-aligned broadphase (tvCollider) derived
// from its corners each frame for cheap vertical-overlap checks.
const tvCollider = new THREE.Box3();
const tvObb = new OBB();
const tvLocalBox = new THREE.Box3(); // TV bounds in mesh-local space (constant)
const tvLocalCenter = new THREE.Vector3();
const _tvM4 = new THREE.Matrix4();
const _tvQuat = new THREE.Quaternion();
const _tvInv = new THREE.Matrix3(); // transpose of the OBB rotation (its inverse)
const _tvLocal = new THREE.Vector3();
const _tvPush = new THREE.Vector3();
const _tvCorner = new THREE.Vector3();
let tvColliderReady = false;
let tvMesh = null;
let tvFixed = false;
let tvAudio = null;
let tvAudioError = false; // set when the file itself fails to load (no retry)
let tvRetryTime = 0;
let footAudio = null;
let runAudio = null;
// --- Airstrike button (/models/button.glb) + bomb (/models/bomb.glb) ---
let buttonMesh = null; // world prop 20m in front of the TV, E to press
let bombTemplate = null; // preloaded bomb.glb scene, cloned per strike
let bombMesh = null; // live falling bomb (null when idle/done)
let bombState = 'idle'; // 'idle' | 'falling' | 'done'
let bombTimer = 0;
let bombStartY = 0;
let bombTargetY = 0;
const BOMB_FALL_DUR = 2.0; // fall time; total fall->done sequence ~= 4s
const BOMB_DONE_DUR = 2.0; // explosion linger after impact (2+2 = ~4s of bomb.mp3)
let bombCooldownUntil = 0;
let buttonAudio = null;
let buttonAudioError = false;
let bombAudio = null;
let bombAudioError = false;
let coinAudio = null; // /audio/coin.mp3 — gift-open chime
let coinAudioError = false;
let tvFlattened = false;
let coinFlattened = false;
// --- Player gun (/models/gun.glb): spawns equipped on the right side ---
// Rendered in a dedicated HUD scene (fixed-FOV HUD camera) so it stays
// locked to the exact same screen position regardless of zoom/FOV.
let gunMesh = null;
let gunMuzzle = null; // Object3D at the barrel tip (HUD-space anchor)
let gunEquipped = false; // true while attached to the HUD camera
let gunKick = 0; // recoil spring 0..1, decays per frame
let hudScene = null;
let hudCamera = null;
const HUD_FOV = 50; // fixed: main-camera zoom never touches the gun
const GUN_HIP_POS = new THREE.Vector3(0.22, -0.19, -0.62);
const GUN_SCALE_LEN = 0.55; // normal hand-held length
// Measured from gun.glb vertex data: the barrel line climbs ~0.118 rad
// toward the muzzle, so this counter-pitch lays it flat/level on screen.
const GUN_LEVEL_PITCH = -0.117;
let gunBaseRotY = 0;
let shotAudio = null;
let shotAudioError = false; // set when the file itself fails to load (synth fallback)
let lastShotTime = 0;
const SHOT_COOLDOWN = 0.16; // seconds between shots
// --- TV impact physics: anchored position, single-axis angular kick ---
const tvAngVel = new THREE.Vector3();
let tvBaseY = 0; // locked rest height (TV only rotates, never shifts)
// --- Giant pfp coin (opposite corner from the plane) + "Klint" label ---
let pfpCoin = null; // Group standing upright like a Mario coin
let pfpLabel = null; // Sprite floating above the coin
let pfpSpinRemaining = 0; // radians left in the triggered 360 spin
const PFP_SPIN_SPEED = 12.0; // rad/s while a triggered spin plays out
// Hitscan tracer (single reusable line, fades fast).
let tracer = null;
let tracerLife = 0;
const TRACER_MAX_LIFE = 0.09;
const _shotDir = new THREE.Vector3();
const _shotRight = new THREE.Vector3();
const _shotR = new THREE.Vector3();
const _shotTorque = new THREE.Vector3();
vacuum.addObstacle(tvObb);
ball.addObstacle(tvObb);
// Bob's live OBB (zero-sized until his model loads — resolvers skip it).
vacuum.addObstacle(bob.obb);
ball.addObstacle(bob.obb);
let eHeld = false;
let holdProgress = 0;
let holdTarget = null; // 'tv' | 'ball' | null — captured when the E hold starts
// Robot possession state: E near the robot possesses it (instant tap,
// no hold). While possessed the player directly drives the robot.
let isPossessed = false;
let possessVelY = 0;
let possessGrounded = true;
// Close third-person follow while possessed: frames the visible robot
// mesh with enough breathing room around it.
const POSSESS_CAM_DIST = 3.0; // meters behind the robot head
const POSSESS_CAM_HEIGHT = 1.8; // look-at height above the robot base
const POSSESS_SPEED = 4.0; // m/s walk speed for the possessed robot
// Perspective zoom while possessed: slightly narrower than the default
// 75° FOV so the vacuum reads clearly without losing context.
const POSSESS_FOV = 55;
let savedFov = null;
// --- Flyable plane (/models/plane.glb): hold E near it to board, WASD to
// steer (drone-style, camera-relative), SPACE up / C down, SHIFT boost,
// hold E to land. Locked to the platform: XZ clamped to floor bounds,
// altitude clamped above the floor — you can never leave the boarders.
let planeMesh = null; // parked prop until boarded
let isFlying = false; // true while piloting the plane
let planeTailOffset = 5.0; // local +X distance to the tail — E prompt anchor
let flyCooldownUntil = 0; // grace after landing so you don't instantly re-board
let planeFalling = false; // true after you bail mid-air: drops back to the floor
let planeFallVel = 0; // downward speed while falling
let planeRestY = 0; // parked height on the floor — where falls come to rest
const flyVel = new THREE.Vector3();
let moveUp = false; // SPACE while flying
let moveDown = false; // C while flying
const FLY_SPEED = 14.0;
const FLY_CLIMB = 9.0;
// True 3rd person: the plane is ~75m long, so the chase cam sits well
// behind + above it to frame the whole body (9m would be inside the mesh).
const FLY_CAM_DIST = 42.0;
const FLY_CAM_HEIGHT = 14.0;
const FLY_MIN_ALT = 0.8; // meters above the floor (never clips the platform)
const FLY_MAX_ALT = 30.0; // ceiling — stays over the board, never leaves
const FLY_FOV = 65;
const _flyDir = new THREE.Vector3();
const _flyFlat = new THREE.Vector3();
const _flySide = new THREE.Vector3();
const _flyTarget = new THREE.Vector3();
const interactPrompt = document.getElementById('interact-prompt');
const interactLabel = document.getElementById('e-label');
const ringFg = document.getElementById('e-ring-fg');
const RING_C = 2 * Math.PI * 26;
if (ringFg) {
  ringFg.style.strokeDasharray = `${RING_C}`;
  ringFg.style.strokeDashoffset = `${RING_C}`;
}

// Smooth mouse-scroll zoom (FOV-based, first-person friendly).
const BASE_FOV = 75;
const MIN_FOV = 35;
const MAX_FOV = 85;
let targetFov = BASE_FOV;

// Official game-start latch: false on the main menu / pre-game state,
// set true on the first Start-button pointer lock. Bob's AI stays
// completely idle and stationary until this flips.
let gameStarted = false;

function playerPos() {
  // PointerLockControls (r150+): controls.object is the camera.
  return controls.object.position;
}

init();

function init() {
  scene = new THREE.Scene();
  // No gray clear color / fog: the HDRI sky is the seamless background.
  // Leaving background null until sky.hdr loads avoids any flat gray sea.
  scene.background = null;
  scene.fog = null;
  vacuum.scene = scene;
  ball.scene = scene;
  bob.scene = scene;
  initHealthHUD();

  const aspect = window.innerWidth / window.innerHeight;
  camera = new THREE.PerspectiveCamera(75, aspect, 0.1, 1000);
  // Camera must be in the scene so a carried vacuum (child of camera) renders.
  scene.add(camera);

  controls = new PointerLockControls(camera, document.body);
  // keep all Bob instances bound to scene (clones added later do it individually)
  for (const b of bobs) b.scene = scene;

  initTvAudio();
  initMovementAudio();
  initShotAudio();
  initButtonAudio();
  initBombAudio();
  initCoinAudio();
  document.addEventListener('mousedown', (event) => {
    // Left-click fires the equipped gun (guarded by pointer lock inside).
    if (event.button === 0) fireGun();
  });

  // Touch controls: joystick + Run/Jump/Interact buttons + touch look.
  // Only activates on touch-capable devices (module returns null otherwise).
  touchUI = initMobileControls({
    onJump: mobileJumpDown,
    onJumpUp: mobileJumpUp,
    onInteractDown: mobileInteractDown,
    onInteractUp: mobileInteractUp,
    onLook: mobileLook,
    onShoot: () => fireGun(),
  });

  const blocker = document.getElementById('blocker');
  const startBtn = document.getElementById('start-btn');

  startBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    // No Pointer Lock on touch screens: emulate the locked state so all
    // isLocked-gated game logic runs, and show the touch UI instead.
    if (touchUI) {
      startTouchGame();
      return;
    }
    controls.lock();
    // User gesture: safe point to start the looping TV static audio.
    tryPlayTvAudio();
  });
  blocker.addEventListener('click', (event) => {
    event.stopPropagation();
  });
  controls.addEventListener('lock', () => {
    blocker.style.display = 'none';
    // Official game start: latches on the first Start click. Bob's AI
    // stays completely idle until this fires.
    gameStarted = true;
    // Entering the game: safe point to start looping audio (user gesture).
    tryPlayTvAudio();
  });
  controls.addEventListener('unlock', () => {
    blocker.style.display = 'flex';
    // Releasing pointer lock cancels any in-progress hold.
    eHeld = false;
    holdProgress = 0;
    holdTarget = null;
    setRingProgress(0);
    pauseLoop(footAudio);
    pauseLoop(runAudio);
    // Back at the title screen: silence everything.
    if (tvAudio) {
      try {
        tvAudio.pause();
      } catch {
        // Ignore audio teardown errors.
      }
    }
  });

  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup', onKeyUp);
  // Smooth camera zoom via mouse scroll wheel (only while pointer-locked).
  window.addEventListener(
    'wheel',
    (event) => {
      if (!controls.isLocked) return;
      targetFov = THREE.MathUtils.clamp(
        targetFov + event.deltaY * 0.02,
        MIN_FOV,
        MAX_FOV
      );
    },
    { passive: true }
  );

  scene.add(new THREE.AmbientLight(0xffffff, 0.8));
  const directionalLight = new THREE.DirectionalLight(0xffffff, 1.2);
  directionalLight.position.set(10, 20, 10);
  directionalLight.castShadow = true;
  // Lower res shadow = big GPU win, still sharp enough
  directionalLight.shadow.mapSize.set(512, 512);
  directionalLight.shadow.camera.left = -20;
  directionalLight.shadow.camera.right = 20;
  directionalLight.shadow.camera.top = 20;
  directionalLight.shadow.camera.bottom = -20;
  directionalLight.shadow.camera.near = 0.5;
  directionalLight.shadow.camera.far = 60;
  directionalLight.shadow.bias = -0.0005;
  scene.add(directionalLight);

  renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
  renderer.setSize(window.innerWidth, window.innerHeight);
  // PERF: 685-plant forest — cap at 1x pixels (4K/retina costs 2-4x fill).
  // Single biggest GPU win in the game; HUD/gun stay crisp via geometry.
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  // Manual clearing: the world renders first, then the HUD layer on top
  // (autoClear would wipe the world before the HUD draws).
  renderer.autoClear = false;
  document.body.appendChild(renderer.domElement);

  // Dedicated HUD layer for the equipped gun: fixed-FOV camera that never
  // moves, so the gun is immune to main-camera zoom/FOV changes.
  hudScene = new THREE.Scene();
  hudCamera = new THREE.PerspectiveCamera(
    HUD_FOV,
    window.innerWidth / window.innerHeight,
    0.01,
    20
  );
  hudScene.add(hudCamera);
  // Layered HUD lighting so the gun is never swallowed by shadow:
  // ambient base + sky/ground hemisphere + warm key + cool rim fill.
  hudScene.add(new THREE.AmbientLight(0xffffff, 1.1));
  hudScene.add(new THREE.HemisphereLight(0xdfeaff, 0x3a3227, 0.7));
  const hudKey = new THREE.DirectionalLight(0xfff2df, 1.6);
  hudKey.position.set(0.6, 1.0, 0.4);
  hudScene.add(hudKey);
  const hudFill = new THREE.DirectionalLight(0xbcd2ff, 0.6);
  hudFill.position.set(-0.8, 0.3, -0.6);
  hudScene.add(hudFill);

  // Direct forward rendering: no post-processing chain, no motion blur
  // or temporal smoothing — the scene, robot, and objects stay sharp.
  // Tone mapping is the renderer's own ACESFilmic setting above.

  new RGBELoader().load(
    `${import.meta.env.BASE_URL}models/sky.hdr`,
    (texture) => {
      texture.mapping = THREE.EquirectangularReflectionMapping;
      // HalfFloat reduces memory/bandwidth vs Float
      texture.type = THREE.HalfFloatType;
      // Cap HDRI res to 512 for perf
      texture.minFilter = THREE.LinearFilter;
      scene.background = texture;
      scene.environment = texture;
      if (hudScene) hudScene.environment = texture;
    },
    undefined,
    (error) => {
      console.warn('HDRI sky failed to load, using fallback background:', error);
    }
  );

  const loader = new GLTFLoader();
  loader.load(
    `${import.meta.env.BASE_URL}models/floor.glb`,
    (gltf) => {
      const model = gltf.scene;
      model.traverse((obj) => {
        if (obj.isMesh) {
          obj.castShadow = true;
          obj.receiveShadow = true;
          obj.frustumCulled = true;
        }
      });

      const box = new THREE.Box3().setFromObject(model);
      const center = box.getCenter(new THREE.Vector3());
      model.position.x -= center.x;
      model.position.z -= center.z;

      scene.add(model);
      roomMesh = model;
      vacuum.setRoomMesh(model);

      raycaster.set(new THREE.Vector3(0, 100, 0), new THREE.Vector3(0, -1, 0));
      const intersects = raycaster.intersectObject(roomMesh, true);
      let floorY = 0;
      if (intersects.length > 0) floorY = intersects[0].point.y;
      cachedFloorY = floorY;

      playerPos().set(0, floorY + 1.6, 0);
      isGrounded = true;
      verticalVelocity = 0;

      // Floor bounds (padded so the vacuum stays well within walls).
      const floorBox = new THREE.Box3().setFromObject(roomMesh);
      floorBox.min.y = floorY;
      const floorMin = floorBox.min.clone();
      const floorMax = floorBox.max.clone();
      floorMin.x += 1.0;
      floorMin.z += 1.0;
      floorMax.x -= 1.0;
      floorMax.z -= 1.0;
      vacuum.setFloorBounds(floorMin, floorMax);
      ball.setRoomMesh(model);
      ball.setFloorBounds(floorMin, floorMax);

      // Procedural dirt overlay - 512 is 4x fewer pixels than 1024
      dirtLayer = new DirtLayer({ min: floorMin, max: floorMax, floorY, size: 512 });
      scene.add(dirtLayer.mesh);
      vacuum.setDirtLayer(dirtLayer);

      loader.load(
        `${import.meta.env.BASE_URL}models/robot.glb`,
        (robotGltf) => {
          const robotMesh = robotGltf.scene;
          robotMesh.scale.set(0.8, 0.8, 0.8);
          robotMesh.position.set(2.0, floorY, 2.0);
          robotMesh.traverse((obj) => {
            if (obj.isMesh) {
              obj.castShadow = true;
              obj.receiveShadow = true;
              obj.frustumCulled = true;
            }
          });
          scene.add(robotMesh);
          vacuum.setMesh(robotMesh);
        },
        undefined,
        (err) => {
          console.warn('Could not load robot.glb, using procedural fallback:', err);
          const geom = new THREE.CylinderGeometry(0.4, 0.4, 0.2, 32);
          const mat = new THREE.MeshStandardMaterial({
            color: 0x3366ff,
            metalness: 0.8,
            roughness: 0.2,
          });
          const fallback = new THREE.Mesh(geom, mat);
          fallback.position.set(2.0, floorY + 0.1, 2.0);
          fallback.castShadow = true;
          fallback.receiveShadow = true;
          scene.add(fallback);
          vacuum.setMesh(fallback);
        }
      );

      // Spawn the TV exactly 6m directly in front of the player's initial
      // spawn (0, floorY + 1.6, 0). Default look direction is -Z, so front is -Z.
      loader.load(
        `${import.meta.env.BASE_URL}models/tv.glb`,
        (tvGltf) => {
          const tv = tvGltf.scene;
          tvMesh = tv;
          const tvZ = -TV_SPAWN_DISTANCE;
          // Find the floor height at the TV spot so it sits properly.
          raycaster.set(new THREE.Vector3(0, floorY + 5.0, tvZ), new THREE.Vector3(0, -1, 0));
          let tvFloorY = floorY;
          const tvHits = raycaster.intersectObject(roomMesh, true);
          if (tvHits.length > 0) tvFloorY = tvHits[0].point.y;
          tv.position.set(0, tvFloorY, tvZ);
          // Seat the model on the floor regardless of its origin offset.
          const tvBox = new THREE.Box3().setFromObject(tv);
          tv.position.y += tvFloorY - tvBox.min.y;
          // Face the player spawn (screen toward +Z).
          tv.rotation.y = 0;
          tv.traverse((obj) => {
            if (obj.isMesh) {
              obj.castShadow = true;
              obj.receiveShadow = true;
              obj.frustumCulled = true;
            }
          });
          scene.add(tv);
          // Capture the solid collider (spans the TV body and its legs) in
          // mesh-local space, then derive the live oriented box from it.
          tv.updateMatrixWorld(true);
          tvLocalBox.setFromObject(tv);
          // setFromObject is world-space: pull it back into local space so
          // the OBB can be re-posed from the mesh matrix every frame.
          tvLocalBox.applyMatrix4(_tvM4.copy(tv.matrixWorld).invert());
          tvLocalBox.getCenter(tvLocalCenter);
          tvLocalBox.getSize(_tvPush);
          tvObb.halfSize.copy(_tvPush).multiplyScalar(0.5);
          tvColliderReady = true;
          updateTvCollider();
          // Lock the rest height for impact physics (shots slide/tilt, never sink).
          tvBaseY = tv.position.y;
          // 3D Billboard leaderboard 15m left of TV
          createLeaderboard(new THREE.Vector3(-15, tvFloorY + 1.8, tvZ), tvFloorY);
          // FEMBOY board 15m right of TV (mirrors the leaderboard)
          createFemboyBoard(new THREE.Vector3(15, tvFloorY + 1.8, tvZ), tvFloorY);
          // Start the looping TV static now that the broken TV is in place.
          tryPlayTvAudio();
        },
        undefined,
        (err) => {
          console.warn('Could not load tv.glb:', err);
        }
      );

      // Button 20m in front of the TV (TV faces +Z toward spawn, so front is +Z).
      loader.load(
        `${import.meta.env.BASE_URL}models/button.glb`,
        (buttonGltf) => {
          const btn = buttonGltf.scene;
          const tvZ = -TV_SPAWN_DISTANCE;
          let buttonX = 0;
          let buttonZ = tvZ + 20.0;
          // Clamp inside the padded floor bounds so a small map still fits it.
          if (vacuum.floorMin && vacuum.floorMax) {
            buttonX = THREE.MathUtils.clamp(buttonX, vacuum.floorMin.x + 1.0, vacuum.floorMax.x - 1.0);
            buttonZ = THREE.MathUtils.clamp(buttonZ, vacuum.floorMin.z + 1.0, vacuum.floorMax.z - 1.0);
          }
          raycaster.set(
            new THREE.Vector3(buttonX, floorY + 5.0, buttonZ),
            new THREE.Vector3(0, -1, 0)
          );
          let buttonFloorY = floorY;
          const buttonHits = raycaster.intersectObject(roomMesh, true);
          if (buttonHits.length > 0) buttonFloorY = buttonHits[0].point.y;
          btn.position.set(buttonX, buttonFloorY, buttonZ);
          // Rest on the floor regardless of origin offset, face the TV.
          const buttonBox = new THREE.Box3().setFromObject(btn);
          btn.position.y += buttonFloorY - buttonBox.min.y + 0.02;
          btn.rotation.y = Math.PI; // face back toward the TV / spawn
          btn.traverse((obj) => {
            if (obj.isMesh) {
              obj.castShadow = true;
              obj.receiveShadow = true;
              obj.frustumCulled = true;
            }
          });
          scene.add(btn);
          buttonMesh = btn;
        },
        undefined,
        (err) => {
          console.warn('Could not load button.glb:', err);
        }
      );

      // Bomb template (preloaded, cloned on each button press).
      loader.load(
        `${import.meta.env.BASE_URL}models/bomb.glb`,
        (bombGltf) => {
          bombTemplate = bombGltf.scene;
        },
        undefined,
        (err) => {
          console.warn('Could not load bomb.glb:', err);
        }
      );

      // Volleyball near the right side of the TV (+X of the TV spot).
      loader.load(
        `${import.meta.env.BASE_URL}models/ball.glb`,
        (ballGltf) => {
          const ballMesh = ballGltf.scene;
          ballMesh.scale.set(1.5, 1.5, 1.5);
          const ballX = 2.2;
          const ballZ = -TV_SPAWN_DISTANCE + 0.5;
          raycaster.set(
            new THREE.Vector3(ballX, floorY + 5.0, ballZ),
            new THREE.Vector3(0, -1, 0)
          );
          let ballFloorY = floorY;
          const ballHits = raycaster.intersectObject(roomMesh, true);
          if (ballHits.length > 0) ballFloorY = ballHits[0].point.y;
          ballMesh.position.set(ballX, ballFloorY, ballZ);
          // Rest the ball on the floor regardless of its origin offset.
          const ballBox = new THREE.Box3().setFromObject(ballMesh);
          ballMesh.position.y += ballFloorY - ballBox.min.y + 0.02;
          ballMesh.traverse((obj) => {
            if (obj.isMesh) {
              obj.castShadow = true;
              obj.receiveShadow = true;
              obj.frustumCulled = true;
            }
          });
          scene.add(ballMesh);
          ball.setMesh(ballMesh);
        },
        undefined,
        (err) => {
          console.warn('Could not load ball.glb:', err);
        }
      );

      // Parked plane in the far-left corner of the room, sitting on the floor.
      // Hold E next to it to board and fly (locked to the platform).
      loader.load(
        `${import.meta.env.BASE_URL}models/plane.glb`,
        (planeGltf) => {
          planeMesh = planeGltf.scene;
          // Corner spot: inset well inside the padded floor bounds so the
          // whole wingspan sits on the platform, clear of the walls.
          // Falls back to the old TV-side spot if bounds aren't ready yet.
          let planeX = -3.5;
          let planeZ = -TV_SPAWN_DISTANCE + 1.0;
          if (vacuum.floorMin && vacuum.floorMax) {
            planeX = vacuum.floorMin.x + 4.0;
            planeZ = vacuum.floorMin.z + 4.0;
          }
          raycaster.set(
            new THREE.Vector3(planeX, floorY + 5.0, planeZ),
            new THREE.Vector3(0, -1, 0)
          );
          let planeFloorY = floorY;
          const planeHits = raycaster.intersectObject(roomMesh, true);
          if (planeHits.length > 0) planeFloorY = planeHits[0].point.y;
          planeMesh.position.set(planeX, planeFloorY, planeZ);
          // Rest the plane on the floor regardless of its origin offset.
          const planeBox = new THREE.Box3().setFromObject(planeMesh);
          planeMesh.position.y += planeFloorY - planeBox.min.y + 0.02;
          planeRestY = planeMesh.position.y;
          // Tail (back side, local +X) offset for the boarding prompt: the
          // E ring anchors at the tail so you board from behind the plane.
          {
            const _psz = planeBox.getSize(new THREE.Vector3());
            if (_psz.x > 1.0) planeTailOffset = _psz.x / 2;
          }
          // Angle it slightly so it reads as parked, nose toward the room.
          planeMesh.rotation.y = Math.PI / 5;
          planeMesh.traverse((obj) => {
            if (obj.isMesh) {
              obj.castShadow = true;
              obj.receiveShadow = true;
              obj.frustumCulled = true;
            }
          });
          scene.add(planeMesh);
        },
        undefined,
        (err) => {
          console.warn('Could not load plane.glb:', err);
        }
      );

      // Giant pfp coin on the opposite (far-right) corner from the plane.
      {
        let coinX = 3.5;
        let coinZ = -TV_SPAWN_DISTANCE + 1.0;
        if (vacuum.floorMin && vacuum.floorMax) {
          coinX = vacuum.floorMax.x - 4.0;
          coinZ = vacuum.floorMin.z + 4.0;
        }
        raycaster.set(
          new THREE.Vector3(coinX, floorY + 5.0, coinZ),
          new THREE.Vector3(0, -1, 0)
        );
        let coinFloorY = floorY;
        const coinHits = raycaster.intersectObject(roomMesh, true);
        if (coinHits.length > 0) coinFloorY = coinHits[0].point.y;
        createPfpCoin(coinX, coinZ, coinFloorY);
      }

      // Player gun: spawns equipped on the right side of the screen
      // (child of the camera, so it stays put in first person and while
      // possessing the vacuum).
      loader.load(
        `${import.meta.env.BASE_URL}models/gun.glb`,
        (gunGltf) => {
          setupGunMesh(gunGltf.scene);
        },
        undefined,
        (err) => {
          console.warn('Could not load gun.glb, using procedural fallback:', err);
          const fallback = new THREE.Group();
          const bodyMat = new THREE.MeshStandardMaterial({ color: 0x2a2d34, metalness: 0.7, roughness: 0.35 });
          const gripMat = new THREE.MeshStandardMaterial({ color: 0x5a3a22, metalness: 0.1, roughness: 0.8 });
          const body = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.12, 0.5), bodyMat);
          const grip = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.2, 0.1), gripMat);
          grip.position.set(0, -0.14, 0.12);
          grip.rotation.x = 0.25;
          fallback.add(body, grip);
          setupGunMesh(fallback);
        }
      );

      // Bob the pigeon: rigged enemy — 1 original + 7 clones scattered around map.
      loader.load(
        `${import.meta.env.BASE_URL}models/bob.glb`,
        (bobGltf) => {
          const spawnBob = (bx, bz, bInstance) => {
            const isClone = bInstance !== bob;
            const bobMesh = isClone ? cloneSkinned(bobGltf.scene) : bobGltf.scene;
            bobMesh.scale.set(1.0, 1.0, 1.0);
            bx = Math.max(vacuum.floorMin.x, Math.min(vacuum.floorMax.x, bx));
            bz = Math.max(vacuum.floorMin.z, Math.min(vacuum.floorMax.z, bz));
            raycaster.set(new THREE.Vector3(bx, floorY + 5.0, bz), new THREE.Vector3(0, -1, 0));
            let bobFloorY = floorY;
            const bobHits = raycaster.intersectObject(roomMesh, true);
            if (bobHits.length > 0) bobFloorY = bobHits[0].point.y;
            bobMesh.position.set(bx, bobFloorY, bz);
            const bobBox = new THREE.Box3().setFromObject(bobMesh);
            bobMesh.position.y += bobFloorY - bobBox.min.y;
            bInstance.roomMesh = roomMesh;
            if (vacuum.floorMin && vacuum.floorMax) bInstance.setFloorBounds(vacuum.floorMin, vacuum.floorMax);
            bInstance.scene = scene;
            scene.add(bobMesh);
            bInstance.setMesh(bobMesh, bobGltf.animations || []);
            vacuum.addObstacle(bInstance.obb);
            ball.addObstacle(bInstance.obb);
          };
          // original near player — pulled much closer
          spawnBob(2.5, -3.0, bob);
          // 7 more clustered close to player spawn (total 8 Bobs)
          for (let i = 0; i < 7; i++) {
            const b = new Bob(scene, roomMesh);
            if (vacuum.floorMin && vacuum.floorMax) b.setFloorBounds(vacuum.floorMin, vacuum.floorMax);
            bobs.push(b);
            // Polar placement 3–8m from player spawn, random angle
            const ang = Math.random() * Math.PI * 2;
            const rad = 3 + Math.random() * 5;
            const px = Math.cos(ang) * rad;
            const pz = Math.sin(ang) * rad;
            spawnBob(px, pz, b);
          }
        },
        undefined,
        (err) => {
          console.warn('Could not load bob.glb:', err);
        }
      );
      // Floor bounds were set above; keep Bob clamped once known.
      if (vacuum.floorMin && vacuum.floorMax) {
        for (const b of bobs) b.setFloorBounds(vacuum.floorMin, vacuum.floorMax);
      }

      // Pies: 7 edible heal pickups (+180 HP each) scattered across the map.
      loader.load(
        `${import.meta.env.BASE_URL}models/pie.glb`,
        (pieGltf) => {
          const template = pieGltf.scene;
          // Kept at ORIGINAL authored size (~1.2m across) — comically large.
          // Spread fractions across the padded floor bounds (corners, edges,
          // center) so all 7 land in different locations around the map.
          const spots = [
            [0.15, 0.2],
            [0.85, 0.25],
            [0.2, 0.8],
            [0.8, 0.78],
            [0.5, 0.5],
            [0.35, 0.62],
            [0.68, 0.42],
          ];
          for (let i = 0; i < PIE_COUNT && i < spots.length; i++) {
            const pieMesh = template.clone();
            const px = THREE.MathUtils.lerp(vacuum.floorMin.x, vacuum.floorMax.x, spots[i][0]);
            const pz = THREE.MathUtils.lerp(vacuum.floorMin.z, vacuum.floorMax.z, spots[i][1]);
            raycaster.set(
              new THREE.Vector3(px, floorY + 5.0, pz),
              new THREE.Vector3(0, -1, 0)
            );
            let pieFloorY = floorY;
            const pieHits = raycaster.intersectObject(roomMesh, true);
            if (pieHits.length > 0) pieFloorY = pieHits[0].point.y;
            pieMesh.position.set(px, pieFloorY, pz);
            // Rest the pie on the floor regardless of its origin offset.
            const pieBox = new THREE.Box3().setFromObject(pieMesh);
            pieMesh.position.y += pieFloorY - pieBox.min.y + 0.02;
            pieMesh.rotation.y = Math.random() * Math.PI * 2;
            pieMesh.traverse((obj) => {
              if (obj.isMesh) {
                obj.castShadow = true;
                obj.receiveShadow = true;
                obj.frustumCulled = true;
              }
            });
            scene.add(pieMesh);
            pies.push({ mesh: pieMesh, eaten: false });
          }
        },
        undefined,
        (err) => {
          console.warn('Could not load pie.glb:', err);
        }
      );

      // Leaves: forest of leaf.glb, ONE InstancedMesh for all LEAF_COUNT.
      // Same placement rules as before; per-instance data lives in `leaves`.
      loader.load(
        `${import.meta.env.BASE_URL}models/leaf.glb`,
        (leafGltf) => {
          // Single mesh / single material: share both across all instances
          // (no per-leaf clone, no per-leaf material — the whole perf win).
          let srcMesh = null;
          leafGltf.scene.traverse((obj) => {
            if (!srcMesh && obj.isMesh) srcMesh = obj;
          });
          if (!srcMesh) {
            console.warn('leaf.glb has no meshes');
            return;
          }
          const leafGeo = srcMesh.geometry;
          const leafMat = Array.isArray(srcMesh.material) ? srcMesh.material[0] : srcMesh.material;
          // Seat the geometry so instance origin = bottom of the plant:
          // lets us place instances directly at floor height with no Box3.
          leafGeo.computeBoundingBox();
          const _bb = leafGeo.boundingBox;
          const _yOff = -_bb.min.y + 0.02;
          // Hand-placed hero spots (kept from the original 5) + random
          // forest fill scattered across the padded floor bounds.
          const spots = [
            [0.25, 0.35],
            [0.75, 0.3],
            [0.3, 0.7],
            [0.7, 0.72],
            [0.5, 0.25],
          ];
          // Fill up to LEAF_COUNT with random positions. Keeps clear of
          // the player spawn (0,0) and the TV lane so spawns stay walkable.
          // Button spot (20m in front of TV, clamped to bounds) stays clear too.
          const _btnZ = (() => {
            const raw = -TV_SPAWN_DISTANCE + 20.0;
            if (vacuum.floorMin && vacuum.floorMax)
              return THREE.MathUtils.clamp(raw, vacuum.floorMin.z + 1.0, vacuum.floorMax.z - 1.0);
            return raw;
          })();
          let guard = 0;
          // Spatial hash (1m cells) so 2385-plant spacing checks stay O(1)
          // instead of O(n^2) at load.
          const cellMap = new Map();
          const cellKey = (x, z) => `${Math.floor(x)}:${Math.floor(z)}`;
          const seedSpot = (fx, fz) => {
            const sx = THREE.MathUtils.lerp(vacuum.floorMin.x, vacuum.floorMax.x, fx);
            const sz = THREE.MathUtils.lerp(vacuum.floorMin.z, vacuum.floorMax.z, fz);
            const k = cellKey(sx, sz);
            if (!cellMap.has(k)) cellMap.set(k, []);
            cellMap.get(k).push([sx, sz]);
            spots.push([fx, fz]);
          };
          for (const s of spots) {
            const sx = THREE.MathUtils.lerp(vacuum.floorMin.x, vacuum.floorMax.x, s[0]);
            const sz = THREE.MathUtils.lerp(vacuum.floorMin.z, vacuum.floorMax.z, s[1]);
            const k = cellKey(sx, sz);
            if (!cellMap.has(k)) cellMap.set(k, []);
            cellMap.get(k).push([sx, sz]);
          }
          const isTooClose = (px, pz, minD) => {
            const cx = Math.floor(px), cz = Math.floor(pz);
            const r = Math.ceil(minD);
            for (let ix = cx - r; ix <= cx + r; ix++) {
              for (let iz = cz - r; iz <= cz + r; iz++) {
                const cell = cellMap.get(`${ix}:${iz}`);
                if (!cell) continue;
                for (const [sx, sz] of cell) {
                  if (Math.hypot(px - sx, pz - sz) < minD) return true;
                }
              }
            }
            return false;
          };
          while (spots.length < LEAF_COUNT && guard++ < LEAF_COUNT * 40) {
            const fx = 0.05 + Math.random() * 0.9;
            const fz = 0.05 + Math.random() * 0.9;
            const px = THREE.MathUtils.lerp(vacuum.floorMin.x, vacuum.floorMax.x, fx);
            const pz = THREE.MathUtils.lerp(vacuum.floorMin.z, vacuum.floorMax.z, fz);
            if (Math.hypot(px, pz) < 2.5) continue; // player spawn clearing
            if (Math.hypot(px - 0, pz + TV_SPAWN_DISTANCE) < 2.0) continue; // TV clearing
            if (Math.hypot(px - 0, pz - _btnZ) < 1.5) continue; // button clearing
            if (isTooClose(px, pz, 1.5)) continue;
            seedSpot(fx, fz);
          }
          // Fallback: if the map is too small for spaced placement, fill the
          // rest randomly so we still hit LEAF_COUNT (dense jungle look).
          guard = 0;
          while (spots.length < LEAF_COUNT && guard++ < LEAF_COUNT * 10) {
            const fx = 0.05 + Math.random() * 0.9;
            const fz = 0.05 + Math.random() * 0.9;
            const px = THREE.MathUtils.lerp(vacuum.floorMin.x, vacuum.floorMax.x, fx);
            const pz = THREE.MathUtils.lerp(vacuum.floorMin.z, vacuum.floorMax.z, fz);
            if (Math.hypot(px, pz) < 2.0) continue;
            seedSpot(fx, fz);
          }
          const count = Math.min(LEAF_COUNT, spots.length);
          leafInst = new THREE.InstancedMesh(leafGeo, leafMat, count);
          leafInst.castShadow = false;
          leafInst.receiveShadow = false;
          leafInst.frustumCulled = false; // one bounds for the forest; never culled wrong
          leafInst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
          // Flat floor fast path: every leaf sits at cachedFloorY (no raycasts).
          // Original look: random size + rotation per plant, plus a subtle
          // per-instance tint so the forest doesn't read as one flat clone.
          // NOTE: leaf.glb is only ~16cm tall, so plants need a 5-9x scale
          // to read as knee-to-waist-high bushes instead of tiny sprouts.
          for (let i = 0; i < count; i++) {
            const s = 5.0 + Math.random() * 4.0;
            const px = THREE.MathUtils.lerp(vacuum.floorMin.x, vacuum.floorMax.x, spots[i][0]);
            const pz = THREE.MathUtils.lerp(vacuum.floorMin.z, vacuum.floorMax.z, spots[i][1]);
            const rotY = Math.random() * Math.PI * 2;
            _leafDummy.position.set(px, cachedFloorY + _yOff * s, pz);
            _leafDummy.rotation.set(0, rotY, 0);
            _leafDummy.scale.setScalar(s);
            _leafDummy.updateMatrix();
            leafInst.setMatrixAt(i, _leafDummy.matrix);
            // Subtle natural variety around white (multiplies the leaf
            // texture): slight brightness + green/yellow shift per plant.
            _leafColor.setHSL(
              0.24 + Math.random() * 0.08,
              0.25 + Math.random() * 0.3,
              0.72 + Math.random() * 0.2
            );
            leafInst.setColorAt(i, _leafColor);
            leaves.push({
              index: i,
              hitsTaken: 0,
              maxHits: LEAF_HITS,
              shake: 0,
              settled: true,
              state: 'alive',
              deathTimer: 0,
              deathFallDur: 0.8,
              deathFadeDur: 2.0,
              deathStartZ: 0,
              basePos: _leafDummy.position.clone(),
              baseRotY: rotY,
              baseScale: s,
              baseColor: _leafColor.getHex(),
              yOff: _yOff,
            });
          }
          leafInst.instanceMatrix.needsUpdate = true;
          if (leafInst.instanceColor) leafInst.instanceColor.needsUpdate = true;
          scene.add(leafInst);
        },
        undefined,
        (err) => {
          console.warn('Could not load leaf.glb:', err);
        }
      );

      // Trees: 100x tree.glb as static instanced scenery. One InstancedMesh
      // per source mesh (shares geometry + materials), no shadows, no
      // raycast, no per-frame updates — constant GPU cost (~5 draw calls).
      loader.load(
        `${import.meta.env.BASE_URL}models/tree.glb`,
        (treeGltf) => {
          const srcMeshes = [];
          treeGltf.scene.traverse((obj) => {
            if (obj.isMesh) srcMeshes.push(obj);
          });
          if (srcMeshes.length === 0) {
            console.warn('tree.glb has no meshes');
            return;
          }
          // Bottom-align each part (parts share the same origin, so one
          // offset from the whole scene works for all).
          const wholeBox = new THREE.Box3().setFromObject(treeGltf.scene);
          const yOff = -wholeBox.min.y + 0.02;
          {
            const _sz = wholeBox.getSize(new THREE.Vector3());
            if (_sz.y > 0.5) treeHeight = _sz.y;
          }
          // Placement: ring/edge fill with wide spacing so 100 big trees fit
          // without crowding spawn, TV lane, or button. Flat-floor: no raycasts.
          const placements = []; // {x, z, rotY, s}
          const tCell = new Map();
          const tKey = (x, z) => `${Math.floor(x / 3)}:${Math.floor(z / 3)}`;
          const tTooClose = (px, pz, minD) => {
            const cx = Math.floor(px / 3), cz = Math.floor(pz / 3);
            const r = Math.ceil(minD / 3);
            for (let ix = cx - r; ix <= cx + r; ix++) {
              for (let iz = cz - r; iz <= cz + r; iz++) {
                const cell = tCell.get(`${ix}:${iz}`);
                if (!cell) continue;
                for (const [sx, sz] of cell) {
                  if (Math.hypot(px - sx, pz - sz) < minD) return true;
                }
              }
            }
            return false;
          };
          const btnZ = (() => {
            const raw = -TV_SPAWN_DISTANCE + 20.0;
            if (vacuum.floorMin && vacuum.floorMax)
              return THREE.MathUtils.clamp(raw, vacuum.floorMin.z + 1.0, vacuum.floorMax.z - 1.0);
            return raw;
          })();
          let tGuard = 0;
          while (placements.length < TREE_COUNT && tGuard++ < TREE_COUNT * 60) {
            const fx = 0.03 + Math.random() * 0.94;
            const fz = 0.03 + Math.random() * 0.94;
            const px = THREE.MathUtils.lerp(vacuum.floorMin.x, vacuum.floorMax.x, fx);
            const pz = THREE.MathUtils.lerp(vacuum.floorMin.z, vacuum.floorMax.z, fz);
            if (Math.hypot(px, pz) < 4.0) continue; // spawn clearing (bigger)
            if (Math.hypot(px, pz + TV_SPAWN_DISTANCE) < 3.0) continue; // TV clearing
            if (Math.hypot(px, pz - btnZ) < 2.5) continue; // button clearing
            if (tTooClose(px, pz, 3.0)) continue;
            const k = tKey(px, pz);
            if (!tCell.has(k)) tCell.set(k, []);
            tCell.get(k).push([px, pz]);
            placements.push({
              x: px,
              z: pz,
              rotY: Math.random() * Math.PI * 2,
              s: 0.8 + Math.random() * 0.9,
            });
          }
          // Fallback: relax spacing so we still hit 100 on small maps.
          tGuard = 0;
          while (placements.length < TREE_COUNT && tGuard++ < TREE_COUNT * 20) {
            const fx = 0.03 + Math.random() * 0.94;
            const fz = 0.03 + Math.random() * 0.94;
            const px = THREE.MathUtils.lerp(vacuum.floorMin.x, vacuum.floorMax.x, fx);
            const pz = THREE.MathUtils.lerp(vacuum.floorMin.z, vacuum.floorMax.z, fz);
            if (Math.hypot(px, pz) < 3.0) continue;
            placements.push({
              x: px,
              z: pz,
              rotY: Math.random() * Math.PI * 2,
              s: 0.8 + Math.random() * 0.9,
            });
          }
          const dummy = new THREE.Object3D();
          // Record per-tree state (bomb topples them; they never disappear).
          trees.length = 0;
          for (let i = 0; i < placements.length; i++) {
            const p = placements[i];
            trees.push({
              x: p.x,
              z: p.z,
              rotY: p.rotY,
              s: p.s,
              yOff,
              state: 'standing', // 'standing' | 'falling' | 'fallen'
              fallTimer: 0,
              fallDur: TREE_FALL_DUR,
              fallAxis: Math.random() < 0.5 ? 'x' : 'z', // tip direction
              fallSign: Math.random() < 0.5 ? 1 : -1,
              fallDelay: Math.random() * 0.25, // slight stagger from the blast
              // Collider: capsule in XZ from base to tip (a point while
              // standing). tip/top refresh every frame in writeTreeInstance
              // while falling, so collision tracks rotation + fall exactly.
              tipX: p.x,
              tipZ: p.z,
              topY: cachedFloorY + (yOff + treeHeight) * p.s,
            });
          }
          for (const src of srcMeshes) {
            // Match leaf.glb exactly: opaque cutout, NOT blended transparency.
            // tree.glb ships with alphaMode BLEND which makes foliage look
            // gray / see-through and shade view-dependently. Leaves are
            // opaque + double-sided, so force the same here and only touch
            // alphaTest (never color/emissive/opacity).
            const mats = Array.isArray(src.material) ? src.material : [src.material];
            for (const m of mats) {
              if (!m) continue;
              m.transparent = false;
              m.opacity = 1.0;
              m.depthWrite = true;
              m.side = THREE.DoubleSide;
              if ('shadowSide' in m) m.shadowSide = THREE.DoubleSide;
              if ('alphaTest' in m && m.alphaTest < 0.4) m.alphaTest = 0.5;
              if ('metalness' in m) m.metalness = 0.0;
              if ('emissive' in m) m.emissive.setRGB(0, 0, 0);
              if ('emissiveIntensity' in m) m.emissiveIntensity = 1.0;
              m.needsUpdate = true;
            }
            if (src.geometry && !src.geometry.attributes.normal) {
              src.geometry.computeVertexNormals();
            }
            const inst = new THREE.InstancedMesh(src.geometry, src.material, placements.length);
            inst.castShadow = false;
            inst.receiveShadow = false;
            inst.frustumCulled = false;
            for (let i = 0; i < placements.length; i++) {
              const p = placements[i];
              dummy.position.set(p.x, cachedFloorY + yOff * p.s, p.z);
              dummy.rotation.set(0, p.rotY, 0);
              dummy.scale.setScalar(p.s);
              dummy.updateMatrix();
              inst.setMatrixAt(i, dummy.matrix);
            }
            inst.instanceMatrix.needsUpdate = true;
            scene.add(inst);
            treeInstMeshes.push(inst);
          }
          console.log(`Forest ready: ${leaves.length} leaves + ${placements.length} trees (instanced).`);
        },
        undefined,
        (err) => {
          console.warn('Could not load tree.glb:', err);
        }
      );

      // Gifts: 3x gift.glb spread around the map. Hold E to open one —
      // it vanishes and bursts GIFT_COINS gold coins with real physics.
      loader.load(
        `${import.meta.env.BASE_URL}models/gift.glb`,
        (giftGltf) => {
          const template = giftGltf.scene;
          const spots = [
            [0.15, 0.3],
            [0.85, 0.35],
            [0.5, 0.8],
          ];
          for (let i = 0; i < GIFT_COUNT && i < spots.length; i++) {
            const giftMesh = template.clone(true);
            const px = THREE.MathUtils.lerp(vacuum.floorMin.x, vacuum.floorMax.x, spots[i][0]);
            const pz = THREE.MathUtils.lerp(vacuum.floorMin.z, vacuum.floorMax.z, spots[i][1]);
            if (Math.hypot(px, pz) < 2.5) continue; // never block spawn
            giftMesh.position.set(px, cachedFloorY, pz);
            // Seat on the floor regardless of origin offset (flat floor).
            const giftBox = new THREE.Box3().setFromObject(giftMesh);
            giftMesh.position.y += cachedFloorY - giftBox.min.y + 0.02;
            giftMesh.rotation.y = Math.random() * Math.PI * 2;
            giftMesh.traverse((obj) => {
              if (obj.isMesh) {
                obj.castShadow = true;
                obj.receiveShadow = true;
                obj.frustumCulled = true;
              }
            });
            scene.add(giftMesh);
            gifts.push({ mesh: giftMesh, opened: false });
          }
        },
        undefined,
        (err) => {
          console.warn('Could not load gift.glb:', err);
        }
      );

      animate();
    },
    (xhr) => {
      if (xhr.total) console.log(`${(xhr.loaded / xhr.total) * 100}% loaded`);
    },
    (error) => {
      console.error('Floor model failed to load:', error);
      playerPos().set(0, 1.6, 0);
      isGrounded = true;
      verticalVelocity = 0;
      animate();
    }
  );

  window.addEventListener('resize', onWindowResize);
}

function onKeyDown(event) {
  // Fresh user gesture while in game: retry TV audio if it hasn't started.
  if (controls.isLocked) tryPlayTvAudio();
  switch (event.code) {
    case 'ArrowUp':
    case 'KeyW':
      moveForward = true;
      break;
    case 'ArrowLeft':
    case 'KeyA':
      moveLeft = true;
      break;
    case 'ArrowDown':
    case 'KeyS':
      moveBackward = true;
      break;
    case 'ArrowRight':
    case 'KeyD':
      moveRight = true;
      break;
    case 'ShiftLeft':
    case 'ShiftRight':
      isSprinting = true;
      break;
    case 'Space':
      if (isFlying) {
        moveUp = true;
        break;
      }
      if (isPossessed) {
        if (possessGrounded === true) {
          possessVelY = jumpForce;
          possessGrounded = false;
        }
      } else if (isGrounded === true) {
        verticalVelocity = jumpForce;
        isGrounded = false;
      }
      break;
    case 'KeyE':
      // Holding E near the robot possesses it; holding E while possessed exits.
      // Holding E near the plane boards it; holding E while flying lands.
      if (!controls.isLocked || event.repeat) break;
      if (isPossessed) {
        eHeld = true;
        holdTarget = 'exit-possess';
        break;
      }
      if (isFlying) {
        eHeld = true;
        holdTarget = 'exit-fly';
        break;
      }
      if (canInteractVacuumNow()) {
        eHeld = true;
        holdTarget = 'vacuum';
        break;
      }
      if (ball.isCarried) {
        ball.throwBall(camera, playerVel);
        eHeld = false;
        holdProgress = 0;
        holdTarget = null;
        setRingProgress(0);
        break;
      }
      holdTarget = getInteractTarget();
      if (holdTarget) eHeld = true;
      break;
    case 'KeyC':
      moveDown = true;
      break;
    default:
      break;
  }
}

function canPossessNow() {
  return (
    controls.isLocked &&
    !isPossessed &&
    !isFlying &&
    vacuum.mesh &&
    !vacuum.isCarried &&
    !vacuum.isFlying &&
    !vacuum.isPossessed &&
    !ball.isCarried &&
    camera.position.distanceTo(vacuum.mesh.position) < PICKUP_RANGE
  );
}

function canInteractVacuumNow() {
  return canPossessNow();
}

function enterPossession() {
  if (!vacuum.mesh || isPossessed) return;
  isPossessed = true;
  vacuum.isPossessed = true;
  vacuum.suspendedState = vacuum.state === 'carried' ? vacuum.suspendedState : vacuum.state;
  vacuum.state = 'possessed';
  // Third-person view: the robot mesh stays visible so the user can watch
  // it move, jump, and sprint. Never hide it while possessed.
  vacuum.mesh.visible = true;
  possessVelY = 0;
  possessGrounded = true;
  // Stay on the main perspective camera (keeps the HDRI background and
  // environment rendering properly); just pull it into a close
  // third-person frame behind the robot and ease the FOV in for a clear
  // read with breathing room. Orientation is untouched (mouse-steered).
  const rp = vacuum.mesh.position;
  savedFov = targetFov;
  targetFov = POSSESS_FOV;
  camera.getWorldDirection(_possessFwd);
  if (_possessFwd.lengthSq() < 1e-6) _possessFwd.set(0, 0, -1);
  _possessFwd.normalize();
  // Snap close behind the robot head for a tight initial frame.
  playerPos().set(
    rp.x - _possessFwd.x * POSSESS_CAM_DIST,
    rp.y + POSSESS_CAM_HEIGHT - _possessFwd.y * POSSESS_CAM_DIST,
    rp.z - _possessFwd.z * POSSESS_CAM_DIST
  );
  velocity.set(0, 0, 0);
  eHeld = false;
  holdProgress = 0;
  holdTarget = null;
  setRingProgress(0);
}

function exitPossession() {
  if (!isPossessed || !vacuum.mesh) return;
  isPossessed = false;
  vacuum.isPossessed = false;
  vacuum.mesh.visible = true;
  vacuum.state = vacuum.suspendedState || 'cleaning';
  vacuum.suspendedState = null;
  // Smoothly restore the original perspective zoom (the per-frame FOV
  // easing animates it back), then drop the player character out next to
  // the robot at the first-person eye height. Orientation stays
  // mouse-steered throughout, so the view never snaps.
  targetFov = savedFov !== null ? savedFov : BASE_FOV;
  savedFov = null;
  const rp = vacuum.mesh.position;
  camera.getWorldDirection(_possessFwd);
  _possessFwd.y = 0;
  if (_possessFwd.lengthSq() < 1e-6) _possessFwd.set(0, 0, 1);
  _possessFwd.normalize();
  // Side offset so the player doesn't spawn inside the robot body.
  _possessSide.set(-_possessFwd.z, 0, _possessFwd.x);
  const dropX = rp.x + _possessSide.x * 1.2;
  const dropZ = rp.z + _possessSide.z * 1.2;
  let dropY = rp.y + 1.6;
  if (roomMesh) {
    raycaster.set(_rayOrigin.set(dropX, rp.y + 5.0, dropZ), DOWN);
    const hits = raycaster.intersectObject(roomMesh, true);
    if (hits.length > 0) dropY = hits[0].point.y + 1.6;
  }
  playerPos().set(dropX, dropY, dropZ);
  resolvePlayerCollisions(playerPos());
  verticalVelocity = 0;
  isGrounded = true;
  velocity.set(0, 0, 0);
  possessVelY = 0;
  eHeld = false;
  holdProgress = 0;
  holdTarget = null;
  setRingProgress(0);
}

const _possessFwd = new THREE.Vector3();
const _possessSide = new THREE.Vector3();
const _possessMove = new THREE.Vector3();
const _possessCamDir = new THREE.Vector3();

// --- Plane flight: nose is local -X, so yaw-to-face a world dir is
// atan2(d.z, -d.x). The plane yaws toward motion (or the camera when
// hovering), with bank on turns and pitch on climb/dive.
function planeYawForDir(dx, dz) {
  return Math.atan2(dz, -dx);
}
// Tail (back side) world position: local +X pushed through the plane yaw,
// plus eye height so the E ring floats readably behind the plane.
function planeTailPos(out) {
  if (!planeMesh) return out.copy(camera.position);
  const yaw = planeMesh.rotation.y;
  return out.set(
    planeMesh.position.x + Math.cos(yaw) * planeTailOffset,
    planeMesh.position.y + 1.5,
    planeMesh.position.z - Math.sin(yaw) * planeTailOffset
  );
}
// Squared XZ distance from a point to the fuselage (nose <-> tail segment).
// Touching anywhere along the body boards the plane.
function planeTouchDistSq(pos) {
  if (!planeMesh) return Infinity;
  const yaw = planeMesh.rotation.y;
  const dx = Math.cos(yaw) * planeTailOffset;
  const dz = -Math.sin(yaw) * planeTailOffset;
  const px = planeMesh.position.x;
  const pz = planeMesh.position.z;
  const ax = px - dx, az = pz - dz; // nose
  const bx = px + dx, bz = pz + dz; // tail
  const abx = bx - ax, abz = bz - az;
  const len2 = abx * abx + abz * abz;
  let cxp = px, czp = pz;
  if (len2 > 1e-8) {
    const tt = Math.max(0, Math.min(1, ((pos.x - ax) * abx + (pos.z - az) * abz) / len2));
    cxp = ax + abx * tt;
    czp = az + abz * tt;
  }
  const ox = pos.x - cxp, oz = pos.z - czp;
  return ox * ox + oz * oz;
}
function canBoardPlaneNow() {
  if (
    !controls.isLocked ||
    isPossessed ||
    isFlying ||
    !planeMesh ||
    ball.isCarried
  )
    return false;
  planeTailPos(_projV);
  return camera.position.distanceTo(_projV) < PICKUP_RANGE + 1.5;
}
function enterFlight() {
  if (!planeMesh || isFlying) return;
  isFlying = true;
  planeFalling = false; // caught mid-air: no fall while piloted
  planeFallVel = 0;
  flyVel.set(0, 0, 0);
  moveUp = false;
  moveDown = false;
  savedFov = targetFov;
  targetFov = FLY_FOV;
  // Face the plane where the player looks (horizontal) for instant control.
  camera.getWorldDirection(_flyDir);
  _flyDir.y = 0;
  if (_flyDir.lengthSq() < 1e-6) _flyDir.set(0, 0, -1);
  _flyDir.normalize();
  planeMesh.rotation.order = 'YXZ';
  planeMesh.rotation.set(0, planeYawForDir(_flyDir.x, _flyDir.z), 0);
  eHeld = false;
  holdProgress = 0;
  holdTarget = null;
  setRingProgress(0);
  console.log('Boarded the plane — WASD steer, SPACE up, C down, SHIFT boost, hold E to land.');
}
function exitFlight() {
  if (!isFlying || !planeMesh) return;
  isFlying = false;
  // Let go mid-air: the plane falls straight down to the platform.
  planeFalling = planeMesh.position.y > planeRestY + 0.05;
  planeFallVel = Math.min(0, flyVel.y);
  moveUp = false;
  moveDown = false;
  targetFov = savedFov !== null ? savedFov : BASE_FOV;
  savedFov = null;
  // Step out behind the tail, safe on the floor (even from high up).
  // Dropped 3m past the tail + a cooldown so you don't instantly re-board.
  const pp = planeMesh.position;
  const yaw = planeMesh.rotation.y;
  const bx = Math.cos(yaw), bz = -Math.sin(yaw);
  flyCooldownUntil = performance.now() / 1000 + 2.5;
  const dropX = THREE.MathUtils.clamp(
    pp.x + bx * (planeTailOffset + 3.0),
    vacuum.floorMin ? vacuum.floorMin.x : pp.x,
    vacuum.floorMax ? vacuum.floorMax.x : pp.x
  );
  const dropZ = THREE.MathUtils.clamp(
    pp.z + bz * (planeTailOffset + 3.0),
    vacuum.floorMin ? vacuum.floorMin.z : pp.z,
    vacuum.floorMax ? vacuum.floorMax.z : pp.z
  );
  playerPos().set(dropX, cachedFloorY + 1.6, dropZ);
  resolvePlayerCollisions(playerPos());
  verticalVelocity = 0;
  isGrounded = true;
  velocity.set(0, 0, 0);
  flyVel.set(0, 0, 0);
  eHeld = false;
  holdProgress = 0;
  holdTarget = null;
  setRingProgress(0);
}

function canGrabBallNow() {
  return (
    controls.isLocked &&
    !isPossessed &&
    !isFlying &&
    ball.mesh &&
    !ball.isCarried &&
    !vacuum.isCarried &&
    camera.position.distanceTo(ball.mesh.position) < PICKUP_RANGE
  );
}

// Unified interaction target: 'tv' | 'button' | 'vacuum' | 'ball' | 'plane' | 'gun' | 'pie:<i>' | 'gift:<i>' | null.
// TV takes priority when several are in range, then the airstrike button;
// otherwise the nearest pickup wins; the dropped gun is lowest priority.
function getInteractTarget() {
  if (canFixTvNow()) return 'tv';
  if (canPressButtonNow()) return 'button';
  const vac = canInteractVacuumNow();
  const bal = canGrabBallNow();
  if (vac && bal) {
    const dVac = camera.position.distanceTo(vacuum.mesh.position);
    const dBal = camera.position.distanceTo(ball.mesh.position);
    return dBal < dVac ? 'ball' : 'vacuum';
  }
  if (bal) return 'ball';
  if (vac) return 'vacuum';
  if (canBoardPlaneNow()) return 'plane';
  const pie = nearestPieIndex();
  if (pie >= 0) {
    // Nearest of pie vs. dropped gun wins.
    if (canEquipGunNow()) {
      const dPie = camera.position.distanceTo(pies[pie].mesh.position);
      const dGun = camera.position.distanceTo(gunMesh.position);
      return dGun < dPie ? 'gun' : `pie:${pie}`;
    }
    return `pie:${pie}`;
  }
  const gift = nearestGiftIndex();
  if (gift >= 0) {
    // Nearest of gift vs. dropped gun wins.
    if (canEquipGunNow()) {
      const dGift = camera.position.distanceTo(gifts[gift].mesh.position);
      const dGun = camera.position.distanceTo(gunMesh.position);
      return dGun < dGift ? 'gun' : `gift:${gift}`;
    }
    return `gift:${gift}`;
  }
  if (canEquipGunNow()) return 'gun';
  return null;
}

// --- TV fix mechanic + TV audio (public/audio/tv.mp3) ---
function initTvAudio() {
  try {
    tvAudio = new Audio(`${import.meta.env.BASE_URL}audio/tv.mp3`);
    tvAudio.loop = true;
    tvAudio.volume = 0.5;
    tvAudio.addEventListener('error', () => {
      tvAudioError = true;
      console.warn('TV audio missing or failed to load: /audio/tv.mp3');
    });
  } catch (err) {
    console.warn('TV audio unavailable:', err);
    tvAudio = null;
  }
}
function tryPlayTvAudio() {
  // Audio only starts once the player has entered the game (pointer locked).
  // Skips when already playing or the file failed to load; play() rejections
  // (e.g. autoplay timing) are retried by the animate loop, not fatal.
  if (!tvAudio || tvFixed || tvAudioError || !controls.isLocked || !tvAudio.paused) return;
  try {
    const p = tvAudio.play();
    if (p && typeof p.catch === 'function') {
      p.catch((err) => {
        console.warn('TV audio play() rejected, will retry:', err?.name || err);
      });
    }
  } catch {
    // Autoplay blocked or file missing — retried later, non-fatal.
  }
}
const _tvCenter = new THREE.Vector3();
function tvCenter() {
  if (tvColliderReady) return _tvCenter.copy(tvObb.center);
  if (tvMesh) return _tvCenter.copy(tvMesh.position);
  return null;
}
function canFixTvNow() {
  if (!controls || !controls.isLocked || isFlying || tvFixed || !tvMesh) return false;
  const c = tvCenter();
  if (!c) return false;
  return camera.position.distanceTo(c) < PICKUP_RANGE;
}
function fixTV() {
  if (tvFixed) return;
  tvFixed = true;
  if (tvAudio) {
    try {
      tvAudio.pause();
      tvAudio.currentTime = 0;
    } catch {
      // Ignore audio teardown errors.
    }
  }
  console.log('TV fixed — audio stopped.');
}

// --- Airstrike button: E press -> button.mp3 + bomb.glb drop from 50m ---
function initButtonAudio() {
  try {
    buttonAudio = new Audio(`${import.meta.env.BASE_URL}audio/button.mp3`);
    buttonAudio.volume = 0.7;
    buttonAudio.addEventListener('error', () => {
      buttonAudioError = true;
      console.warn('Button audio missing: /audio/button.mp3 (add the file to public/audio/)');
    });
  } catch (err) {
    console.warn('Button audio unavailable:', err);
    buttonAudio = null;
    buttonAudioError = true;
  }
}
function initBombAudio() {
  try {
    bombAudio = new Audio(`${import.meta.env.BASE_URL}audio/bomb.mp3`);
    bombAudio.volume = 0.8;
    bombAudio.addEventListener('error', () => {
      bombAudioError = true;
      console.warn('Bomb audio missing: /audio/bomb.mp3 (add the file to public/audio/)');
    });
  } catch (err) {
    console.warn('Bomb audio unavailable:', err);
    bombAudio = null;
    bombAudioError = true;
  }
}
// --- Gift chime: coin.mp3 plays once when a gift bursts open ---
function initCoinAudio() {
  try {
    coinAudio = new Audio(`${import.meta.env.BASE_URL}audio/coin.mp3`);
    coinAudio.volume = 0.8;
    coinAudio.addEventListener('error', () => {
      coinAudioError = true;
      console.warn('Coin audio missing: /audio/coin.mp3 (add the file to public/audio/)');
    });
  } catch (err) {
    console.warn('Coin audio unavailable:', err);
    coinAudio = null;
    coinAudioError = true;
  }
}
function playCoinSound() {
  if (!coinAudio || coinAudioError) return;
  try {
    coinAudio.currentTime = 0;
    const p = coinAudio.play();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch {
    // Missing file — non-fatal.
  }
}
function playButtonSound() {
  if (!buttonAudio || buttonAudioError) return;
  try {
    buttonAudio.currentTime = 0;
    const p = buttonAudio.play();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch {
    // Missing file — non-fatal.
  }
}
function playBombSound() {
  // Plays from the moment the bomb falls until the sequence is done (~4s).
  if (!bombAudio || bombAudioError) return;
  try {
    bombAudio.currentTime = 0;
    const p = bombAudio.play();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch {
    // Missing file — non-fatal.
  }
}
function stopBombSound() {
  if (!bombAudio) return;
  try {
    bombAudio.pause();
    bombAudio.currentTime = 0;
  } catch {
    // Ignore teardown errors.
  }
}
function canPressButtonNow() {
  if (!controls || !controls.isLocked || isPossessed || isFlying || !buttonMesh) return false;
  if (bombState === 'falling') return false;
  if (performance.now() / 1000 < bombCooldownUntil) return false;
  return camera.position.distanceTo(buttonMesh.position) < PICKUP_RANGE;
}
function pressButton() {
  if (!buttonMesh || bombState === 'falling') return;
  playButtonSound();
  dropBomb();
}
function dropBomb() {
  // Drop point: directly above the TV so the strike lands on it; 50m up.
  const c = tvMesh ? tvCenter() : null;
  const bx = c ? c.x : 0;
  const bz = c ? c.z : -TV_SPAWN_DISTANCE;
  let groundY = cachedFloorY;
  if (roomMesh) {
    raycaster.set(_rayOrigin.set(bx, cachedFloorY + 60, bz), DOWN);
    const hits = raycaster.intersectObject(roomMesh, true);
    if (hits.length > 0) groundY = hits[0].point.y;
  }
  bombTargetY = groundY + 0.5;
  bombStartY = groundY + 50.0;
  if (bombTemplate) {
    bombMesh = bombTemplate.clone(true);
  } else {
    // Fallback: dark sphere so the strike still reads without the model.
    bombMesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.6, 16, 16),
      new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.6, metalness: 0.4 })
    );
  }
  bombMesh.position.set(bx, bombStartY, bz);
  bombMesh.traverse((obj) => {
    if (obj.isMesh) {
      obj.castShadow = true;
      obj.frustumCulled = false;
    }
  });
  scene.add(bombMesh);
  bombState = 'falling';
  bombTimer = 0;
  playBombSound();
  console.log('Bomb dropped from 50m.');
}
function updateBomb(delta) {
  if (bombState !== 'falling' || !bombMesh) return;
  bombTimer += delta;
  if (bombTimer < BOMB_FALL_DUR) {
    // Accelerating fall (ease-in) + spin for drama.
    const k = Math.min(1, bombTimer / BOMB_FALL_DUR);
    const eased = k * k;
    bombMesh.position.y = bombStartY + (bombTargetY - bombStartY) * eased;
    bombMesh.rotation.y += delta * 3.0;
  } else {
    detonateBomb();
  }
}
function detonateBomb() {
  const impact = bombMesh ? bombMesh.position.clone() : new THREE.Vector3(0, bombTargetY, 0);
  impact.y = bombTargetY;
  // Remove the falling mesh.
  if (bombMesh) {
    scene.remove(bombMesh);
    bombMesh = null;
  }
  bombState = 'done';
  // Big central blast + a few satellite pops for a map-wide feel.
  spawnExplosion(impact.clone().add(new THREE.Vector3(0, 0.6, 0)));
  spawnExplosion(impact.clone().add(new THREE.Vector3(2.5, 0.5, 1.5)));
  spawnExplosion(impact.clone().add(new THREE.Vector3(-2.5, 0.5, -1.5)));
  // Wipe the plants — except LEAF_SURVIVORS random survivors.
  {
    const alive = [];
    for (const leaf of leaves) {
      if (leaf && leaf.state === 'alive') alive.push(leaf);
    }
    // Fisher-Yates shuffle, keep the first N alive.
    for (let i = alive.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = alive[i];
      alive[i] = alive[j];
      alive[j] = tmp;
    }
    const keep = new Set(alive.slice(0, LEAF_SURVIVORS));
    for (const leaf of alive) {
      if (!keep.has(leaf)) startLeafDeath(leaf);
    }
  }
  // Trees fall over from the blast but NEVER disappear (stay lying down).
  toppleTrees();
  // Wipe the Bobs (instant death, no per-bob explosion spam, no cat flash).
  for (const b of bobs) {
    if (b && b.mesh && b.state !== 'dying' && b.state !== 'dead') {
      b.startDeath();
    }
  }
  // Pies flip around: blast fling — tossed upward/outward from impact
  // with a wild tumble, then they bounce and settle (still edible).
  for (const pie of pies) {
    if (!pie || pie.eaten || !pie.mesh) continue;
    const dx = pie.mesh.position.x - impact.x;
    const dz = pie.mesh.position.z - impact.z;
    const d = Math.hypot(dx, dz);
    const nx = d < 1e-4 ? Math.random() * 2 - 1 : dx / d;
    const nz = d < 1e-4 ? Math.random() * 2 - 1 : dz / d;
    const near = THREE.MathUtils.clamp(1 - d / 25, 0.3, 1); // closer = harder fling
    const push = (4 + Math.random() * 4) * near;
    pie.vel = new THREE.Vector3(
      nx * push + (Math.random() * 2 - 1),
      5 + Math.random() * 4 * near,
      nz * push + (Math.random() * 2 - 1)
    );
    pie.spin = new THREE.Vector3(
      (Math.random() * 2 - 1) * 10,
      (Math.random() * 2 - 1) * 6,
      (Math.random() * 2 - 1) * 10
    );
  }
  // Coins scatter from the blast too — re-launched with a wild tumble,
  // then they bounce and settle (still just shiny coins).
  for (const coin of coins) {
    if (!coin || !coin.mesh) continue;
    const dx = coin.mesh.position.x - impact.x;
    const dz = coin.mesh.position.z - impact.z;
    const d = Math.hypot(dx, dz);
    const nx = d < 1e-4 ? Math.random() * 2 - 1 : dx / d;
    const nz = d < 1e-4 ? Math.random() * 2 - 1 : dz / d;
    const near = THREE.MathUtils.clamp(1 - d / 25, 0.3, 1);
    const push = (4 + Math.random() * 4) * near;
    coin.settled = false;
    coin.vel = new THREE.Vector3(
      nx * push + (Math.random() * 2 - 1),
      5 + Math.random() * 4 * near,
      nz * push + (Math.random() * 2 - 1)
    );
    coin.spin = new THREE.Vector3(
      (Math.random() * 2 - 1) * 12,
      (Math.random() * 2 - 1) * 8,
      (Math.random() * 2 - 1) * 12
    );
  }
  // Coin goes flat (lying on the floor).
  if (pfpCoin && !coinFlattened) {
    coinFlattened = true;
    pfpSpinRemaining = 0;
    pfpCoin.rotation.set(Math.PI / 2, 0, 0);
    let gy = cachedFloorY;
    if (roomMesh) {
      raycaster.set(_rayOrigin.set(pfpCoin.position.x, cachedFloorY + 10, pfpCoin.position.z), DOWN);
      const hits = raycaster.intersectObject(roomMesh, true);
      if (hits.length > 0) gy = hits[0].point.y;
    }
    pfpCoin.position.y = gy + 0.15;
  }
  // TV goes flat (tipped over face-down).
  if (tvMesh && !tvFlattened) {
    tvFlattened = true;
    tvAngVel.set(0, 0, 0);
    tvMesh.rotation.set(-Math.PI / 2, 0, 0);
    tvMesh.updateMatrixWorld(true);
    // Seat it flat on the floor instead of clipping through.
    const box = new THREE.Box3().setFromObject(tvMesh);
    tvMesh.position.y += cachedFloorY - box.min.y + 0.02;
    updateTvCollider();
    // Silence the static like a fix.
    if (tvAudio) {
      try {
        tvAudio.pause();
        tvAudio.currentTime = 0;
      } catch {
        // Ignore teardown errors.
      }
    }
    tvFixed = true;
  }
  // End the ~4s bomb.mp3 window shortly after impact, then re-arm.
  setTimeout(() => {
    stopBombSound();
    bombState = 'idle';
    bombCooldownUntil = performance.now() / 1000 + 1.0;
  }, BOMB_DONE_DUR * 1000);
}

// --- Movement audio (public/audio/footsteps.mp3 + public/audio/run.mp3) ---
function initMovementAudio() {
  try {
    footAudio = new Audio(`${import.meta.env.BASE_URL}audio/footsteps.mp3`);
    footAudio.loop = true;
    footAudio.volume = 0.45;
    footAudio.addEventListener('error', () => {
      console.warn('Footsteps audio failed to load: /audio/footsteps.mp3');
    });
  } catch (err) {
    console.warn('Footsteps audio unavailable:', err);
    footAudio = null;
  }
  try {
    runAudio = new Audio(`${import.meta.env.BASE_URL}audio/run.mp3`);
    runAudio.loop = true;
    runAudio.volume = 0.55;
    runAudio.addEventListener('error', () => {
      console.warn('Run audio failed to load: /audio/run.mp3');
    });
  } catch (err) {
    console.warn('Run audio unavailable:', err);
    runAudio = null;
  }
}
function playLoop(audio) {
  if (!audio || !audio.paused) return;
  try {
    const p = audio.play();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch {
    // Autoplay blocked or file missing — retried next frame, non-fatal.
  }
}
function pauseLoop(audio) {
  if (!audio || audio.paused) return;
  try {
    audio.pause();
  } catch {
    // Ignore audio teardown errors.
  }
}

// --- Gunshot audio (/audio/shot.mp3) with synthesized fallback ---
function initShotAudio() {
  try {
    shotAudio = new Audio(`${import.meta.env.BASE_URL}audio/shot.mp3`);
    shotAudio.volume = 0.6;
    shotAudio.addEventListener('error', () => {
      shotAudioError = true;
      console.warn('Shot audio missing or failed to load: /audio/shot.mp3 (synth fallback)');
    });
  } catch (err) {
    console.warn('Shot audio unavailable:', err);
    shotAudio = null;
    shotAudioError = true;
  }
}
let _shotCtx = null;
function playShotSound() {
  if (shotAudio && !shotAudioError) {
    try {
      shotAudio.currentTime = 0;
      const p = shotAudio.play();
      if (p && typeof p.catch === 'function') {
        p.catch(() => {
          shotAudioError = true;
          playShotSoundSynth();
        });
      }
      return;
    } catch {
      shotAudioError = true;
    }
  }
  playShotSoundSynth();
}
function playShotSoundSynth() {
  // Fallback crack: short filtered noise burst via WebAudio.
  try {
    if (!_shotCtx) _shotCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (_shotCtx.state === 'suspended') _shotCtx.resume();
    const dur = 0.14;
    const buf = _shotCtx.createBuffer(1, Math.floor(_shotCtx.sampleRate * dur), _shotCtx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (data.length * 0.12));
    const src = _shotCtx.createBufferSource();
    src.buffer = buf;
    const filter = _shotCtx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(3200, _shotCtx.currentTime);
    filter.frequency.exponentialRampToValueAtTime(300, _shotCtx.currentTime + dur);
    const gain = _shotCtx.createGain();
    gain.gain.setValueAtTime(0.5, _shotCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, _shotCtx.currentTime + dur);
    src.connect(filter).connect(gain).connect(_shotCtx.destination);
    src.start();
  } catch {
    // Silent if WebAudio is unavailable — non-fatal.
  }
}

// Guarantee a proper lit PBR material for gun meshes: converts any
// basic/unlit or misconfigured material to MeshStandardMaterial, forces
// albedo textures to sRGB so baked colors match Blender, and keeps metals
// reflective (shared HDRI env) without ever going fully black.
function fixGunMaterial(mat) {
  let m = mat;
  if (!m.isMeshStandardMaterial && !m.isMeshPhysicalMaterial) {
    const std = new THREE.MeshStandardMaterial();
    if (mat.color) std.color.copy(mat.color);
    if (mat.map) std.map = mat.map;
    std.metalness = 0.6;
    std.roughness = 0.5;
    m = std;
  }
  // Albedo/emissive maps must be decoded as sRGB (linear maps like
  // metallic/roughness/normal are left untouched).
  for (const key of ['map', 'emissiveMap']) {
    const tex = m[key];
    if (tex && tex.isTexture && tex.colorSpace !== THREE.SRGBColorSpace) {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.needsUpdate = true;
    }
  }
  // Clamp full-metal so a diffuse term always survives (backstop for any
  // frame before the shared HDRI environment arrives), and lift reflections.
  if (typeof m.metalness === 'number') m.metalness = Math.min(m.metalness, 0.85);
  m.envMapIntensity = 1.2;
  m.needsUpdate = true;
  return m;
}

// Normalize any gun model to a hand-held size, level it flat, align its
// long axis with the view direction, and attach it to the HUD camera.
function setupGunMesh(root) {
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const s = GUN_SCALE_LEN / maxDim;
  root.scale.multiplyScalar(s);
  // Recenter so rotation pivots around the grip, not a far origin.
  const wrap = new THREE.Group();
  root.position.sub(center).multiplyScalar(s);
  wrap.add(root);
  // Align the longest axis with -Z (muzzle forward).
  gunBaseRotY = 0;
  if (size.x >= size.y && size.x >= size.z) gunBaseRotY = Math.PI / 2;
  wrap.traverse((obj) => {
    if (obj.isMesh) {
      obj.castShadow = false;
      obj.frustumCulled = false;
      if (Array.isArray(obj.material)) obj.material = obj.material.map(fixGunMaterial);
      else if (obj.material) obj.material = fixGunMaterial(obj.material);
    }
  });
  gunMesh = wrap;
  gunMuzzle = new THREE.Object3D();
  gunMuzzle.position.set(0, 0.03, -0.4);
  wrap.add(gunMuzzle);
  attachGunToCamera();
}

// --- Gun inventory: spawn equipped, drop on ball pickup, re-equip ---
function attachGunToCamera() {
  // Locked to the HUD viewport layer: fixed local matrix relative to the
  // HUD camera, leveled flat — unaffected by main-camera zoom/FOV.
  hudCamera.add(gunMesh);
  gunMesh.position.copy(GUN_HIP_POS);
  gunMesh.rotation.set(GUN_LEVEL_PITCH, gunBaseRotY, 0);
  gunEquipped = true;
}
function canEquipGunNow() {
  return (
    controls.isLocked &&
    !isPossessed &&
    !isFlying &&
    gunMesh &&
    !gunEquipped &&
    !ball.isCarried &&
    camera.position.distanceTo(gunMesh.position) < PICKUP_RANGE
  );
}
function equipGun() {
  if (!gunMesh || gunEquipped || ball.isCarried) return false;
  if (camera.position.distanceTo(gunMesh.position) >= PICKUP_RANGE) return false;
  attachGunToCamera();
  return true;
}
function dropGun() {
  // Hands are needed for the ball: the gun drops at the player's feet.
  if (!gunMesh || !gunEquipped) return;
  gunEquipped = false;
  scene.add(gunMesh);
  camera.getWorldDirection(_shotDir);
  _shotDir.y = 0;
  if (_shotDir.lengthSq() < 1e-6) _shotDir.set(0, 0, -1);
  _shotDir.normalize();
  const px = playerPos().x + _shotDir.x * 1.0;
  const pz = playerPos().z + _shotDir.z * 1.0;
  let py = playerPos().y - 1.4;
  if (roomMesh) {
    raycaster.set(_rayOrigin.set(px, playerPos().y + 5.0, pz), DOWN);
    const hits = raycaster.intersectObject(roomMesh, true);
    if (hits.length > 0) py = hits[0].point.y + 0.06;
  }
  gunMesh.position.set(px, py, pz);
  gunMesh.rotation.set(GUN_LEVEL_PITCH, Math.atan2(_shotDir.x, _shotDir.z), 0);
}

// --- Hitscan firing: raycast from the camera/gun, tracer + recoil ---
// Tracer origin approximating the HUD gun tip in world space (the gun
// itself lives in the fixed HUD layer, so project a matching offset off
// the main camera: forward + right + slightly down).
function muzzleWorldPos(out) {
  camera.getWorldDirection(_shotDir);
  _shotDir.normalize();
  _shotRight.crossVectors(_shotDir, camera.up).normalize();
  return out
    .copy(camera.position)
    .addScaledVector(_shotDir, 0.7)
    .addScaledVector(_shotRight, 0.22)
    .addScaledVector(camera.up, -0.18);
}
function spawnTracer(a, b) {
  if (!tracer) {
    const geom = new THREE.BufferGeometry().setFromPoints([a, b]);
    tracer = new THREE.Line(
      geom,
      new THREE.LineBasicMaterial({
        color: 0xfff2a8,
        transparent: true,
        opacity: 0.9,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    tracer.frustumCulled = false;
    scene.add(tracer);
  } else {
    const attr = tracer.geometry.getAttribute('position');
    attr.setXYZ(0, a.x, a.y, a.z);
    attr.setXYZ(1, b.x, b.y, b.z);
    attr.needsUpdate = true;
    tracer.visible = true;
  }
  tracerLife = TRACER_MAX_LIFE;
  tracer.material.opacity = 0.9;
}
function fireGun() {
  // Usable on foot and while possessing (same camera, gun stays equipped).
  if (!controls.isLocked || !gunEquipped || !gunMesh) return;
  const now = performance.now() / 1000;
  if (now - lastShotTime < SHOT_COOLDOWN) return;
  lastShotTime = now;
  playShotSound();
  gunKick = 1;
  camera.getWorldDirection(_shotDir);
  _shotDir.normalize();
  raycaster.set(camera.position, _shotDir);
  const targets = [];
  if (tvMesh) targets.push(tvMesh);
  if (ball.mesh && !ball.isCarried) targets.push(ball.mesh);
  if (pfpCoin) targets.push(pfpCoin);
  // Never hit your own ride while possessing.
  if (vacuum.mesh && !vacuum.isCarried && !isPossessed) targets.push(vacuum.mesh);
  if (roomMesh) targets.push(roomMesh);
  const hits = raycaster.intersectObjects(targets, true);
  // Bob is tested against his tight collision box (accurate for the rigged
  // model and far cheaper than per-triangle skinning raycasts); nearest
  // object along the ray wins, so cover and walls still block shots at him.
  // Test all Bobs, keep nearest hit
  let bestBob = null;
  let bestBobDist = Infinity;
  for (const b of bobs) {
    const d = b.rayHitDistance(raycaster.ray);
    if (d !== null && d < bestBobDist) { bestBobDist = d; bestBob = b; }
  }
  // Leaves (instanced): pure-math broadphase over 1485 instances — no
  // per-triangle raycasts, so a shot stays O(n) cheap. Radius scales with
  // the instance so big leaves are easier to hit.
  let bestLeaf = null;
  let bestLeafDist = Infinity;
  let bestLeafPoint = null;
  for (const leaf of leaves) {
    if (leaf.state === 'dead' || leaf.state === 'dying') continue;
    const lp = leaf.basePos;
    if (!lp) continue;
    _shotR.subVectors(lp, raycaster.ray.origin);
    const along = _shotR.dot(raycaster.ray.direction);
    if (along < 0 || along > bestLeafDist) continue;
    if (along > sceneDist) continue; // walls/props already block the shot
    const radius = 0.35 * (leaf.baseScale || 1) + 0.4;
    if (raycaster.ray.distanceToPoint(lp) > radius) continue;
    bestLeafDist = along;
    bestLeaf = leaf;
    bestLeafPoint = raycaster.ray.at(along, new THREE.Vector3());
  }
  const sceneDist = hits.length > 0 ? hits[0].distance : Infinity;
  const start = muzzleWorldPos(new THREE.Vector3());
  let end;
  if (bestBob && bestBobDist <= sceneDist && bestBobDist <= bestLeafDist) {
    end = raycaster.ray.at(bestBobDist, new THREE.Vector3());
    applyShotToBob(bestBob);
  } else if (bestLeaf && bestLeafDist <= sceneDist) {
    end = bestLeafPoint.clone();
    applyShotToLeaf(bestLeaf);
  } else if (hits.length > 0) {
    const h = hits[0];
    end = h.point.clone();
    // Climb to the direct child of the scene to identify the owner.
    let root = h.object;
    while (root.parent && root.parent !== scene) root = root.parent;
    if (root === tvMesh) applyShotToTv(h.point, _shotDir);
    else if (root === ball.mesh) applyShotToBall(h.point, _shotDir);
    else if (root === pfpCoin) applyShotToPfp();
    else if (root === vacuum.mesh) applyShotToVacuum(h.point, _shotDir);
  } else {
    end = camera.position.clone().addScaledVector(_shotDir, 60);
  }
  spawnTracer(start, end);
}

// --- Impact physics: anchored position + subtle single-axis kickback ---
// The TV's world position is fully anchored (shots never shift it); each
// shot only rotates it on the one intended hit axis (dominant torque
// component, roll always locked), at 30% of the already-reduced strength
// (an additional 70% reduction) for a faint, realistic nudge.
function applyShotToTv(point, dir) {
  if (!tvMesh) return;
  // Torque from the contact offset: shooting one side swings that side
  // back (r × impulse) — then keep ONLY the dominant axis component.
  const c = tvCenter();
  if (c) {
    _shotR.subVectors(point, c);
    _shotTorque.crossVectors(_shotR, dir).multiplyScalar(0.81);
    _shotTorque.z = 0; // roll stays planted, always
    const ax = Math.abs(_shotTorque.x);
    const ay = Math.abs(_shotTorque.y);
    if (ax >= ay) {
      tvAngVel.x += _shotTorque.x;
      tvAngVel.y = 0;
    } else {
      tvAngVel.y += _shotTorque.y;
      tvAngVel.x = 0;
    }
    tvAngVel.z = 0;
    if (tvAngVel.length() > 0.81) tvAngVel.setLength(0.81);
  }
}
function updateTvPhysics(delta) {
  if (!tvMesh) return;
  if (tvAngVel.lengthSq() >= 1e-6) {
    // Position stays anchored: lock the set to its spawn coordinates.
    tvMesh.position.y = tvBaseY;
    // Single-axis rotation only: pitch rocks and settles back upright,
    // yaw spin persists. Roll is never touched (locked at 0).
    tvMesh.rotation.x += tvAngVel.x * delta;
    tvMesh.rotation.y += tvAngVel.y * delta;
    tvMesh.rotation.z = 0;
    const angDamp = Math.max(0, 1 - 2.5 * delta);
    tvAngVel.multiplyScalar(angDamp);
    // Rocking tilt settles back upright; yaw spin persists.
    const settle = Math.max(0, 1 - 4.0 * delta);
    tvMesh.rotation.x *= settle;
    if (tvAngVel.lengthSq() < 1e-6) tvAngVel.set(0, 0, 0);
  }
  // Re-glue the collider to the mesh every frame (cheap OBB re-pose, no
  // geometry traversal), so it tracks rotation exactly — even mid-spin.
  updateTvCollider();
}
/**
 * Re-pose the TV's oriented collider from the mesh's current world matrix
 * and refresh the axis-aligned broadphase from its 8 rotated corners.
 * Runs every frame: the collision box rotates along with the mesh in real
 * time instead of going stale or ballooning like a raw AABB would.
 */
function updateTvCollider() {
  if (!tvMesh || !tvColliderReady) return;
  tvMesh.updateMatrixWorld(true);
  // Rotation only (quaternion path strips any scale); halfSize is constant.
  tvMesh.getWorldQuaternion(_tvQuat);
  _tvM4.makeRotationFromQuaternion(_tvQuat);
  tvObb.rotation.setFromMatrix4(_tvM4);
  tvObb.center.copy(tvLocalCenter).applyMatrix4(tvMesh.matrixWorld);
  // Tight AABB broadphase from the rotated corners.
  tvCollider.makeEmpty();
  for (let i = 0; i < 8; i++) {
    _tvCorner.set(
      i & 1 ? tvLocalBox.max.x : tvLocalBox.min.x,
      i & 2 ? tvLocalBox.max.y : tvLocalBox.min.y,
      i & 4 ? tvLocalBox.max.z : tvLocalBox.min.z
    ).applyMatrix4(tvMesh.matrixWorld);
    tvCollider.expandByPoint(_tvCorner);
  }
}
function applyShotToBall(point, dir) {
  if (!ball.mesh) return;
  const c = ball.mesh.position;
  _shotR.subVectors(point, c);
  const offCenter = THREE.MathUtils.clamp(_shotR.length() / Math.max(ball.radius, 0.01), 0, 1.5);
  // Through-contact kick (harder when off-center) plus a pop that grows
  // when the contact is low on the ball.
  ball.velocity.addScaledVector(dir, 6.0 + 3.0 * offCenter);
  ball.velocity.y += 1.0 + Math.max(0, c.y - point.y) * 4.0;
  ball.releaseGrace = Math.max(ball.releaseGrace, 0.15);
}
// Giant pfp coin: textured cylinder standing upright + floating name tag.
function createPfpCoin(px, pz, groundY) {
  const group = new THREE.Group();
  const RADIUS = 1.8;
  const THICK = 0.18;
  const loader = new THREE.TextureLoader();
  loader.load(
    `${import.meta.env.BASE_URL}models/pfp.png`,
    (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      const faceMat = new THREE.MeshStandardMaterial({
        map: tex,
        metalness: 0.15,
        roughness: 0.5,
      });
      const edgeMat = new THREE.MeshStandardMaterial({
        color: 0xd4af37,
        metalness: 0.85,
        roughness: 0.3,
      });
      // Cylinder axis is Y; rotate X 90° so the faces look ±Z (coin facing
      // the room), then a Y-spin reads as a Mario-coin flip.
      const geo = new THREE.CylinderGeometry(RADIUS, RADIUS, THICK, 48);
      const coin = new THREE.Mesh(geo, [edgeMat, faceMat, faceMat]);
      coin.rotation.x = Math.PI / 2;
      coin.castShadow = true;
      coin.receiveShadow = true;
      group.add(coin);
    },
    undefined,
    (err) => {
      console.warn('Could not load pfp.png, using gold fallback:', err);
      const fallback = new THREE.Mesh(
        new THREE.CylinderGeometry(RADIUS, RADIUS, THICK, 48),
        new THREE.MeshStandardMaterial({ color: 0xd4af37, metalness: 0.85, roughness: 0.3 })
      );
      fallback.rotation.x = Math.PI / 2;
      fallback.castShadow = true;
      group.add(fallback);
    }
  );
  // Stand upright with the bottom rim resting on the floor.
  group.position.set(px, groundY + RADIUS + 0.02, pz);
  // Face the room center so both faces are visible from spawn.
  group.rotation.y = Math.atan2(-px, -pz);
  group.traverse((obj) => {
    if (obj.isMesh) obj.frustumCulled = true;
  });
  scene.add(group);
  pfpCoin = group;
  // Floating "Klint" nametag above the coin (auto-faces camera as a Sprite).
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.font = 'bold 72px Inter, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffffff';
  ctx.fillText('Klint', 256, 64);
  const labelTex = new THREE.CanvasTexture(canvas);
  labelTex.colorSpace = THREE.SRGBColorSpace;
  const labelMat = new THREE.SpriteMaterial({ map: labelTex, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(labelMat);
  sprite.scale.set(3.2, 0.8, 1);
  sprite.position.set(px, groundY + RADIUS * 2 + 1.0, pz);
  scene.add(sprite);
  pfpLabel = sprite;
}
// Gun hit: queue exactly one full 360° coin spin (stacks if spammed).
function applyShotToPfp() {
  if (!pfpCoin) return;
  pfpSpinRemaining += Math.PI * 2;
}
function updatePfpCoin(delta) {
  if (!pfpCoin || pfpSpinRemaining <= 0) return;
  const step = Math.min(pfpSpinRemaining, PFP_SPIN_SPEED * delta);
  pfpCoin.rotation.y += step;
  pfpSpinRemaining -= step;
  if (pfpSpinRemaining < 1e-4) pfpSpinRemaining = 0;
}
function applyShotToVacuum(point, dir) {
  if (!vacuum.mesh) return;
  // Shove the body (clamped to the room) and yaw it with the true
  // torque direction about Y so side hits spin it.
  const rp = vacuum.mesh.position;
  const yawTorque = dir.x * (point.z - rp.z) - dir.z * (point.x - rp.x);
  vacuum.mesh.rotation.y += 0.8 * Math.sign(yawTorque || 1);
  rp.x += dir.x * 0.5;
  rp.z += dir.z * 0.5;
  rp.x = Math.max(vacuum.floorMin.x, Math.min(vacuum.floorMax.x, rp.x));
  rp.z = Math.max(vacuum.floorMin.z, Math.min(vacuum.floorMax.z, rp.z));
  vacuum.resolveObstacleCollisions();
}
// Cat flash on Bob kill: fullscreen cat.png for 1s then fade 0.7s
let catFlashTimer = null;
function triggerCatFlash() {
  let el = document.getElementById('cat-flash');
  if (!el) {
    el = document.createElement('img');
    el.id = 'cat-flash';
    el.src = `${import.meta.env.BASE_URL}models/cat.png`;
    el.style.cssText =
      'position:fixed;inset:0;width:100vw;height:100vh;object-fit:cover;' +
      'z-index:9999;pointer-events:none;opacity:1;transition:none;display:block;';
    document.body.appendChild(el);
  }
  // reset any ongoing fade
  el.style.transition = 'none';
  el.style.opacity = '1';
  el.style.display = 'block';
  // force reflow so transition reset takes effect
  void el.offsetWidth;
  if (catFlashTimer) clearTimeout(catFlashTimer);
  // after 0.5s solid, fade out over 0.35s (half of original 1s+0.7s)
  catFlashTimer = setTimeout(() => {
    el.style.transition = 'opacity 0.35s ease';
    el.style.opacity = '0';
    catFlashTimer = setTimeout(() => {
      el.style.display = 'none';
    }, 350);
  }, 500);
}

// Bob takes 6 hits: gun hitscan registers damage, death handled in Bob.
// 50% of kills also detonate a particle explosion.
function applyShotToBob(hitBob) {
  const target = hitBob || bob;
  if (!target.mesh) return;
  const killed = target.registerHit();
  if (killed) {
    triggerCatFlash();
    // Coin flip: half the Bob kills explode.
    if (Math.random() < 0.5 && target.mesh) {
      spawnExplosion(target.mesh.position.clone().add(new THREE.Vector3(0, 0.6, 0)));
    }
  }
}
// --- Shootable leaves (instanced): 3 hits, shake on hit, fall + shrink death ---
// Per-instance opacity isn't possible on InstancedMesh, so death reads the
// same (tips over sideways, then sinks/shrinks away) via matrix updates.
// Only hit/dying instances touch the instanceMatrix — static ones cost zero.
function writeLeafInstance(leaf, px, py, pz, rotX, rotY, rotZ, scale) {
  if (!leafInst) return;
  _leafDummy.position.set(px, py, pz);
  _leafDummy.rotation.set(rotX, rotY, rotZ);
  _leafDummy.scale.setScalar(Math.max(0.0001, scale));
  _leafDummy.updateMatrix();
  leafInst.setMatrixAt(leaf.index, _leafDummy.matrix);
  leafInst.instanceMatrix.needsUpdate = true;
}
function applyShotToLeaf(leaf) {
  if (!leaf || leaf.state === 'dying' || leaf.state === 'dead' || !leafInst) return;
  leaf.hitsTaken += 1;
  leaf.shake = 0.35; // shake burst, decays in updateLeaves
  leaf.settled = false;
  // Hit flash: tint this instance green, restore to white shortly after.
  leafInst.setColorAt(leaf.index, _leafColor.setHex(0x66ff66));
  if (leafInst.instanceColor) leafInst.instanceColor.needsUpdate = true;
  setTimeout(() => {
    if (!leafInst || leaf.state === 'dead') return;
    leafInst.setColorAt(leaf.index, _leafColor.setHex(leaf.baseColor ?? 0xffffff));
    if (leafInst.instanceColor) leafInst.instanceColor.needsUpdate = true;
  }, 120);
  if (leaf.hitsTaken >= leaf.maxHits) startLeafDeath(leaf);
}
function startLeafDeath(leaf) {
  leaf.state = 'dying';
  leaf.deathTimer = 0;
  leaf.deathStartZ = 0;
  leaf.shake = 0;
  leaf.settled = false;
}
function updateLeaves(delta, time) {
  if (!leafInst || leaves.length === 0) return;
  for (const leaf of leaves) {
    if (leaf.state === 'dead') continue;
    if (leaf.state === 'dying') {
      leaf.deathTimer += delta;
      const t = leaf.deathTimer;
      if (t < leaf.deathFallDur) {
        // Fall sideways: roll onto side (same as Bob).
        const k = t / leaf.deathFallDur;
        const eased = 1 - (1 - k) * (1 - k);
        writeLeafInstance(
          leaf,
          leaf.basePos.x, leaf.basePos.y, leaf.basePos.z,
          0, leaf.baseRotY, eased * (Math.PI / 2),
          leaf.baseScale
        );
      } else {
        // Sink + shrink away (replaces per-material opacity fade).
        const fadeT = Math.min(1, (t - leaf.deathFallDur) / leaf.deathFadeDur);
        const scale = leaf.baseScale * (1 - fadeT);
        writeLeafInstance(
          leaf,
          leaf.basePos.x, leaf.basePos.y - fadeT * 0.5, leaf.basePos.z,
          0, leaf.baseRotY, Math.PI / 2,
          scale
        );
        if (fadeT >= 1) {
          writeLeafInstance(leaf, 0, -100, 0, 0, 0, 0, 0.0001);
          leaf.state = 'dead';
        }
      }
      continue;
    }
    // Alive: shake decay — positional + rotational jitter around base pose.
    // Fully static leaves are skipped (frozen matrices, zero cost).
    if (leaf.shake > 0) {
      leaf.shake = Math.max(0, leaf.shake - delta);
      const s = leaf.shake / 0.35; // 1 -> 0 over the burst
      const f = time * 0.06;
      if (leaf.shake === 0) {
        // Snap back exactly once the shake ends.
        writeLeafInstance(
          leaf,
          leaf.basePos.x, leaf.basePos.y, leaf.basePos.z,
          0, leaf.baseRotY, 0,
          leaf.baseScale
        );
        leaf.settled = true;
      } else {
        // Jitter scales with plant size so the shake reads on big bushes.
        const j = 0.06 * s * leaf.baseScale;
        writeLeafInstance(
          leaf,
          leaf.basePos.x + Math.sin(f) * j,
          leaf.basePos.y,
          leaf.basePos.z + Math.cos(f * 1.3) * j,
          Math.cos(f * 0.9) * 0.1 * s,
          leaf.baseRotY,
          Math.sin(f * 1.1) * 0.12 * s,
          leaf.baseScale
        );
      }
    } else if (!leaf.settled) {
      // Safety net: snap back once if shake was cleared elsewhere.
      writeLeafInstance(
        leaf,
        leaf.basePos.x, leaf.basePos.y, leaf.basePos.z,
        0, leaf.baseRotY, 0,
        leaf.baseScale
      );
      leaf.settled = true;
    }
  }
}
// --- Trees (instanced): bomb blast topples them, they stay lying down ---
// Every sub-mesh shares the same per-tree matrix, so falling updates all
// InstancedMeshes with the same dummy pose. Fallen trees are never removed.
function writeTreeInstance(i) {
  const t = trees[i];
  if (!t) return;
  // Tip 0 -> 90° with ease-out; lying height keeps the trunk resting on
  // the floor instead of clipping through it.
  const k = t.state === 'standing' ? 0 : Math.min(1, Math.max(0, t.fallTimer) / t.fallDur);
  const eased = 1 - (1 - k) * (1 - k);
  const tip = eased * (Math.PI / 2 - 0.06);
  const standY = cachedFloorY + t.yOff * t.s;
  const lieY = cachedFloorY + TRUNK_R * t.s;
  _treeDummy.position.set(t.x, standY + (lieY - standY) * eased, t.z);
  _treeDummy.rotation.order = 'YXZ';
  if (t.fallAxis === 'x') _treeDummy.rotation.set(t.fallSign * tip, t.rotY, 0);
  else _treeDummy.rotation.set(0, t.rotY, t.fallSign * tip);
  _treeDummy.scale.setScalar(t.s);
  _treeDummy.updateMatrix();
  for (const inst of treeInstMeshes) {
    inst.setMatrixAt(i, _treeDummy.matrix);
  }
  for (const inst of treeInstMeshes) {
    inst.instanceMatrix.needsUpdate = true;
  }
  // Refresh the collider from the live pose: world-space tip of the trunk
  // (base -> tip segment in XZ) plus trunk-top height for jump-over checks.
  _tipV.set(0, treeHeight * t.s, 0).applyMatrix4(_treeDummy.matrix);
  t.tipX = _tipV.x;
  t.tipZ = _tipV.z;
  t.topY = _tipV.y + TRUNK_R * t.s;
}
function toppleTrees() {
  // Blast knocks every standing tree over (staggered start, random side).
  // Fallen trees stay — nothing here removes or hides any instance.
  for (const t of trees) {
    if (t.state !== 'standing') continue;
    t.state = 'falling';
    t.fallTimer = -t.fallDelay;
  }
}
function updateTrees(delta) {
  if (trees.length === 0 || treeInstMeshes.length === 0) return;
  let anyDirty = false;
  for (let i = 0; i < trees.length; i++) {
    const t = trees[i];
    if (t.state !== 'falling') continue;
    t.fallTimer += delta;
    if (t.fallTimer < 0) continue; // stagger delay before this tree starts
    if (t.fallTimer >= t.fallDur) {
      t.fallTimer = t.fallDur;
      t.state = 'fallen';
    }
    writeTreeInstance(i);
    anyDirty = true;
  }
  if (anyDirty) {
    for (const inst of treeInstMeshes) inst.instanceMatrix.needsUpdate = true;
  }
}
// --- Explosion FX: flash sphere + debris burst, ~0.9s then cleaned up ---
function spawnExplosion(pos) {
  const group = new THREE.Group();
  group.position.copy(pos);
  const flash = new THREE.Mesh(
    new THREE.SphereGeometry(0.5, 16, 16),
    new THREE.MeshBasicMaterial({
      color: 0xffaa33,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
  );
  flash.frustumCulled = false;
  group.add(flash);
  const parts = [];
  const partGeo = new THREE.BoxGeometry(0.12, 0.12, 0.12);
  const colors = [0xff5533, 0xffaa22, 0x555555, 0x222222, 0xffcc66];
  for (let i = 0; i < 26; i++) {
    const mat = new THREE.MeshBasicMaterial({
      color: colors[i % colors.length],
      transparent: true,
      opacity: 1,
    });
    const m = new THREE.Mesh(partGeo, mat);
    m.position.set(0, 0, 0);
    const th = Math.random() * Math.PI * 2;
    const ph = Math.acos(2 * Math.random() - 1);
    const sp = 3 + Math.random() * 6;
    parts.push({
      mesh: m,
      vel: new THREE.Vector3(
        Math.sin(ph) * Math.cos(th) * sp,
        Math.abs(Math.cos(ph)) * sp + 2.0,
        Math.sin(ph) * Math.sin(th) * sp
      ),
    });
    group.add(m);
  }
  // Point light pop (no shadow) for punch.
  const light = new THREE.PointLight(0xff8833, 8, 8, 2);
  group.add(light);
  scene.add(group);
  // Reuse the gunshot crack for the blast (no new asset needed).
  playShotSound();
  explosions.push({ group, flash, light, parts, life: 0, maxLife: 0.9 });
}
function updateExplosions(delta) {
  for (let i = explosions.length - 1; i >= 0; i--) {
    const ex = explosions[i];
    ex.life += delta;
    const k = Math.min(1, ex.life / ex.maxLife);
    // Flash: expand fast, fade out.
    const s = 1 + k * 5;
    ex.flash.scale.set(s, s, s);
    ex.flash.material.opacity = 0.95 * (1 - k);
    if (ex.light) ex.light.intensity = 8 * (1 - k);
    for (const p of ex.parts) {
      p.vel.y -= 12 * delta; // debris gravity
      p.mesh.position.addScaledVector(p.vel, delta);
      p.mesh.rotation.x += delta * 6;
      p.mesh.rotation.y += delta * 5;
      p.mesh?.material && (p.mesh.material.opacity = 1 - k);
    }
    if (k >= 1) {
      scene.remove(ex.group);
      ex.flash.geometry.dispose();
      ex.flash.material.dispose();
      for (const p of ex.parts) {
        p.mesh.material.dispose();
      }
      // Shared box geometry dispose once.
      if (ex.parts.length > 0) ex.parts[0].mesh.geometry.dispose();
      if (ex.light) ex.light.dispose?.();
      explosions.splice(i, 1);
    }
  }
}
// Clone a skinned glTF scene preserving Skeleton/Skin bindings
function cloneSkinned(source) {
  const clone = source.clone(true);
  const sourceMap = new Map();
  source.traverse((o) => sourceMap.set(o.name, o));
  const cloneMap = new Map();
  clone.traverse((o) => cloneMap.set(o.name, o));
  clone.traverse((o) => {
    if (o.isSkinnedMesh && o.skeleton) {
      const srcMesh = sourceMap.get(o.name);
      if (!srcMesh || !srcMesh.skeleton) return;
      const orderedBones = srcMesh.skeleton.bones.map((b) => cloneMap.get(b.name)).filter(Boolean);
      o.skeleton = new THREE.Skeleton(orderedBones, srcMesh.skeleton.boneInverses.slice());
      o.bind(o.skeleton, o.bindMatrix.clone());
    }
  });
  return clone;
}
// 3D Billboard / Leaderboard — flat PlaneGeometry + Canvas texture
let leaderboardMesh = null;
let femboyMesh = null;
function createLeaderboard(pos, floorYRef) {
  const subscribers = ['sandramandic6261', 'TurtleLovrTricia', 'buddyraceofficial123', 'vman2editor', 'CatAgent-luv'];
  const W = 1024, H = 768;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  function draw() {
    ctx.clearRect(0,0,W,H);
    ctx.fillStyle='rgba(18,18,22,0.92)'; ctx.strokeStyle='rgba(255,255,255,0.18)'; ctx.lineWidth=6;
    ctx.beginPath(); if(ctx.roundRect) ctx.roundRect(12,12,W-24,H-24,32); else ctx.rect(12,12,W-24,H-24); ctx.fill(); ctx.stroke();
    ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.font='bold 64px Inter, system-ui, sans-serif'; ctx.fillStyle='#ffffff';
    ctx.shadowColor='rgba(255,255,255,0.35)'; ctx.shadowBlur=12; ctx.fillText('SUBSCRIBERS', W/2, 90); ctx.shadowBlur=0;
    ctx.strokeStyle='rgba(255,255,255,0.12)'; ctx.lineWidth=2; ctx.beginPath(); ctx.moveTo(60,135); ctx.lineTo(W-60,135); ctx.stroke();
    const startY=195, rowH=95;
    subscribers.forEach((name,i)=>{
      const y=startY+i*rowH;
      ctx.fillStyle=i%2===0?'rgba(255,255,255,0.06)':'rgba(255,255,255,0.03)';
      ctx.beginPath(); if(ctx.roundRect) ctx.roundRect(40,y-38,W-80,76,16); else ctx.rect(40,y-38,W-80,76); ctx.fill();
      let rankColor='#ffffff'; if(i===0) rankColor='#FFD700'; else if(i===1) rankColor='#C0C0C0'; else if(i===2) rankColor='#CD7F32';
      ctx.textAlign='left'; ctx.font='bold 48px Inter, system-ui, sans-serif'; ctx.fillStyle=rankColor; ctx.fillText(`#${i+1}`,70,y);
      ctx.font='500 46px Inter, system-ui, sans-serif'; ctx.fillStyle='#f2f2f2'; ctx.fillText(name,180,y);
    });
    ctx.textAlign='center'; ctx.font='28px Inter, system-ui, sans-serif'; ctx.fillStyle='rgba(255,255,255,0.45)'; ctx.fillText(`${subscribers.length} Subscribers`, W/2, H-50);
  }
  draw();
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace=THREE.SRGBColorSpace; texture.minFilter=THREE.LinearFilter; texture.magFilter=THREE.LinearFilter;
  if(document.fonts&&document.fonts.ready) document.fonts.ready.then(()=>{draw(); texture.needsUpdate=true;}).catch(()=>{});
  const aspect=W/H, height=2.6, width=height*aspect;
  const geo=new THREE.PlaneGeometry(width,height);
  const mat=new THREE.MeshBasicMaterial({map:texture, transparent:true, side:THREE.DoubleSide});
  const mesh=new THREE.Mesh(geo,mat);
  // clamp inside floor bounds so 15m request stays visible on small maps
  let p=pos.clone();
  if(vacuum.floorMin&&vacuum.floorMax){
    p.x=THREE.MathUtils.clamp(p.x, vacuum.floorMin.x+1, vacuum.floorMax.x-1);
    p.z=THREE.MathUtils.clamp(p.z, vacuum.floorMin.z+1, vacuum.floorMax.z-1);
    p.y=Math.max(p.y, (floorYRef!==undefined?floorYRef:cachedFloorY)+1.2);
  }
  mesh.position.copy(p);
  mesh.frustumCulled=false; mesh.renderOrder=10;
  // face toward player spawn
  mesh.lookAt(0, p.y, 0);
  scene.add(mesh);
  leaderboardMesh=mesh;
  // gentle hover
  mesh.userData.baseY=p.y; mesh.userData.phase=0;
  return mesh;
}
// FEMBOY board — JUST like the leaderboard: same dark plate, same size,
// same hover/lookAt behavior, but titled "FEMBOY" with femboy.png inside.
function createFemboyBoard(pos, floorYRef) {
  const W = 1024, H = 768;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const img = new Image();
  img.src = `${import.meta.env.BASE_URL}models/femboy.png`;
  function draw() {
    ctx.clearRect(0,0,W,H);
    ctx.fillStyle='rgba(18,18,22,0.92)'; ctx.strokeStyle='rgba(255,255,255,0.18)'; ctx.lineWidth=6;
    ctx.beginPath(); if(ctx.roundRect) ctx.roundRect(12,12,W-24,H-24,32); else ctx.rect(12,12,W-24,H-24); ctx.fill(); ctx.stroke();
    ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.font='bold 64px Inter, system-ui, sans-serif'; ctx.fillStyle='#ffffff';
    ctx.shadowColor='rgba(255,255,255,0.35)'; ctx.shadowBlur=12; ctx.fillText('FEMBOY', W/2, 90); ctx.shadowBlur=0;
    ctx.strokeStyle='rgba(255,255,255,0.12)'; ctx.lineWidth=2; ctx.beginPath(); ctx.moveTo(60,135); ctx.lineTo(W-60,135); ctx.stroke();
    // femboy.png below the title, contained in the plate.
    const padX = 60, topY = 160, botY = H - 40;
    const boxW = W - padX*2, boxH = botY - topY;
    if (img.complete && img.naturalWidth > 0) {
      const s = Math.min(boxW / img.naturalWidth, boxH / img.naturalHeight);
      const dw = img.naturalWidth * s, dh = img.naturalHeight * s;
      const dx = W/2 - dw/2, dy = topY + (boxH - dh)/2;
      try { ctx.drawImage(img, dx, dy, dw, dh); } catch {}
    } else {
      ctx.font='28px Inter, system-ui, sans-serif'; ctx.fillStyle='rgba(255,255,255,0.45)';
      ctx.fillText('loading femboy.png…', W/2, topY + boxH/2);
    }
  }
  draw();
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace=THREE.SRGBColorSpace; texture.minFilter=THREE.LinearFilter; texture.magFilter=THREE.LinearFilter;
  img.onload = () => { draw(); texture.needsUpdate=true; };
  img.onerror = (err) => { console.warn('Could not load femboy.png:', err); };
  if(document.fonts&&document.fonts.ready) document.fonts.ready.then(()=>{draw(); texture.needsUpdate=true;}).catch(()=>{});
  const aspect=W/H, height=2.6, width=height*aspect;
  const geo=new THREE.PlaneGeometry(width,height);
  const mat=new THREE.MeshBasicMaterial({map:texture, transparent:true, side:THREE.DoubleSide});
  const mesh=new THREE.Mesh(geo,mat);
  // clamp inside floor bounds so the 15m request stays visible on small maps
  let p=pos.clone();
  if(vacuum.floorMin&&vacuum.floorMax){
    p.x=THREE.MathUtils.clamp(p.x, vacuum.floorMin.x+1, vacuum.floorMax.x-1);
    p.z=THREE.MathUtils.clamp(p.z, vacuum.floorMin.z+1, vacuum.floorMax.z-1);
    p.y=Math.max(p.y, (floorYRef!==undefined?floorYRef:cachedFloorY)+1.2);
  }
  mesh.position.copy(p);
  mesh.frustumCulled=false; mesh.renderOrder=10;
  // face toward player spawn
  mesh.lookAt(0, p.y, 0);
  scene.add(mesh);
  femboyMesh=mesh;
  // gentle hover
  mesh.userData.baseY=p.y; mesh.userData.phase=0;
  return mesh;
}
function updateMovementAudio() {
  if (isFlying) {
    pauseLoop(footAudio);
    pauseLoop(runAudio);
    return;
  }
  const moving =
    moveForward ||
    moveBackward ||
    moveLeft ||
    moveRight ||
    mobileMove.x !== 0 ||
    mobileMove.y !== 0;
  const grounded = isPossessed ? possessGrounded : isGrounded;
  if (!controls.isLocked || !moving || !grounded) {
    pauseLoop(footAudio);
    pauseLoop(runAudio);
    return;
  }
  // Sprinting speed → run.mp3; normal walking speed → footsteps.mp3.
  if (isSprintingNow()) {
    pauseLoop(footAudio);
    playLoop(runAudio);
  } else {
    pauseLoop(runAudio);
    playLoop(footAudio);
  }
}

function setRingProgress(progress) {
  if (!ringFg) return;
  const clamped = THREE.MathUtils.clamp(progress / HOLD_DURATION, 0, 1);
  ringFg.style.strokeDashoffset = `${RING_C * (1 - clamped)}`;
}

const _projV = new THREE.Vector3();
// Scratch values reused every frame so the hot loop allocates nothing
// (avoids GC stutters). Raycaster.set() copies these in.
const DOWN = new THREE.Vector3(0, -1, 0);
const _rayOrigin = new THREE.Vector3();
function updateInteractPrompt() {
  if (!interactPrompt) return;
  // While possessed, show a centered exit prompt (HOLD TO EXIT).
  if (isPossessed && controls.isLocked) {
    interactPrompt.style.left = `${window.innerWidth / 2}px`;
    interactPrompt.style.top = `${window.innerHeight / 2 - 90}px`;
    if (interactLabel) interactLabel.textContent = 'HOLD TO EXIT';
    interactPrompt.style.display = 'flex';
    setRingProgress(holdTarget === 'exit-possess' ? holdProgress : 0);
    return;
  }
  // While piloting, show the same centered E prompt as the vacuum's
  // possession (HOLD TO EXIT).
  if (isFlying && controls.isLocked) {
    interactPrompt.style.left = `${window.innerWidth / 2}px`;
    interactPrompt.style.top = `${window.innerHeight / 2 - 90}px`;
    if (interactLabel) interactLabel.textContent = 'HOLD TO EXIT';
    interactPrompt.style.display = 'flex';
    setRingProgress(holdTarget === 'exit-fly' ? holdProgress : 0);
    return;
  }
  const target = getInteractTarget();
  if (!target || vacuum.isCarried || ball.isCarried || !controls.isLocked) {
    interactPrompt.style.display = 'none';
    return;
  }
  // Shared world-anchored ring prompt: TV center, vacuum, ball, plane, gun, pie, gift, or button.
  if (target === 'tv') _projV.copy(tvCenter());
  else if (target === 'vacuum') _projV.copy(vacuum.mesh.position);
  else if (target === 'plane') {
    if (!planeMesh) {
      interactPrompt.style.display = 'none';
      return;
    }
    planeTailPos(_projV);
  } else if (target === 'gun') _projV.copy(gunMesh.position);
  else if (target === 'button') {
    if (!buttonMesh) {
      interactPrompt.style.display = 'none';
      return;
    }
    _projV.copy(buttonMesh.position);
  } else if (target.startsWith('pie:')) {
    const pie = pies[parseInt(target.slice(4), 10)];
    if (!pie || pie.eaten || !pie.mesh) {
      interactPrompt.style.display = 'none';
      return;
    }
    _projV.copy(pie.mesh.position);
  } else if (target.startsWith('gift:')) {
    const gift = gifts[parseInt(target.slice(5), 10)];
    if (!gift || gift.opened || !gift.mesh) {
      interactPrompt.style.display = 'none';
      return;
    }
    _projV.copy(gift.mesh.position);
  } else _projV.copy(ball.mesh.position);
  _projV.y += 0.3;
  _projV.project(camera);
  if (_projV.z > 1) {
    interactPrompt.style.display = 'none';
    return;
  }
  const x = (_projV.x * 0.5 + 0.5) * window.innerWidth;
  const y = (-_projV.y * 0.5 + 0.5) * window.innerHeight;
  interactPrompt.style.left = `${x}px`;
  interactPrompt.style.top = `${y}px`;
  if (target === 'tv') {
    if (interactLabel) interactLabel.textContent = 'HOLD TO FIX';
  } else if (target === 'button') {
    if (interactLabel) interactLabel.textContent = 'HOLD TO PRESS';
  } else if (target === 'vacuum') {
    if (interactLabel) interactLabel.textContent = 'HOLD TO POSSESS';
  } else if (target === 'plane') {
    if (interactLabel) interactLabel.textContent = 'HOLD TO FLY';
  } else if (target === 'gun') {
    if (interactLabel) interactLabel.textContent = 'HOLD TO EQUIP';
  } else if (target.startsWith('pie:')) {
    if (interactLabel) interactLabel.textContent = 'HOLD TO EAT';
  } else if (target.startsWith('gift:')) {
    if (interactLabel) interactLabel.textContent = 'HOLD TO OPEN';
  } else {
    if (interactLabel) interactLabel.textContent = 'HOLD TO PICK UP';
  }
  interactPrompt.style.display = 'flex';
  setRingProgress(holdProgress);
}

function onKeyUp(event) {
  // Releasing E early resets the hold progress.
  if (event.code === 'KeyE') {
    eHeld = false;
    holdProgress = 0;
    holdTarget = null;
    setRingProgress(0);
  }
  if (event.code === 'Space') moveUp = false;
  if (event.code === 'KeyC') moveDown = false;
  switch (event.code) {
    case 'ArrowUp':
    case 'KeyW':
      moveForward = false;
      break;
    case 'ArrowLeft':
    case 'KeyA':
      moveLeft = false;
      break;
    case 'ArrowDown':
    case 'KeyS':
      moveBackward = false;
      break;
    case 'ArrowRight':
    case 'KeyD':
      moveRight = false;
      break;
    case 'ShiftLeft':
    case 'ShiftRight':
      isSprinting = false;
      break;
    default:
      break;
  }
}

// --- Mobile touch input: mirrors of the Space / KeyE key handlers that gate
// on the emulated touch lock instead of a real Pointer Lock. Wired up to the
// on-screen joystick buttons in init() via initMobileControls(). ---
function startTouchGame() {
  const blocker = document.getElementById('blocker');
  touchPlaying.value = true;
  // Emulate pointer lock: all isLocked-gated gameplay (movement, hold-to-
  // interact prompts, audio, possession, flight) runs unchanged on mobile.
  controls.isLocked = true;
  gameStarted = true;
  if (blocker) blocker.style.display = 'none';
  if (touchUI) touchUI.setVisible(true);
  tryPlayTvAudio();
}

function mobileJumpDown() {
  if (!touchPlaying.value) return;
  tryPlayTvAudio();
  if (isFlying) {
    moveUp = true;
    return;
  }
  if (isPossessed) {
    if (possessGrounded === true) {
      possessVelY = jumpForce;
      possessGrounded = false;
    }
  } else if (isGrounded === true) {
    verticalVelocity = jumpForce;
    isGrounded = false;
  }
}

function mobileJumpUp() {
  moveUp = false;
}

function mobileInteractDown() {
  if (!touchPlaying.value) return;
  tryPlayTvAudio();
  if (isPossessed) {
    eHeld = true;
    holdTarget = 'exit-possess';
    return;
  }
  if (isFlying) {
    eHeld = true;
    holdTarget = 'exit-fly';
    return;
  }
  if (canInteractVacuumNow()) {
    eHeld = true;
    holdTarget = 'vacuum';
    return;
  }
  if (ball.isCarried) {
    ball.throwBall(camera, playerVel);
    eHeld = false;
    holdProgress = 0;
    holdTarget = null;
    setRingProgress(0);
    return;
  }
  holdTarget = getInteractTarget();
  if (holdTarget) eHeld = true;
}

function mobileInteractUp() {
  eHeld = false;
  holdProgress = 0;
  holdTarget = null;
  setRingProgress(0);
}

const _touchLookEuler = new THREE.Euler(0, 0, 0, 'YXZ');
function mobileLook(dx, dy) {
  if (!touchPlaying.value || !camera) return;
  // Same yaw/pitch convention as PointerLockControls (0.0022 base
  // sensitivity), scaled for touch drags.
  const sens = 0.0042;
  _touchLookEuler.setFromQuaternion(camera.quaternion);
  _touchLookEuler.y -= dx * sens;
  _touchLookEuler.x -= dy * sens;
  _touchLookEuler.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, _touchLookEuler.x));
  camera.quaternion.setFromEuler(_touchLookEuler);
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  if (hudCamera) {
    hudCamera.aspect = window.innerWidth / window.innerHeight;
    hudCamera.updateProjectionMatrix();
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1));
  renderer.setSize(window.innerWidth, window.innerHeight);
}

// Release GPU resources on navigation away (prevents context/memory leaks
// when the game page is cached or revisited in the same tab).
window.addEventListener('pagehide', () => {
  try {
    renderer.dispose();
  } catch {
    // Ignore teardown errors.
  }
});

/**
 * Solid player collisions: push the player out of the TV's oriented box
 * (covers the screen body and legs, rotation-aware), out of Bob's live
 * collision box, and out of the robot vacuum's radius so the player cannot
 * walk straight through any of them.
 */
function resolvePlayerCollisions(pos) {
  // Player vs TV: circle-vs-OBB in the box's local frame (XZ only, matching
  // the old behavior), so a yawed/spun TV pushes along its real faces.
  if (tvColliderReady) {
    const feetY = pos.y - 1.6;
    if (feetY < tvCollider.max.y && pos.y > tvCollider.min.y) {
      const hs = tvObb.halfSize;
      _tvInv.copy(tvObb.rotation).transpose();
      _tvLocal.subVectors(pos, tvObb.center).applyMatrix3(_tvInv);
      const cx = Math.max(-hs.x, Math.min(_tvLocal.x, hs.x));
      const cz = Math.max(-hs.z, Math.min(_tvLocal.z, hs.z));
      const dx = _tvLocal.x - cx;
      const dz = _tvLocal.z - cz;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < PLAYER_RADIUS) {
        const e = tvObb.rotation.elements;
        if (dist < 1e-4) {
          // Eye inside the footprint: shove along the least-penetration
          // local axis, converted back to world space.
          const px = hs.x - Math.abs(_tvLocal.x) + PLAYER_RADIUS;
          const pz = hs.z - Math.abs(_tvLocal.z) + PLAYER_RADIUS;
          let lx = 0;
          let lz = 0;
          if (px <= pz) lx = _tvLocal.x >= 0 ? px : -px;
          else lz = _tvLocal.z >= 0 ? pz : -pz;
          pos.x += e[0] * lx + e[6] * lz;
          pos.z += e[2] * lx + e[8] * lz;
        } else {
          // Outside: push along the world-space contact normal.
          const nx = (e[0] * dx + e[6] * dz) / dist;
          const nz = (e[2] * dx + e[8] * dz) / dist;
          const push = PLAYER_RADIUS - dist;
          pos.x += nx * push;
          pos.z += nz * push;
        }
      }
    }
  }

  // Player vs all Bobs
  for (const b of bobs) {
    if (!b.colliderReady || !b.mesh) continue;
    const feetY = pos.y - 1.6;
    if (feetY < b.broadphaseBox.max.y && pos.y > b.broadphaseBox.min.y) {
      const hs = b.obb.halfSize;
      _tvInv.copy(b.obb.rotation).transpose();
      _tvLocal.subVectors(pos, b.obb.center).applyMatrix3(_tvInv);
      const cx = Math.max(-hs.x, Math.min(_tvLocal.x, hs.x));
      const cz = Math.max(-hs.z, Math.min(_tvLocal.z, hs.z));
      const dx = _tvLocal.x - cx;
      const dz = _tvLocal.z - cz;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < PLAYER_RADIUS) {
        const e = b.obb.rotation.elements;
        if (dist < 1e-4) {
          const px = hs.x - Math.abs(_tvLocal.x) + PLAYER_RADIUS;
          const pz = hs.z - Math.abs(_tvLocal.z) + PLAYER_RADIUS;
          let lx = 0; let lz = 0;
          if (px <= pz) lx = _tvLocal.x >= 0 ? px : -px;
          else lz = _tvLocal.z >= 0 ? pz : -pz;
          pos.x += e[0] * lx + e[6] * lz;
          pos.z += e[2] * lx + e[8] * lz;
        } else {
          const nx = (e[0] * dx + e[6] * dz) / dist;
          const nz = (e[2] * dx + e[8] * dz) / dist;
          const push = PLAYER_RADIUS - dist;
          pos.x += nx * push;
          pos.z += nz * push;
        }
      }
    }
  }

  // Player vs trees: capsule in XZ from trunk base to trunk tip (a point
  // while standing, a full trunk-length segment once fallen). tip/top are
  // refreshed from the live instance matrix while trees topple, so this
  // tracks rotation AND the nuke fall exactly. Jump over low trunks allowed.
  for (let i = 0; i < trees.length; i++) {
    const t = trees[i];
    const feetY = pos.y - 1.6;
    if (feetY > t.topY + 0.1) continue;
    const ax = t.x, az = t.z;
    const bx = t.tipX, bz = t.tipZ;
    // Broadphase: skip trunks whose base is out of reach.
    const segLen = Math.hypot(bx - ax, bz - az);
    if (Math.hypot(pos.x - ax, pos.z - az) > segLen + TRUNK_R * t.s + PLAYER_RADIUS + 0.5) continue;
    const r = TRUNK_R * t.s + PLAYER_RADIUS;
    const abx = bx - ax, abz = bz - az;
    const len2 = abx * abx + abz * abz;
    let cxp = ax, czp = az;
    if (len2 > 1e-8) {
      const tt = Math.max(0, Math.min(1, ((pos.x - ax) * abx + (pos.z - az) * abz) / len2));
      cxp = ax + abx * tt;
      czp = az + abz * tt;
    }
    const dx = pos.x - cxp;
    const dz = pos.z - czp;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < r) {
      if (dist < 1e-4) {
        pos.x = cxp + r;
      } else {
        const push = (r - dist) / dist;
        pos.x += dx * push;
        pos.z += dz * push;
      }
    }
  }

  // Player vs robot vacuum (radius-based circle in XZ). Skipped while
  // possessed — the player IS the robot.
  if (vacuum.mesh && !vacuum.isCarried && !isPossessed) {
    const rp = vacuum.mesh.position;
    const minDist = PLAYER_RADIUS + ROBOT_RADIUS;
    const dx = pos.x - rp.x;
    const dz = pos.z - rp.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < minDist) {
      if (dist < 1e-4) {
        pos.x = rp.x + minDist;
      } else {
        const push = (minDist - dist) / dist;
        pos.x += dx * push;
        pos.z += dz * push;
      }
    }
  }
}

function animate() {
  requestAnimationFrame(animate);

  const time = performance.now();
  const delta = Math.min((time - prevTime) / 1000, 0.05);

  if (controls.isLocked === true && !isPossessed && !isFlying) {
    velocity.x -= velocity.x * 10.0 * delta;
    velocity.z -= velocity.z * 10.0 * delta;

    direction.z = Number(moveForward) - Number(moveBackward) + mobileMove.y;
    direction.x = Number(moveRight) - Number(moveLeft) + mobileMove.x;
    direction.normalize();

    const currentSpeed = walkSpeed * (isSprintingNow() ? sprintSpeedMultiplier : 1.0);
    if (moveForward || moveBackward || mobileMove.y !== 0)
      velocity.z -= direction.z * currentSpeed * delta;
    if (moveLeft || moveRight || mobileMove.x !== 0)
      velocity.x -= direction.x * currentSpeed * delta;

    controls.moveRight(-velocity.x * delta);
    controls.moveForward(-velocity.z * delta);

    const pos = playerPos();

    if (!isGrounded) {
      verticalVelocity -= gravity * delta;
      pos.y += verticalVelocity * delta;
    }
    // Flat floor fast path - no raycast
    {
      const floorY = cachedFloorY;
      const targetY = floorY + 1.6;
      if (pos.y < floorY - 5.0) {
        pos.set(0, floorY + 1.6, 0);
        verticalVelocity = 0;
        isGrounded = true;
      } else if (pos.y <= targetY && verticalVelocity <= 0) {
        pos.y = targetY;
        verticalVelocity = 0;
        isGrounded = true;
      } else if (pos.y > targetY + 0.1) {
        isGrounded = false;
      }
      if (pos.y < -10.0) { pos.set(0, 1.6, 0); verticalVelocity = 0; isGrounded = true; }
    }

    // Solid boundaries: never walk through the TV or the vacuum.
    resolvePlayerCollisions(pos);
    // Touch-to-board: brushing the fuselage boards the plane instantly
    // (no E needed). Cooldown after landing prevents instant re-boarding.
    if (
      planeMesh &&
      !ball.isCarried &&
      performance.now() / 1000 > flyCooldownUntil &&
      planeTouchDistSq(pos) < 2.5 * 2.5
    ) {
      enterFlight();
    }
  }

  // Possession drive: WASD moves the robot relative to camera yaw,
  // Shift sprints, Space jumps with gravity. Third-person camera frames
  // the visible robot mesh; the mouse still steers the view.
  if (controls.isLocked === true && isPossessed && vacuum.mesh) {
    const rp = vacuum.mesh.position;
    camera.getWorldDirection(_possessCamDir);
    _possessCamDir.y = 0;
    if (_possessCamDir.lengthSq() < 1e-6) _possessCamDir.set(0, 0, -1);
    _possessCamDir.normalize();
    _possessSide.set(-_possessCamDir.z, 0, _possessCamDir.x);
    const fAmt = Number(moveForward) - Number(moveBackward) + mobileMove.y;
    const sAmt = Number(moveRight) - Number(moveLeft) + mobileMove.x;
    _possessMove.set(0, 0, 0);
    _possessMove.addScaledVector(_possessCamDir, fAmt);
    _possessMove.addScaledVector(_possessSide, sAmt);
    if (_possessMove.lengthSq() > 0) {
      _possessMove.normalize();
      const speed = POSSESS_SPEED * (isSprintingNow() ? sprintSpeedMultiplier : 1.0);
      rp.x += _possessMove.x * speed * delta;
      rp.z += _possessMove.z * speed * delta;
      vacuum.mesh.rotation.y = Math.atan2(_possessMove.x, _possessMove.z);
    }
    // Gravity / jump.
    if (!possessGrounded) {
      possessVelY -= gravity * delta;
      rp.y += possessVelY * delta;
    }
    {
      const floorY = cachedFloorY;
      if (rp.y < floorY - 5.0) { rp.set(0, floorY, 0); possessVelY = 0; possessGrounded = true; }
      else if (rp.y <= floorY && possessVelY <= 0) { rp.y = floorY; possessVelY = 0; possessGrounded = true; }
      else if (rp.y > floorY + 0.1) possessGrounded = false;
      if (rp.y < -10.0) { rp.set(0, 1.6, 0); possessVelY = 0; possessGrounded = true; }
    }
    vacuum.resolveObstacleCollisions();
    rp.x = Math.max(vacuum.floorMin.x, Math.min(vacuum.floorMax.x, rp.x));
    rp.z = Math.max(vacuum.floorMin.z, Math.min(vacuum.floorMax.z, rp.z));
    if (vacuum.dirtLayer) vacuum.dirtLayer.cleanAt(rp.x, rp.z, vacuum.cleanRadius);
    camera.getWorldDirection(_possessCamDir);
    if (_possessCamDir.lengthSq() < 1e-6) _possessCamDir.set(0, 0, -1);
    _possessCamDir.normalize();
    _possessMove.set(rp.x - _possessCamDir.x * POSSESS_CAM_DIST, rp.y + POSSESS_CAM_HEIGHT - _possessCamDir.y * POSSESS_CAM_DIST, rp.z - _possessCamDir.z * POSSESS_CAM_DIST);
    if (_possessMove.y < cachedFloorY + 0.3) _possessMove.y = cachedFloorY + 0.3;
    playerPos().copy(_possessMove);
  }

  // Plane flight: drone-style on camera yaw — WASD steers, SPACE climbs,
  // C dives, SHIFT boosts. Hard-locked to the platform: XZ clamped inside
  // the floor bounds, altitude clamped above the floor, so you can only
  // ever fly around inside the boarders, never off the map.
  if (controls.isLocked === true && isFlying && planeMesh) {
    const pp = planeMesh.position;
    camera.getWorldDirection(_flyDir);
    _flyFlat.set(_flyDir.x, 0, _flyDir.z);
    if (_flyFlat.lengthSq() < 1e-6) _flyFlat.set(0, 0, -1);
    _flyFlat.normalize();
    _flySide.set(-_flyFlat.z, 0, _flyFlat.x);
    const fAmt = Number(moveForward) - Number(moveBackward) + mobileMove.y;
    const sAmt = Number(moveRight) - Number(moveLeft) + mobileMove.x;
    const upAmt = Number(moveUp) - Number(moveDown);
    const speed = FLY_SPEED * (isSprintingNow() ? sprintSpeedMultiplier : 1.0);
    _flyTarget.set(0, 0, 0);
    _flyTarget.addScaledVector(_flyFlat, fAmt * speed);
    _flyTarget.addScaledVector(_flySide, sAmt * speed);
    _flyTarget.y = upAmt * FLY_CLIMB;
    const blend = Math.min(1, delta * 3.0);
    flyVel.lerp(_flyTarget, blend);
    pp.addScaledVector(flyVel, delta);
    // THE borders: clamp inside the padded floor bounds + altitude band.
    if (vacuum.floorMin && vacuum.floorMax) {
      const m = 1.0; // margin so the wingspan never leaves the platform
      if (pp.x < vacuum.floorMin.x + m) { pp.x = vacuum.floorMin.x + m; flyVel.x = Math.max(0, flyVel.x); }
      if (pp.x > vacuum.floorMax.x - m) { pp.x = vacuum.floorMax.x - m; flyVel.x = Math.min(0, flyVel.x); }
      if (pp.z < vacuum.floorMin.z + m) { pp.z = vacuum.floorMin.z + m; flyVel.z = Math.max(0, flyVel.z); }
      if (pp.z > vacuum.floorMax.z - m) { pp.z = vacuum.floorMax.z - m; flyVel.z = Math.min(0, flyVel.z); }
    }
    const minY = cachedFloorY + FLY_MIN_ALT;
    const maxY = cachedFloorY + FLY_MAX_ALT;
    if (pp.y < minY) { pp.y = minY; flyVel.y = Math.max(0, flyVel.y); }
    if (pp.y > maxY) { pp.y = maxY; flyVel.y = Math.min(0, flyVel.y); }
    // Pose: yaw toward motion (camera heading when hovering), bank on
    // strafe, pitch on climb/dive.
    const hSpeed = Math.hypot(flyVel.x, flyVel.z);
    let yaw;
    if (hSpeed > 1.0) yaw = planeYawForDir(flyVel.x / hSpeed, flyVel.z / hSpeed);
    else yaw = planeYawForDir(_flyFlat.x, _flyFlat.z);
    const prevYaw = planeMesh.rotation.y;
    let yawDelta = yaw - prevYaw;
    while (yawDelta > Math.PI) yawDelta -= Math.PI * 2;
    while (yawDelta < -Math.PI) yawDelta += Math.PI * 2;
    const turnBlend = Math.min(1, delta * 6.0);
    planeMesh.rotation.y = prevYaw + yawDelta * turnBlend;
    const bank = THREE.MathUtils.clamp(-yawDelta * 2.0, -0.5, 0.5);
    planeMesh.rotation.x += (bank - planeMesh.rotation.x) * Math.min(1, delta * 5.0);
    const pitch = THREE.MathUtils.clamp(-flyVel.y * 0.04, -0.4, 0.4);
    planeMesh.rotation.z += (pitch - planeMesh.rotation.z) * Math.min(1, delta * 5.0);
    // Chase camera behind the plane along the look direction.
    camera.getWorldDirection(_flyDir);
    if (_flyDir.lengthSq() < 1e-6) _flyDir.set(0, 0, -1);
    _flyDir.normalize();
    _possessMove.set(
      pp.x - _flyDir.x * FLY_CAM_DIST,
      pp.y + FLY_CAM_HEIGHT - _flyDir.y * FLY_CAM_DIST,
      pp.z - _flyDir.z * FLY_CAM_DIST
    );
    if (_possessMove.y < cachedFloorY + 0.3) _possessMove.y = cachedFloorY + 0.3;
    playerPos().copy(_possessMove);
  }

  // Abandoned plane: falls straight down with gravity, levels its wings,
  // and comes to rest parked on the platform.
  if (planeMesh && planeFalling && !isFlying) {
    const pp = planeMesh.position;
    planeFallVel -= gravity * delta;
    pp.y += planeFallVel * delta;
    planeMesh.rotation.x += (0 - planeMesh.rotation.x) * Math.min(1, delta * 3.0);
    planeMesh.rotation.z += (0 - planeMesh.rotation.z) * Math.min(1, delta * 3.0);
    if (pp.y <= planeRestY) {
      pp.y = planeRestY;
      planeFalling = false;
      planeFallVel = 0;
    }
  }
  // the volleyball, or exit possession.
  // Switching/losing the target cancels.
  if (eHeld) {
    if (holdTarget === 'exit-fly') {
      if (!isFlying) {
        eHeld = false;
        holdProgress = 0;
        holdTarget = null;
        setRingProgress(0);
      } else {
        holdProgress += delta;
        setRingProgress(holdProgress);
        if (holdProgress >= HOLD_DURATION) {
          exitFlight();
          eHeld = false;
          holdProgress = 0;
          holdTarget = null;
          setRingProgress(0);
        }
      }
    } else if (holdTarget === 'exit-possess') {
      if (!isPossessed) {
        eHeld = false;
        holdProgress = 0;
        holdTarget = null;
        setRingProgress(0);
      } else {
        holdProgress += delta;
        setRingProgress(holdProgress);
        if (holdProgress >= HOLD_DURATION) {
          exitPossession();
          eHeld = false;
          holdProgress = 0;
          holdTarget = null;
          setRingProgress(0);
        }
      }
    } else if (!holdTarget || getInteractTarget() !== holdTarget) {
      eHeld = false;
      holdProgress = 0;
      holdTarget = null;
      setRingProgress(0);
    } else {
      holdProgress += delta;
      if (holdProgress >= HOLD_DURATION) {
        if (holdTarget === 'tv') fixTV();
        else if (holdTarget === 'button') pressButton();
        else if (holdTarget === 'vacuum') enterPossession();
        else if (holdTarget === 'plane') enterFlight();
        else if (holdTarget === 'gun') equipGun();
        else if (holdTarget.startsWith('pie:')) eatPie(parseInt(holdTarget.slice(4), 10));
        else if (holdTarget.startsWith('gift:')) openGift(parseInt(holdTarget.slice(5), 10));
        else if (ball.pickup(camera)) dropGun();
        eHeld = false;
        holdProgress = 0;
        holdTarget = null;
        setRingProgress(0);
      }
    }
  }
  updateInteractPrompt();
  updateMovementAudio();

  // TV audio: (re)start when in game, then fade with distance so it
  // feels placed in the room. Retried periodically — a rejected first
  // play() (autoplay timing) heals on its own instead of staying silent.
  if (!tvFixed && tvAudio && !tvAudioError) {
    if (controls.isLocked && tvAudio.paused && time - tvRetryTime > 1500) {
      tvRetryTime = time;
      tryPlayTvAudio();
    }
    if (!tvAudio.paused && tvMesh) {
      const c = tvCenter();
      if (c) {
        const d = camera.position.distanceTo(c);
        tvAudio.volume = THREE.MathUtils.clamp(1 - d / 15, 0.05, 0.6);
      }
    }
  }

  // Smooth mouse-scroll zoom.
  if (Math.abs(camera.fov - targetFov) > 0.01) {
    camera.fov += (targetFov - camera.fov) * Math.min(1, delta * 8);
    camera.updateProjectionMatrix();
  }

  // Knocked TV set: integrate shot impacts (torque rock) and re-pose the
  // oriented collider every frame so it tracks the mesh rotation exactly.
  updateTvPhysics(delta);

  // Giant pfp coin: play out any triggered 360° spin.
  updatePfpCoin(delta);

  // Shootable leaves: shake on hit, Bob-style fall + fade death.
  updateLeaves(delta, time);
  // Fallen-from-blast trees: tip over and stay (never removed).
  updateTrees(delta);
  // Gift coins: burst flight, bounce, settle, idle glint-spin.
  updateCoins(delta);
  // Airstrike bomb: 50m fall (~2s) then detonation, ~4s total audio window.
  updateBomb(delta);
  // Bob death explosions: integrate particles + flash.
  updateExplosions(delta);

  // Leaderboard + FEMBOY gentle hover
  if (leaderboardMesh) leaderboardMesh.position.y = leaderboardMesh.userData.baseY + Math.sin(time*0.001*1.2)*0.08;
  if (femboyMesh) femboyMesh.position.y = femboyMesh.userData.baseY + Math.sin(time*0.001*1.2)*0.08;

  // Hitscan tracer fade + gun recoil spring (HUD-space offsets).
  if (tracer && tracerLife > 0) {
    tracerLife -= delta;
    tracer.material.opacity = Math.max(0, tracerLife / TRACER_MAX_LIFE) * 0.9;
    if (tracerLife <= 0) tracer.visible = false;
  }
  if (gunMesh && gunEquipped) {
    gunKick = Math.max(0, gunKick - delta * 8);
    gunMesh.position.set(
      GUN_HIP_POS.x,
      GUN_HIP_POS.y + gunKick * 0.02,
      GUN_HIP_POS.z + gunKick * 0.09
    );
    gunMesh.rotation.x = GUN_LEVEL_PITCH + gunKick * 0.15;
  }

  // Live player velocity for throw momentum (releases retain momentum).
  if (controls.isLocked) {
    if (_hasPrevPlayerPos && delta > 0) {
      playerVel
        .subVectors(playerPos(), _prevPlayerPos)
        .divideScalar(delta);
      if (playerVel.length() > 30) playerVel.setLength(30);
    }
    _prevPlayerPos.copy(playerPos());
    _hasPrevPlayerPos = true;
  } else {
    playerVel.set(0, 0, 0);
    _hasPrevPlayerPos = false;
  }

  // Vacuum AI (cleaning / following / half-circle / 15s ignore / carried / thrown).
  if (vacuum.mesh) vacuum.update(delta, playerPos());

  // Bob the pigeon: aggro/tracking/attack AI. While the player is inside
  // the vacuum (possessed), Bob loses track entirely (hidden=true).
  // Before the official game start (main menu), Bob stays fully idle.
  for (const b of bobs) {
    if (!b.mesh && b.state !== 'dying') continue;
    const playerMoving =
      moveForward ||
      moveBackward ||
      moveLeft ||
      moveRight ||
      mobileMove.x !== 0 ||
      mobileMove.y !== 0;
    b.update(delta, playerPos(), { hidden: isPossessed, active: gameStarted, playerSprinting: isSprintingNow(), playerMoving }, (dmg) => damagePlayer(dmg));
  }

  // Volleyball physics (free bounce / push / thrown flight / respawn).
  // While possessed the "player" body is the robot, so shoves track the
  // robot position instead of the third-person camera.
  // Pies idle-spin slowly so the heal pickups catch the eye.
  // After a bomb blast they tumble through the air, bounce, and settle.
  for (let i = 0; i < pies.length; i++) {
    const pie = pies[i];
    if (pie.eaten || !pie.mesh) continue;
    if (pie.vel) {
      pie.vel.y -= 18 * delta; // pie gravity
      pie.mesh.position.addScaledVector(pie.vel, delta);
      pie.mesh.rotation.x += pie.spin.x * delta;
      pie.mesh.rotation.y += pie.spin.y * delta;
      pie.mesh.rotation.z += pie.spin.z * delta;
      // Floor bounce: rest on the floor regardless of origin offset.
      const box = new THREE.Box3().setFromObject(pie.mesh);
      const floorY = cachedFloorY;
      if (box.min.y <= floorY) {
        pie.mesh.position.y += floorY - box.min.y + 0.02;
        if (Math.abs(pie.vel.y) > 1.5) {
          pie.vel.y *= -0.45; // bounce
          pie.vel.x *= 0.7;
          pie.vel.z *= 0.7;
          pie.spin.multiplyScalar(0.6);
        } else {
          // Settled: kill velocity, keep a flat-ish rest pose.
          pie.vel = null;
          pie.spin = null;
        }
      }
      // Safety: never leave the map or fall through.
      if (vacuum.floorMin && vacuum.floorMax) {
        pie.mesh.position.x = THREE.MathUtils.clamp(pie.mesh.position.x, vacuum.floorMin.x, vacuum.floorMax.x);
        pie.mesh.position.z = THREE.MathUtils.clamp(pie.mesh.position.z, vacuum.floorMin.z, vacuum.floorMax.z);
      }
      if (pie.mesh.position.y < -10) {
        pie.vel = null;
        pie.spin = null;
        pie.mesh.position.y = cachedFloorY + 0.3;
      }
    } else {
      pie.mesh.rotation.y += delta * 0.6;
    }
  }
  if (ball.mesh) {
    ball.update(delta, isPossessed && vacuum.mesh ? vacuum.mesh.position : playerPos(), playerVel);
    // Ball vs robot vacuum: shove the free ball out of the robot's body.
    if (vacuum.mesh && !vacuum.isCarried && !ball.isCarried) {
      const bp = ball.mesh.position;
      const rp = vacuum.mesh.position;
      const minD = ball.radius + 0.45;
      const dx = bp.x - rp.x;
      const dz = bp.z - rp.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d < minD && Math.abs(bp.y - rp.y) < 1.0) {
        const nx = d < 1e-4 ? 1 : dx / d;
        const nz = d < 1e-4 ? 0 : dz / d;
        bp.x = rp.x + nx * minD;
        bp.z = rp.z + nz * minD;
        ball.velocity.x += (nx * 2.0) / ball.mass;
        ball.velocity.z += (nz * 2.0) / ball.mass;
      }
    }
  }

  prevTime = time;

  frameCount++;
  if (time - fpsTime >= 500) {
    const fps = Math.round((frameCount * 1000) / (time - fpsTime));
    if (fpsElement) fpsElement.innerText = `FPS: ${fps}`;
    frameCount = 0;
    fpsTime = time;
  }

  // World first, then the locked HUD layer on top (no post-processing).
  renderer.clear();
  renderer.render(scene, camera);
  if (hudScene && hudCamera && gunMesh && gunEquipped) {
    renderer.clearDepth();
    renderer.render(hudScene, hudCamera);
  }
}

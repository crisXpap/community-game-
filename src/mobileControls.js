import nipplejs from 'nipplejs';

/**
 * Robust on-screen touch controls for mobile devices.
 *
 * - Dynamic virtual joystick (bottom-left) mimicking WASD.
 * - Three circular action buttons (bottom-right): Run (Shift), Jump (Space),
 *   Interact (E, hold-to-interact supported via down/up callbacks).
 * - Touch-look drag on the right half of the screen (yaw/pitch) + tap to shoot,
 *   since PointerLockControls mouse-look is unavailable on touch devices.
 * - Everything is only created/shown on touch-capable devices.
 */

// Continuous movement vector from the joystick. Polled by the game loop.
// x: strafe, -1 (left) .. +1 (right). y: forward, -1 (back) .. +1 (forward).
export const mobileMove = { x: 0, y: 0 };

// Held state for the Run button (mirrors Shift).
export const mobileState = { sprint: false };

export function isTouchDevice() {
  if (typeof window === 'undefined') return false;
  const coarse =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(pointer: coarse)').matches;
  // Touchscreen laptops report touch points but also have a fine pointer —
  // they keep the desktop (pointer lock + keyboard) path. True mobile
  // devices have a coarse pointer and no fine pointer.
  if (coarse) return true;
  const fine =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(pointer: fine)').matches;
  if (fine) return false;
  return (
    'ontouchstart' in window ||
    (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0)
  );
}

const CSS = `
#touch-ui { position: fixed; inset: 0; z-index: 40; pointer-events: none; display: none;
  font-family: 'Patrick Hand SC', cursive; }
#touch-ui.visible { display: block; }
#joystick-zone { position: absolute; left: 0; bottom: 0; width: 45vw; height: 55vh;
  pointer-events: auto; touch-action: none; }
#look-zone { position: absolute; right: 0; bottom: 0; width: 55vw; height: 100vh;
  pointer-events: auto; touch-action: none; }
#action-buttons { position: absolute; right: max(18px, env(safe-area-inset-right));
  bottom: max(96px, env(safe-area-inset-bottom)); display: flex; flex-direction: column;
  align-items: center; gap: 12px; pointer-events: none; }
.touch-btn { pointer-events: auto; touch-action: none; border-radius: 50%;
  border: 2px solid rgba(255,255,255,0.45); background: rgba(10,10,14,0.42);
  color: #fff; display: flex; align-items: center; justify-content: center;
  flex-direction: column; letter-spacing: 1px; cursor: pointer; user-select: none;
  -webkit-user-select: none; -webkit-tap-highlight-color: transparent;
  text-shadow: 0 0 8px rgba(255,255,255,0.6), 0 1px 2px rgba(0,0,0,0.9);
  box-shadow: 0 4px 14px rgba(0,0,0,0.35), inset 0 0 12px rgba(255,255,255,0.08);
  backdrop-filter: blur(2px); transition: transform 0.08s ease, background 0.12s ease; }
.touch-btn small { font-size: 10px; opacity: 0.85; letter-spacing: 2px; }
.touch-btn.active, .touch-btn:active { background: rgba(46,204,113,0.45); transform: scale(0.94); }
#btn-run { width: 84px; height: 84px; font-size: 15px; }
#btn-jump { width: 70px; height: 70px; font-size: 14px; }
#btn-interact { width: 62px; height: 62px; font-size: 18px; font-weight: bold;
  border-color: rgba(46,204,113,0.7); }
@media (min-width: 768px) {
  #btn-run { width: 96px; height: 96px; font-size: 17px; }
  #btn-jump { width: 80px; height: 80px; font-size: 15px; }
  #btn-interact { width: 72px; height: 72px; font-size: 20px; }
  #action-buttons { gap: 16px; }
}
@media (max-width: 380px) {
  #btn-run { width: 72px; height: 72px; font-size: 13px; }
  #btn-jump { width: 60px; height: 60px; font-size: 12px; }
  #btn-interact { width: 54px; height: 54px; font-size: 16px; }
  #action-buttons { gap: 10px; }
}
`;

function injectCss() {
  if (document.getElementById('touch-ui-css')) return;
  const style = document.createElement('style');
  style.id = 'touch-ui-css';
  style.textContent = CSS;
  document.head.appendChild(style);
}

function bindHoldButton(el, onDown, onUp) {
  const down = (e) => {
    e.preventDefault();
    el.classList.add('active');
    try {
      el.setPointerCapture && e.pointerId !== undefined && el.setPointerCapture(e.pointerId);
    } catch { /* ignore */ }
    onDown();
  };
  const up = (e) => {
    if (e) e.preventDefault();
    el.classList.remove('active');
    onUp();
  };
  el.addEventListener('pointerdown', down);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('lostpointercapture', () => el.classList.remove('active'));
  // Fallback for browsers without Pointer Events.
  el.addEventListener('touchstart', (e) => { e.preventDefault(); el.classList.add('active'); onDown(); }, { passive: false });
  el.addEventListener('touchend', (e) => { e.preventDefault(); el.classList.remove('active'); onUp(); });
}

/**
 * @param {object} opts
 * @param {() => void} opts.onJump - jump press (mirrors Space keydown).
 * @param {() => void} opts.onJumpUp - jump release (clears fly-climb, mirrors Space keyup).
 * @param {() => void} opts.onInteractDown - E hold start.
 * @param {() => void} opts.onInteractUp - E hold release.
 * @param {(dx: number, dy: number) => void} opts.onLook - touch-look deltas (px).
 * @param {() => void} opts.onShoot - tap (no-drag) on the look area fires the gun.
 * @returns {{ setVisible: (v: boolean) => void } | null} null on non-touch devices.
 */
export function initMobileControls(opts = {}) {
  if (!isTouchDevice()) return null;
  injectCss();

  const ui = document.createElement('div');
  ui.id = 'touch-ui';

  const joyZone = document.createElement('div');
  joyZone.id = 'joystick-zone';

  const lookZone = document.createElement('div');
  lookZone.id = 'look-zone';

  const buttons = document.createElement('div');
  buttons.id = 'action-buttons';

  // Order: Interact (top), Jump (middle), Run (bottom, largest).
  const btnInteract = document.createElement('button');
  btnInteract.id = 'btn-interact';
  btnInteract.className = 'touch-btn';
  btnInteract.type = 'button';
  btnInteract.setAttribute('aria-label', 'Interact (E)');
  btnInteract.innerHTML = 'E<small>HOLD</small>';

  const btnJump = document.createElement('button');
  btnJump.id = 'btn-jump';
  btnJump.className = 'touch-btn';
  btnJump.type = 'button';
  btnJump.setAttribute('aria-label', 'Jump (Space)');
  btnJump.innerHTML = '&#8593;<small>JUMP</small>';

  const btnRun = document.createElement('button');
  btnRun.id = 'btn-run';
  btnRun.className = 'touch-btn';
  btnRun.type = 'button';
  btnRun.setAttribute('aria-label', 'Run (Shift)');
  btnRun.innerHTML = '&#187;<small>RUN</small>';

  buttons.append(btnInteract, btnJump, btnRun);
  // Look zone must sit below joystick + buttons in hit-testing.
  ui.append(lookZone, joyZone, buttons);
  document.body.appendChild(ui);

  // --- Virtual joystick (dynamic, bottom-left) ---
  const manager = nipplejs.create({
    zone: joyZone,
    mode: 'dynamic',
    position: { left: '110px', bottom: '110px' },
    color: 'white',
    size: 110,
    fadeTime: 150,
  });
  manager.on('move', (_evt, data) => {
    if (!data || !data.vector) return;
    // nipplejs vector.y is up-positive; clamp + apply small dead zone.
    const DEAD = 0.12;
    let x = data.vector.x * Math.min(1, (data.force ?? 0));
    let y = data.vector.y * Math.min(1, (data.force ?? 0));
    if (Math.hypot(x, y) < DEAD) { x = 0; y = 0; }
    mobileMove.x = THREE_CLAMP(x);
    mobileMove.y = THREE_CLAMP(y);
  });
  const resetMove = () => { mobileMove.x = 0; mobileMove.y = 0; };
  manager.on('end', resetMove);
  manager.on('removed', resetMove);

  function THREE_CLAMP(v) {
    return Math.max(-1, Math.min(1, v));
  }

  // --- Action buttons ---
  bindHoldButton(
    btnRun,
    () => { mobileState.sprint = true; },
    () => { mobileState.sprint = false; }
  );
  // Jump fires on press; release clears the fly-climb flag (matches Space).
  bindHoldButton(
    btnJump,
    () => { opts.onJump && opts.onJump(); },
    () => { opts.onJumpUp && opts.onJumpUp(); }
  );
  bindHoldButton(
    btnInteract,
    () => { opts.onInteractDown && opts.onInteractDown(); },
    () => { opts.onInteractUp && opts.onInteractUp(); }
  );

  // --- Touch look: drag on right side to look, quick tap to shoot ---
  let lookId = null;
  let lastLX = 0;
  let lastLY = 0;
  let lookMoved = 0;
  let lookT0 = 0;
  lookZone.addEventListener('touchstart', (e) => {
    const t = e.changedTouches[0];
    lookId = t.identifier;
    lastLX = t.clientX;
    lastLY = t.clientY;
    lookMoved = 0;
    lookT0 = performance.now();
  }, { passive: true });
  lookZone.addEventListener('touchmove', (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier !== lookId) continue;
      const dx = t.clientX - lastLX;
      const dy = t.clientY - lastLY;
      lastLX = t.clientX;
      lastLY = t.clientY;
      lookMoved += Math.abs(dx) + Math.abs(dy);
      opts.onLook && opts.onLook(dx, dy);
    }
    e.preventDefault();
  }, { passive: false });
  lookZone.addEventListener('touchend', (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier !== lookId) continue;
      const dt = performance.now() - lookT0;
      if (lookMoved < 12 && dt < 300) opts.onShoot && opts.onShoot();
      lookId = null;
    }
  }, { passive: true });

  return {
    setVisible(v) {
      ui.classList.toggle('visible', !!v);
    },
  };
}

import nipplejs from 'nipplejs';

/**
 * Robust on-screen touch controls for mobile devices.
 *
 * - Dynamic virtual joystick (bottom-left) mimicking WASD.
 * - Two circular action buttons (bottom-right): Run (Shift) and Jump (Space).
 * - Interact (E) has NO button: tapping / pressing the on-screen E-ring
 *   hologram (#interact-prompt) triggers the hold-to-interact instead.
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
  height: 100vh; height: 100dvh;
  font-family: 'Patrick Hand SC', cursive; }
#touch-ui.visible { display: block; }
#joystick-zone { position: absolute; left: 0; bottom: 0; width: 45vw; height: 55vh; height: 55dvh;
  pointer-events: auto; touch-action: none; }
#look-zone { position: absolute; right: 0; bottom: 0; width: 55vw; height: 100vh; height: 100dvh;
  pointer-events: auto; touch-action: none; }
#action-buttons { position: absolute; right: max(18px, env(safe-area-inset-right, 0px));
  bottom: max(130px, env(safe-area-inset-bottom, 0px) + 120px); display: flex; flex-direction: column;
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
/* Tappable E-ring hologram (touch only): the desktop prompt is
   pointer-events:none at z-index 20, which would put it under the look
   zone. On touch it becomes the Interact control — above everything with
   a larger touch target. Only visible while an interact target is in range
   (main.js toggles display), so it never blocks the view otherwise. */
body.touch-playing #interact-prompt { pointer-events: auto; z-index: 50; cursor: pointer; }
body.touch-playing #interact-prompt .e-ring-wrap { width: 84px; height: 84px; }
body.touch-playing #interact-prompt .e-letter { font-size: 32px; }
@media (min-width: 768px) {
  #btn-run { width: 96px; height: 96px; font-size: 17px; }
  #btn-jump { width: 80px; height: 80px; font-size: 15px; }
  #action-buttons { gap: 16px; }
}
@media (max-width: 380px) {
  #btn-run { width: 72px; height: 72px; font-size: 13px; }
  #btn-jump { width: 60px; height: 60px; font-size: 12px; }
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

  // Order: Jump (top), Run (bottom, largest). No Interact button — the
  // on-screen E-ring hologram is the interact control (wired below).
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

  buttons.append(btnJump, btnRun);
  // Look zone must sit below joystick + buttons in hit-testing.
  ui.append(lookZone, joyZone, buttons);
  document.body.appendChild(ui);

  // --- Virtual joystick (dynamic, bottom-left) ---
  // Created lazily on first show: the UI starts as display:none (zero
  // layout), and nipplejs measures its zone at creation time.
  let manager = null;
  const resetMove = () => { mobileMove.x = 0; mobileMove.y = 0; };
  function clamp1(v) {
    return Math.max(-1, Math.min(1, v));
  }
  function ensureManager() {
    if (manager) return;
    manager = nipplejs.create({
      zone: joyZone,
      mode: 'dynamic',
      position: { left: '110px', bottom: '110px' },
      color: 'white',
      size: 110,
      fadeTime: 150,
    });
    manager.on('move', (evt, legacyData) => {
      // nipplejs v1 delivers a single { type, target, data } wrapper;
      // 0.x passed (evt, data). Accept both.
      const data = (evt && evt.data) || legacyData || evt;
      if (!data || !data.vector) return;
      // vector.y is up-positive (push up = forward); |vector| already
      // carries the deflection magnitude (0..1), so use it directly.
      const DEAD = 0.12;
      let x = data.vector.x ?? 0;
      let y = data.vector.y ?? 0;
      if (Math.hypot(x, y) < DEAD) { x = 0; y = 0; }
      mobileMove.x = clamp1(x);
      mobileMove.y = clamp1(y);
    });
    manager.on('end', resetMove);
    manager.on('removed', resetMove);
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
  // Interact lives on the E-ring hologram, not a button: pressing it
  // starts the E hold, releasing cancels (mirrors the desktop E key, where
  // releasing early resets the 0.75s ring). preventDefault in the binder
  // also suppresses the synthetic mousedown that would otherwise fire the gun.
  const hologram = document.getElementById('interact-prompt');
  if (hologram) {
    bindHoldButton(
      hologram,
      () => { opts.onInteractDown && opts.onInteractDown(); },
      () => { opts.onInteractUp && opts.onInteractUp(); }
    );
  }

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

  // Keep the action buttons above collapsible browser chrome (e.g. Safari's
  // bottom tab/URL bar): measure how much of the layout viewport the visual
  // viewport doesn't cover and lift the buttons by that amount. Only ever
  // pushes them up, so worst case they float slightly higher — never hidden.
  function updateChromeOffset() {
    let extra = 0;
    const vv = window.visualViewport;
    if (vv) {
      extra = Math.max(0, window.innerHeight - vv.height - (vv.offsetTop || 0));
    }
    buttons.style.bottom = `calc(max(130px, env(safe-area-inset-bottom, 0px) + 120px) + ${extra}px)`;
  }
  updateChromeOffset();
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', updateChromeOffset);
    window.visualViewport.addEventListener('scroll', updateChromeOffset);
  }
  window.addEventListener('orientationchange', updateChromeOffset);

  return {
    setVisible(v) {
      ui.classList.toggle('visible', !!v);
      // Drives the touch-only hologram styling (tappable E-ring above the
      // look zone). Scoped to touch sessions — desktop CSS is untouched.
      document.body.classList.toggle('touch-playing', !!v);
      if (v) {
        ensureManager();
        updateChromeOffset();
      }
      if (!v) resetMove();
    },
  };
}

import { ELEMENTS, ELEMENT_META, BOOST_META, MAGIC_META, FIRE_META } from '../config/settings.js';
import { ELEMENT_SIGILS, BOOST_SIGIL, MAGIC_SIGIL, FIRE_SIGIL } from './glyphs.js';

/**
 * Heads-up display: the ability bar, controls, live stats and toasts.
 *
 * Plain DOM — no framework. The bar is built from `ELEMENTS`, so a new ability
 * appears in it on its own; the slots are the only interactive part, and they
 * mirror the keyboard shortcuts through `onAbility`.
 *
 * The three self buffs sit at the end of the same bar but are *not* slots: they
 * are never selected and never armed, so they are held separately and their
 * sweeps show the buff draining rather than a cooldown filling.
 *
 * The cooldown sweep is a `conic-gradient` driven by a CSS custom property, so
 * updating it every frame is one `setProperty` call and never touches layout.
 */
export class HUD {
  constructor(root) {
    this.root = root;
    this.onAbility = null;
    this.onBoost = null;
    this.onMagic = null;
    this.onFire = null;
    this._toastTimer = 0;
    this._statsAccumulator = 0;
    this._frames = 0;
    this._fps = 0;
    /** Last sweep ratio pushed to the DOM, per element. */
    this._cooldownShown = new Map();
    this._armedShown = null;
    this._boostShown = { active: null, ratio: -1 };
    this._magicShown = { active: null, ratio: -1 };
    this._fireShown = { active: null, ratio: -1 };

    root.innerHTML = `
      <div class="hud__panel hud__title">
        Elemental Sandbox
        <span data-blurb>Press Q, E, R, F, V, X or Z, aim, click to cast. B, M and K buff you.</span>
      </div>

      <div class="hud__panel hud__stats">
        <div>FPS <b data-stat="fps">—</b></div>
        <div>Particles <b data-stat="particles">0</b></div>
        <div>Instances <b data-stat="spikes">0</b></div>
        <div>Draw calls <b data-stat="calls">0</b></div>
      </div>

      <div class="hud__panel hud__help">
        <div><strong>Q</strong> — Pyre Crown &nbsp; <strong>E</strong> — Kraken Crown</div>
        <div><strong>R</strong> — Electrical Sphere &nbsp; <strong>F</strong> — Earthen Spire</div>
        <div><strong>V</strong> — Verdant Gate &nbsp; <strong>X</strong> — Tidewrought Ring</div>
        <div><strong>Z</strong> — Fire Portal</div>
        <div class="hud__help-note">
          Q, E and R are far casts — aimed with a circle. F is a line cast — aimed with an arrow.
          V is a gate cast — aimed with a threshold and the arch standing in it. X is a ring cast —
          aimed with a sigil that the ring tips upright out of, which is how it is built: forged
          flat on the floor, then stood up. Z is a scribe cast — aimed with a circle standing in the
          air exactly where the portal will hang. All three stay open until you make another one of
          the same kind, and one of each can stand at once.
        </div>
        <div><strong>B</strong> — Electric Boost &nbsp; <strong>M</strong> — Magic Boost</div>
        <div><strong>K</strong> — Fire Boost</div>
        <div class="hud__help-note">
          B, M and K are self buffs — nothing to aim. Press again to let go; any of them can run
          together.
        </div>
        <div><strong>Move</strong> — aim &nbsp; <strong>Left click</strong> — cast</div>
        <div><strong>Esc / right click</strong> — cancel the cast</div>
        <div><strong>Right drag</strong> — orbit &nbsp; <strong>Scroll</strong> — zoom</div>
        <div style="margin-top:6px">
          <kbd>G</kbd> editor &nbsp; <kbd>P</kbd> pause &nbsp; <kbd>C</kbd> clear
        </div>
        <div><kbd>H</kbd> hide this</div>
        <div class="hud__help-note">Paused still applies every editor change.</div>
      </div>

      <div class="hud__abilities">
        ${ELEMENTS.map((element) => {
          const meta = ELEMENT_META[element];
          return `
            <div class="ability-card" data-element="${element}" style="--accent:${meta.accent}">
              <div class="ability-card__sweep" data-sweep></div>
              <div class="ability-card__key">${meta.key}</div>
              <div class="ability-card__glyph">${ELEMENT_SIGILS[element] ?? ''}</div>
              <div class="ability-card__label">${meta.label}</div>
            </div>`;
        }).join('')}

        <div class="ability-card ability-card--buff" data-boost
             style="--accent:${BOOST_META.accent}">
          <div class="ability-card__sweep" data-sweep></div>
          <div class="ability-card__key">${BOOST_META.key}</div>
          <div class="ability-card__glyph">${BOOST_SIGIL}</div>
          <div class="ability-card__label">${BOOST_META.label}</div>
        </div>

        <div class="ability-card ability-card--buff" data-magic
             style="--accent:${MAGIC_META.accent}">
          <div class="ability-card__sweep" data-sweep></div>
          <div class="ability-card__key">${MAGIC_META.key}</div>
          <div class="ability-card__glyph">${MAGIC_SIGIL}</div>
          <div class="ability-card__label">${MAGIC_META.label}</div>
        </div>

        <div class="ability-card ability-card--buff" data-fire
             style="--accent:${FIRE_META.accent}">
          <div class="ability-card__sweep" data-sweep></div>
          <div class="ability-card__key">${FIRE_META.key}</div>
          <div class="ability-card__glyph">${FIRE_SIGIL}</div>
          <div class="ability-card__label">${FIRE_META.label}</div>
        </div>
      </div>

      <div class="hud__toast" data-toast></div>
      <div class="hud__paused" data-paused>Paused</div>
    `;

    this.cards = new Map();
    for (const card of root.querySelectorAll('.ability-card[data-element]')) {
      this.cards.set(card.dataset.element, card);
      card.addEventListener('pointerdown', (event) => {
        event.stopPropagation();
        this.onAbility?.(card.dataset.element);
      });
    }

    this.boostCard = root.querySelector('[data-boost]');
    this.boostCard.addEventListener('pointerdown', (event) => {
      event.stopPropagation();
      this.onBoost?.();
    });

    this.magicCard = root.querySelector('[data-magic]');
    this.magicCard.addEventListener('pointerdown', (event) => {
      event.stopPropagation();
      this.onMagic?.();
    });

    this.fireCard = root.querySelector('[data-fire]');
    this.fireCard.addEventListener('pointerdown', (event) => {
      event.stopPropagation();
      this.onFire?.();
    });

    this.stats = {
      fps: root.querySelector('[data-stat="fps"]'),
      particles: root.querySelector('[data-stat="particles"]'),
      spikes: root.querySelector('[data-stat="spikes"]'),
      calls: root.querySelector('[data-stat="calls"]')
    };
    this.help = root.querySelector('.hud__help');
    this.toast = root.querySelector('[data-toast]');
    this.pausedBadge = root.querySelector('[data-paused]');
    this.abilityBar = root.querySelector('.hud__abilities');
  }

  /** @param {{silent?: boolean}} [options] */
  setElement(element, options = {}) {
    for (const [key, card] of this.cards) {
      card.classList.toggle('is-active', key === element);
    }
    const meta = ELEMENT_META[element];
    if (meta && !options.silent) this.showToast(`${meta.hint} selected`);
  }

  /** Highlight the slot while a cast is armed. */
  setArmed(armed) {
    if (armed === this._armedShown) return;
    this._armedShown = armed;
    this.abilityBar.classList.toggle('is-armed', armed);
  }

  /**
   * Drive one slot's cooldown sweep. Cooldowns are per ability, so this is
   * called once per element each frame.
   *
   * @param {string} element
   * @param {number} remaining seconds left
   * @param {number} total     the full cooldown, for the sweep angle
   */
  setCooldown(element, remaining, total) {
    const card = this.cards.get(element);
    if (!card) return;

    const ratio = Math.max(0, Math.min(1, remaining / Math.max(total, 0.001)));
    // Only touch the DOM when the sweep visibly moves.
    if (Math.abs(ratio - (this._cooldownShown.get(element) ?? -1)) < 0.01) return;
    this._cooldownShown.set(element, ratio);
    card.style.setProperty('--cooldown', ratio);
    card.classList.toggle('is-cooling', ratio > 0.001);
  }

  /**
   * Drive one self buff's slot.
   *
   * One sweep, two meanings: while the buff holds it drains from full, and once
   * it has expired it fills back up as the cooldown runs off. They are told
   * apart by the class, not by the number — charged reads as accent and keeps
   * the glyph lit, cooling reads as the same dark wipe every other slot uses.
   *
   * @param {HTMLElement} card
   * @param {{active: boolean|null, ratio: number}} shown last state pushed
   * @param {boolean} active
   * @param {number} ratio 0..1 — buff left while active, cooldown left after
   */
  _setBuff(card, shown, active, ratio) {
    const clamped = Math.max(0, Math.min(1, ratio));
    if (active === shown.active && Math.abs(clamped - shown.ratio) < 0.01) return;
    shown.active = active;
    shown.ratio = clamped;

    card.style.setProperty('--cooldown', clamped);
    card.classList.toggle('is-charged', active);
    card.classList.toggle('is-cooling', !active && clamped > 0.001);
  }

  /** @see _setBuff */
  setBoost(active, ratio) {
    this._setBuff(this.boostCard, this._boostShown, active, ratio);
  }

  /** @see _setBuff */
  setMagic(active, ratio) {
    this._setBuff(this.magicCard, this._magicShown, active, ratio);
  }

  /** @see _setBuff */
  setFire(active, ratio) {
    this._setBuff(this.fireCard, this._fireShown, active, ratio);
  }

  setPaused(paused) {
    this.pausedBadge.classList.toggle('is-visible', paused);
  }

  toggleHelp() {
    this.help.classList.toggle('is-hidden');
  }

  showToast(message, duration = 1600) {
    this.toast.textContent = message;
    this.toast.classList.add('is-visible');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => this.toast.classList.remove('is-visible'), duration);
  }

  /**
   * @param {number} dt
   * @param {() => {particles:number, spikes:number, calls:number}} collect
   *   Called only when the readout actually refreshes, so gathering the numbers
   *   (which means walking the particle pools) stays off the hot path.
   */
  update(dt, collect) {
    this._frames++;
    this._statsAccumulator += dt;
    if (this._statsAccumulator < 0.4) return;

    this._fps = Math.round(this._frames / this._statsAccumulator);
    this._frames = 0;
    this._statsAccumulator = 0;

    const info = collect();
    this.stats.fps.textContent = this._fps;
    this.stats.particles.textContent = info.particles;
    this.stats.spikes.textContent = info.spikes;
    this.stats.calls.textContent = info.calls;
  }
}

/** Boot screen helper. */
export class LoadingScreen {
  constructor() {
    this.element = document.getElementById('loader');
    this.fill = document.getElementById('loader-fill');
    this.status = document.getElementById('loader-status');
  }

  setProgress(ratio, message) {
    this.fill.style.width = `${Math.round(Math.min(1, Math.max(0, ratio)) * 100)}%`;
    if (message) this.status.textContent = message;
  }

  hide() {
    this.setProgress(1);
    setTimeout(() => this.element.classList.add('is-hidden'), 220);
  }

  fail(message) {
    this.status.textContent = message;
    this.status.style.color = '#ff7a6a';
  }
}

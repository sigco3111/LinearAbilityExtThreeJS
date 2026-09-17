import { ELEMENTS, ELEMENT_META, BOOST_META, MAGIC_META, FIRE_META } from '../config/settings.js';
import { ELEMENT_SIGILS, BOOST_SIGIL, MAGIC_SIGIL, FIRE_SIGIL } from './glyphs.js';

/**
 * 헤드업 디스플레이: 능력 바, 조작 안내, 실시간 통계, 토스트.
 *
 * 프레임워크 없이 그냥 DOM만 사용합니다. 바는 `ELEMENTS` 로부터 빌드되므로
 * 새 능력을 추가하면 자동으로 표시되고, 슬롯이 유일한 상호작용 영역이며
 * 키보드 단축키를 `onAbility` 로 그대로 미러링합니다.
 *
 * 세 자기 강화는 같은 바의 끝에 있지만 *슬롯이 아닙니다*: 선택되지 않고
 * 조준되지 않기 때문에 별도로 들고 다니며, 그 차오름은 쿨다운이 채워지는
 * 게 아니라 버프가 빠져나가는 모습을 보여줍니다.
 *
 * 쿨다운 차오름은 CSS 사용자 정의 속성으로 구동되는 `conic-gradient` 이므로,
 * 매 프레임 갱신은 `setProperty` 한 번 호출이고 레이아웃을 건드리지 않습니다.
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
    /** 마지막으로 DOM에 밀어넣은 차오름 비율, 능력별. */
    this._cooldownShown = new Map();
    this._armedShown = null;
    this._boostShown = { active: null, ratio: -1 };
    this._magicShown = { active: null, ratio: -1 };
    this._fireShown = { active: null, ratio: -1 };

    root.innerHTML = `
      <div class="hud__panel hud__title">
        원소 샌드박스
        <span data-blurb>Q, E, R, F, V, X, Z 중 하나를 눌러 조준한 뒤 클릭하여 시전합니다. B, M, K 는 자신을 강화합니다.</span>
      </div>

      <div class="hud__panel hud__stats">
        <div>FPS <b data-stat="fps">—</b></div>
        <div>파티클 <b data-stat="particles">0</b></div>
        <div>인스턴스 <b data-stat="spikes">0</b></div>
        <div>드로우 콜 <b data-stat="calls">0</b></div>
      </div>

      <div class="hud__panel hud__help">
        <div><strong>Q</strong> — 화염 왕관 &nbsp; <strong>E</strong> — 크라켄 왕관</div>
        <div><strong>R</strong> — 전기 구체 &nbsp; <strong>F</strong> — 대지의 첨탑</div>
        <div><strong>V</strong> — 녹색 관문 &nbsp; <strong>X</strong> — 격류의 고리</div>
        <div><strong>Z</strong> — 불꽃 차원의 문</div>
        <div class="hud__help-note">
          Q, E, R 은 원거리 시전 — 원으로 조준합니다. F 는 직선 시전 — 화살표로 조준합니다.
          V 는 관문 시전 — 문지방과 그 위에 선 아치로 조준합니다. X 는 고리 시전 —
          고리가 바닥에서 세워지는 시길 표식이 곧 시전 방법입니다. 평지에 눕혀 만든 다음
          일으켜 세우는 식으로 완성됩니다. Z 는 필기 시전 — 문이 걸릴 정확한 높이에
          공중에 선 원으로 조준합니다. 같은 종류의 시전을 다시 하기 전까지 세 개 모두
          열려 있으며, 각 종류는 동시에 하나씩만 세울 수 있습니다.
        </div>
        <div><strong>B</strong> — 전기 강화 &nbsp; <strong>M</strong> — 마법 강화</div>
        <div><strong>K</strong> — 불꽃 강화</div>
        <div class="hud__help-note">
          B, M, K 는 자기 강화 — 조준할 필요 없이 누르고 있으면 켜지고, 다시 누르면
          꺼집니다. 셋 중 어떤 조합이든 동시에 켜둘 수 있습니다.
        </div>
        <div><strong>이동</strong> — 조준 &nbsp; <strong>좌클릭</strong> — 시전</div>
        <div><strong>Esc / 우클릭</strong> — 시전 취소</div>
        <div><strong>우드래그</strong> — 카메라 회전 &nbsp; <strong>스크롤</strong> — 줌</div>
        <div style="margin-top:6px">
          <kbd>G</kbd> 에디터 &nbsp; <kbd>P</kbd> 일시정지 &nbsp; <kbd>C</kbd> 효과 정리
        </div>
        <div><kbd>H</kbd> 이 안내 숨기기</div>
        <div class="hud__help-note">일시정지 중에도 에디터의 변경은 모두 즉시 반영됩니다.</div>
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
      <div class="hud__paused" data-paused>일시정지</div>
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
    if (meta && !options.silent) this.showToast(`${meta.hint} 선택됨`);
  }

  /** 시전 능력이 활성화되어 있는 동안 슬롯을 강조합니다. */
  setArmed(armed) {
    if (armed === this._armedShown) return;
    this._armedShown = armed;
    this.abilityBar.classList.toggle('is-armed', armed);
  }

  /**
   * 한 슬롯의 쿨다운 차오름을 구동합니다. 쿨다운은 능력별이므로 매 프레임
   * 능력마다 한 번씩 호출됩니다.
   *
   * @param {string} element
   * @param {number} remaining 남은 초
   * @param {number} total     차오름 각도를 위한 전체 쿨다운
   */
  setCooldown(element, remaining, total) {
    const card = this.cards.get(element);
    if (!card) return;

    const ratio = Math.max(0, Math.min(1, remaining / Math.max(total, 0.001)));
    // 차오름이 시각적으로 변할 때만 DOM을 건드립니다.
    if (Math.abs(ratio - (this._cooldownShown.get(element) ?? -1)) < 0.01) return;
    this._cooldownShown.set(element, ratio);
    card.style.setProperty('--cooldown', ratio);
    card.classList.toggle('is-cooling', ratio > 0.001);
  }

  /**
   * 하나의 자기 강화 슬롯을 구동합니다.
   *
   * 차오름 하나에 두 가지 의미: 버프가 유지되는 동안은 가득 찬 상태에서
   * 빠져나가고, 만료된 뒤에는 쿨다운이 흘러 지워지면서 다시 채워집니다.
   * 둘은 숫자가 아니라 클래스로 구분합니다 — 충전 중이면 액센트 색으로
   * 표시되며 글리프가 켜져 있고, 쿨다운이면 다른 슬롯과 동일한 어두운
   * 차오름입니다.
   *
   * @param {HTMLElement} card
   * @param {{active: boolean|null, ratio: number}} shown 직전에 DOM에 넣은 상태
   * @param {boolean} active
   * @param {number} ratio 0..1 — 활성화 중일 때 남은 비율, 이후는 쿨다운 남은 비율
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
   *   실제 표시값을 새로 그릴 때에만 호출되므로, 수치를 모으는 작업
   *   (즉 파티클 풀을 걷는 일)이 매 프레임 일어나지 않습니다.
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

/** 부팅 화면 도우미. */
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

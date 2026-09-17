import GUI from 'lil-gui';
import { settings, CAST_ANIMATIONS } from '../config/settings.js';
import { PresetManager } from './PresetManager.js';

/**
 * Real-time VFX editor.
 *
 * Every control binds straight to a field in `config/settings.js`. Because all
 * shaders, particle systems, lights and post passes *read* those fields each
 * frame, no controller needs an onChange handler: moving a slider updates the
 * crown that is already standing, the sphere that is already in the air, the
 * next cast, the environment and the post stack simultaneously, with no rebuild
 * and no shader recompilation.
 *
 * That holds while the simulation is paused (`P`), which is the point — the
 * silhouette of a frozen eruption is the thing worth tuning, and every ability
 * re-resolves itself from these values on a zero-length frame.
 */
export class Editor {
  /**
   * @param {object} hooks { onClear, onToast }
   */
  constructor(hooks = {}) {
    this.hooks = hooks;
    this.presets = new PresetManager();

    this.gui = new GUI({ title: 'VFX Editor', width: 330 });
    this.gui.domElement.style.setProperty('--title-height', '30px');

    this._presetState = { name: 'My preset', selected: this.presets.names[0] ?? '' };

    this._buildPresets();
    this._buildGlobal();
    this._buildAim();
    this._buildZone();
    this._buildGate();
    this._buildRingTemplate();
    this._buildScribeTemplate();
    this._buildPyre();
    this._buildKraken();
    this._buildElectrical();
    this._buildEarth();
    this._buildPortal();
    this._buildAether();
    this._buildFirePortal();
    this._buildBoost();
    this._buildMagic();
    this._buildFire();
    this._buildEnvironment();
    this._buildPost();
    this._buildCamera();
    this._buildCharacter();

    // Everything starts collapsed, top-level folders included. There are enough
    // controls here that any folder left open pushes the rest off the screen,
    // so the panel opens as a list of sections and the user picks one.
    this.gui.foldersRecursive().forEach((folder) => folder.close());
  }

  /* ------------------------------------------------------------------ */
  /* helpers                                                             */
  /* ------------------------------------------------------------------ */

  static range(folder, object, key, min, max, step, label) {
    return folder.add(object, key, min, max, step).name(label ?? key);
  }

  /**
   * Which clip the body throws when this ability fires.
   *
   * One per ability, because the gesture is part of how a spell reads — the
   * beam and the snare should not be cast the same way. `App` reads the value
   * at the moment of the cast, so switching it applies to the very next click.
   */
  static castAnimation(folder, object) {
    return folder.add(object, 'castAnim', CAST_ANIMATIONS).name('cast animation');
  }

  /**
   * The four colour stops of a particle system's lifetime gradient.
   *
   * `ParticleSystem#setGradient` samples them across a particle's own life, so
   * they are labelled by *when* they are seen rather than by what they are —
   * `A` is the instant it is born, `D` is the moment it dies.
   *
   * @param {string} prefix settings key without the A/B/C/D suffix
   */
  static gradient(folder, object, prefix, title) {
    const group = folder.addFolder(title);
    group.addColor(object, `${prefix}A`).name('birth');
    group.addColor(object, `${prefix}B`).name('early');
    group.addColor(object, `${prefix}C`).name('late');
    group.addColor(object, `${prefix}D`).name('death');
    return group;
  }

  refresh() {
    this.gui.controllersRecursive().forEach((controller) => controller.updateDisplay());
  }

  toggle() {
    this._hidden = !this._hidden;
    this.gui.show(!this._hidden);
  }

  /* ------------------------------------------------------------------ */
  /* folders                                                             */
  /* ------------------------------------------------------------------ */

  _buildPresets() {
    const folder = this.gui.addFolder('Presets');
    const state = this._presetState;

    let selector = folder
      .add(state, 'selected', this.presets.names.length ? this.presets.names : [''])
      .name('preset');

    // lil-gui rebuilds the controller when the option list changes, so the
    // reference has to be replaced rather than mutated.
    const refreshOptions = () => {
      const names = this.presets.names;
      selector = selector.options(names.length ? names : ['']).name('preset');
      selector.setValue(names.includes(state.selected) ? state.selected : (names[0] ?? ''));
    };

    folder.add(state, 'name').name('name');

    folder
      .add(
        {
          save: () => {
            this.presets.save(state.name);
            state.selected = state.name;
            refreshOptions();
            this.hooks.onToast?.(`Saved preset "${state.name}"`);
          }
        },
        'save'
      )
      .name('Save preset');

    folder
      .add(
        {
          load: () => {
            if (this.presets.load(state.selected)) {
              this.refresh();
              this.hooks.onToast?.(`Loaded "${state.selected}"`);
            }
          }
        },
        'load'
      )
      .name('Load preset');

    folder
      .add(
        {
          duplicate: () => {
            const copy = this.presets.duplicate(state.selected);
            if (copy) {
              state.selected = copy;
              refreshOptions();
              this.hooks.onToast?.(`Duplicated to "${copy}"`);
            }
          }
        },
        'duplicate'
      )
      .name('Duplicate');

    folder
      .add(
        {
          remove: () => {
            if (this.presets.remove(state.selected)) {
              refreshOptions();
              this.hooks.onToast?.('Preset deleted');
            }
          }
        },
        'remove'
      )
      .name('Delete');

    folder.add({ exportOne: () => this.presets.exportJSON() }, 'exportOne').name('Export current (JSON)');
    folder.add({ exportAll: () => this.presets.exportAll() }, 'exportAll').name('Export all presets');

    folder
      .add(
        {
          import: async () => {
            const result = await this.presets.importFromFile();
            refreshOptions();
            this.refresh();
            this.hooks.onToast?.(
              result.applied
                ? 'Settings imported'
                : result.imported.length
                  ? `Imported ${result.imported.length} preset(s)`
                  : 'Nothing imported'
            );
          }
        },
        'import'
      )
      .name('Import JSON…');

    folder
      .add(
        {
          reset: () => {
            this.presets.reset();
            this.refresh();
            this.hooks.onToast?.('Reset to defaults');
          }
        },
        'reset'
      )
      .name('Reset to defaults');

    this.presetFolder = folder;
  }

  _buildGlobal() {
    const folder = this.gui.addFolder('Global');
    const g = settings.global;
    const R = Editor.range;

    R(folder, g, 'timeScale', 0.02, 2, 0.01, 'time scale');
    R(folder, g, 'speed', 0.1, 4, 0.01, 'cast speed');
    R(folder, g, 'lifetime', 0.1, 4, 0.01, 'lifetime');
    R(folder, g, 'glow', 0, 5, 0.01, 'glow intensity');
    R(folder, g, 'shaderIntensity', 0, 2, 0.01, 'shader intensity');
    R(folder, g, 'opacity', 0, 2, 0.01, 'opacity');
    R(folder, g, 'noiseFrequency', 0.1, 4, 0.01, 'noise frequency');
    R(folder, g, 'noiseSpeed', 0, 4, 0.01, 'noise speed');
    R(folder, g, 'turbulence', 0, 4, 0.01, 'turbulence');
    R(folder, g, 'randomness', 0, 2, 0.01, 'randomness');
    R(folder, g, 'fresnel', 0, 3, 0.01, 'fresnel strength');
    R(folder, g, 'distortion', 0, 3, 0.01, 'heat distortion');

    const particles = folder.addFolder('Particles');
    R(particles, g, 'particleCount', 0, 3, 0.01, 'count');
    R(particles, g, 'particleLifetime', 0.1, 3, 0.01, 'lifetime');
    R(particles, g, 'particleSpeed', 0.1, 3, 0.01, 'speed');
    R(particles, g, 'particleSize', 0.1, 3, 0.01, 'size');
    R(particles, g, 'emissionRate', 0, 3, 0.01, 'emission rate');

    const lighting = folder.addFolder('Lighting & impact');
    R(lighting, g, 'lightIntensity', 0, 4, 0.01, 'light intensity');
    R(lighting, g, 'lightRadius', 0.1, 4, 0.01, 'light radius');
    R(lighting, g, 'explosionIntensity', 0, 3, 0.01, 'impact intensity');
    R(lighting, g, 'cameraShake', 0, 3, 0.01, 'camera shake');
    R(lighting, g, 'animationSpeed', 0, 3, 0.01, 'animation speed');

    this.globalFolder = folder;
  }

  /* ------------------------------------------------------------------ */

  _buildAim() {
    const folder = this.gui.addFolder('➤  Aim indicator');
    const a = settings.aim;
    const R = Editor.range;

    const shape = folder.addFolder('Silhouette (metres)');
    R(shape, a, 'shaftWidth', 0.05, 2, 0.01, 'shaft half-width');
    R(shape, a, 'headLength', 0.2, 8, 0.05, 'head length');
    R(shape, a, 'headWidth', 0.1, 5, 0.01, 'head half-width');
    R(shape, a, 'round', 0, 0.6, 0.01, 'corner rounding');
    R(shape, a, 'startOffset', 0, 5, 0.05, 'gap at the caster');
    R(shape, a, 'height', 0.005, 0.4, 0.005, 'hover height');

    const look = folder.addFolder('Rendering');
    R(look, a, 'edge', 0.01, 0.5, 0.005, 'outline thickness');
    R(look, a, 'edgeGlow', 0, 8, 0.05, 'outline glow');
    R(look, a, 'softness', 0.005, 0.5, 0.005, 'edge softness');
    R(look, a, 'fill', 0, 1.5, 0.01, 'interior fill');
    R(look, a, 'fillFalloff', 0.1, 4, 0.05, 'fill falloff');
    R(look, a, 'opacity', 0, 2, 0.01, 'opacity');
    look.addColor(a, 'colorCore').name('core colour');
    look.addColor(a, 'colorEdge').name('edge colour');
    look.addColor(a, 'colorInvalid').name('too-close colour');

    const energy = folder.addFolder('Energy & frost');
    R(energy, a, 'stripes', 0, 4, 0.01, 'chevrons / metre');
    R(energy, a, 'stripeSharp', 0, 1, 0.01, 'chevron sharpness');
    R(energy, a, 'stripeDepth', 0, 1, 0.01, 'chevron depth');
    R(energy, a, 'scrollSpeed', -10, 10, 0.05, 'scroll speed');
    R(energy, a, 'pulse', 0, 1, 0.01, 'pulse');
    R(energy, a, 'pulseSpeed', 0, 8, 0.05, 'pulse speed');
    R(energy, a, 'noise', 0, 1.5, 0.01, 'frost noise');
    R(energy, a, 'noiseScale', 0.1, 8, 0.05, 'noise scale');
    R(energy, a, 'noiseSpeed', 0, 3, 0.01, 'noise speed');
    R(energy, a, 'crystals', 0, 2, 0.01, 'frost plates');
    R(energy, a, 'crystalScale', 0.2, 10, 0.05, 'plate scale');

    const furniture = folder.addFolder('Rings & rosette');
    R(furniture, a, 'baseRing', 0, 3, 0.01, 'base ring radius');
    R(furniture, a, 'baseRingWidth', 0.005, 0.4, 0.005, 'base ring width');
    R(furniture, a, 'tipGlyph', 0, 2, 0.01, 'tip rosette');
    R(furniture, a, 'tipGlyphSize', 0.1, 4, 0.05, 'rosette radius');
    R(furniture, a, 'tipSpin', -3, 3, 0.01, 'rosette spin');
    R(furniture, a, 'rangeArc', 0, 2, 0.01, 'range arc');
    R(furniture, a, 'reveal', 0.01, 1, 0.005, 'sweep-out time');
  }

  /* ------------------------------------------------------------------ */

  /**
   * The far-cast indicator — the circle every zone ability is aimed with.
   *
   * Shared, like the arrow: it is a property of the *targeting*, not of any one
   * ability, so a second far cast inherits the whole thing and brings only its
   * own `zoneRadius`. The two controls worth reaching for first are `boundary`
   * (how thick the footprint edge reads) and `snap` (how hard it overshoots on
   * the way out), which between them decide whether the circle feels like a UI
   * overlay or like something the caster is doing.
   */
  _buildZone() {
    const folder = this.gui.addFolder('◎  Far-cast circle');
    const z = settings.zone;
    const R = Editor.range;

    const edge = folder.addFolder('The boundary (metres)');
    R(edge, z, 'boundary', 0.02, 2, 0.01, 'band thickness');
    R(edge, z, 'boundaryBias', 0, 1, 0.01, 'band bias out/in');
    R(edge, z, 'boundaryGlow', 0, 8, 0.05, 'band glow');
    R(edge, z, 'liner', 0.005, 0.4, 0.005, 'inner liner');
    R(edge, z, 'softness', 0.005, 0.4, 0.005, 'edge softness');
    R(edge, z, 'height', 0.005, 0.4, 0.005, 'hover height');

    const inside = folder.addFolder('The interior');
    R(inside, z, 'fill', 0, 1.5, 0.01, 'interior fill');
    R(inside, z, 'fillFalloff', 0.1, 5, 0.05, 'fill falloff');
    R(inside, z, 'rings', 0, 12, 0.1, 'contour rings');
    R(inside, z, 'ringWidth', 0.005, 0.5, 0.005, 'ring width');
    R(inside, z, 'ringSpeed', -4, 4, 0.01, 'ring speed');
    R(inside, z, 'crawl', 0, 3, 0.01, 'filaments');
    R(inside, z, 'crawlScale', 0.1, 8, 0.05, 'filaments / metre');
    R(inside, z, 'crawlSpeed', -4, 4, 0.01, 'filament crawl');
    R(inside, z, 'noise', 0, 1.5, 0.01, 'break-up');
    R(inside, z, 'noiseScale', 0.1, 8, 0.05, 'break-up scale');

    const furniture = folder.addFolder('Ticks, sweep & reticle');
    R(furniture, z, 'ticks', 0, 96, 1, 'boundary ticks');
    R(furniture, z, 'tickLength', 0.05, 3, 0.01, 'tick length');
    R(furniture, z, 'tickWidth', 0.02, 0.9, 0.01, 'tick duty');
    R(furniture, z, 'tickSpin', -2, 2, 0.005, 'tick spin');
    R(furniture, z, 'sweep', 0, 3, 0.01, 'radar sweep');
    R(furniture, z, 'sweepSpeed', -3, 3, 0.01, 'sweep speed');
    R(furniture, z, 'core', 0, 3, 0.01, 'centre mark');
    R(furniture, z, 'coreSize', 0.05, 3, 0.01, 'centre size');
    R(furniture, z, 'crosshair', 0, 3, 0.01, 'reticle arms');
    R(furniture, z, 'crosshairLength', 0.1, 6, 0.05, 'arm length');
    R(furniture, z, 'pulse', 0, 1, 0.01, 'pulse');
    R(furniture, z, 'pulseSpeed', 0, 8, 0.05, 'pulse speed');

    const reach = folder.addFolder('The reach ring');
    R(reach, z, 'reach', 0, 3, 0.01, 'reach brightness');
    R(reach, z, 'reachWidth', 0.005, 0.5, 0.005, 'reach width');
    R(reach, z, 'reachDashes', 0, 200, 1, 'dashes');
    R(reach, z, 'reachDashGap', 0, 0.95, 0.01, 'dash gap');
    R(reach, z, 'reachSpin', -1, 1, 0.005, 'dash creep');
    R(reach, z, 'reachLead', 0, 3, 0.01, 'lead marker');

    const look = folder.addFolder('Rendering');
    R(look, z, 'opacity', 0, 2, 0.01, 'opacity');
    R(look, z, 'reveal', 0.01, 1, 0.005, 'snap-out time');
    R(look, z, 'snap', 1, 2, 0.01, 'snap overshoot');
    look.addColor(z, 'colorCore').name('core colour');
    look.addColor(z, 'colorEdge').name('fill colour');
    look.addColor(z, 'colorInvalid').name('too-close colour');
  }


  /* ------------------------------------------------------------------ */

  /**
   * The gate template — the third targeting shape.
   *
   * What separates it from the arrow and the circle is the **ghost**: an
   * upright preview of the arch, drawn in the gate's own plane, so the cast
   * shows the facing of the thing it is about to build. `ghostRise` is the
   * control worth reaching for first — it is how much of the reveal is spent
   * drawing the contour floor-upward, and taking it to 0 switches the preview
   * from being sketched to being switched on.
   *
   * The opening's *size* is not in this folder on purpose: the ghost reads the
   * span and the springing line off the ability, so the preview and the gate
   * that gets built can never disagree.
   */
  _buildGate() {
    const folder = this.gui.addFolder('⌂  Gate template');
    const g = settings.gate;
    const R = Editor.range;

    const threshold = folder.addFolder('The threshold (metres)');
    R(threshold, g, 'thresholdDepth', 0.1, 3, 0.01, 'slot half-depth');
    R(threshold, g, 'jambPad', 0.1, 2.5, 0.01, 'jamb pad radius');
    R(threshold, g, 'edge', 0.01, 0.5, 0.005, 'outline thickness');
    R(threshold, g, 'edgeGlow', 0, 8, 0.05, 'outline glow');
    R(threshold, g, 'softness', 0.005, 0.4, 0.005, 'edge softness');
    R(threshold, g, 'fill', 0, 1.5, 0.01, 'interior fill');
    R(threshold, g, 'ticks', 0, 40, 1, 'rungs');
    R(threshold, g, 'tickWidth', 0.005, 0.4, 0.005, 'rung duty');
    R(threshold, g, 'height', 0.005, 0.4, 0.005, 'hover height');

    const ghost = folder.addFolder('The standing arch ghost');
    R(ghost, g, 'ghost', 0, 3, 0.01, 'master strength');
    R(ghost, g, 'ghostLine', 0.01, 0.5, 0.005, 'contour thickness');
    R(ghost, g, 'ghostGlow', 0, 8, 0.05, 'contour glow');
    R(ghost, g, 'ghostFill', 0, 1.5, 0.01, 'opening wash');
    R(ghost, g, 'ghostFillFalloff', 0.1, 5, 0.05, 'wash falloff');
    R(ghost, g, 'ghostDashes', 0, 8, 0.05, 'dashes / metre');
    R(ghost, g, 'ghostDashGap', 0, 0.95, 0.01, 'dash gap');
    R(ghost, g, 'ghostScroll', -6, 6, 0.05, 'dash climb (m/s)');
    R(ghost, g, 'ghostRise', 0.05, 1, 0.01, 'drawn floor-up over');
    R(ghost, g, 'ghostNoise', 0, 1.5, 0.01, 'break-up');
    R(ghost, g, 'ghostNoiseScale', 0.1, 6, 0.05, 'break-up scale');

    const reach = folder.addFolder('The reach ring');
    R(reach, g, 'reach', 0, 3, 0.01, 'reach brightness');
    R(reach, g, 'reachWidth', 0.005, 0.5, 0.005, 'reach width');
    R(reach, g, 'reachDashes', 0, 200, 1, 'dashes');
    R(reach, g, 'reachDashGap', 0, 0.95, 0.01, 'dash gap');
    R(reach, g, 'reachSpin', -1, 1, 0.005, 'dash creep');
    R(reach, g, 'reachLead', 0, 3, 0.01, 'lead marker');

    const look = folder.addFolder('Rendering');
    R(look, g, 'pulse', 0, 1, 0.01, 'pulse');
    R(look, g, 'pulseSpeed', 0, 8, 0.05, 'pulse speed');
    R(look, g, 'opacity', 0, 2, 0.01, 'opacity');
    R(look, g, 'reveal', 0.01, 1, 0.005, 'draw-out time');
    look.addColor(g, 'colorCore').name('core colour');
    look.addColor(g, 'colorEdge').name('fill colour');
    look.addColor(g, 'colorInvalid').name('too-close colour');
  }

  /* ------------------------------------------------------------------ */

  /**
   * The ring template.
   *
   * The only template with two halves that disagree about where the cast
   * happens, and that is the point: `The sigil` is the floor the ring is forged
   * on, `The tipping ghost` is where it ends up, and `stood up over` is how
   * much of the reveal is spent getting from one to the other. Set that to 1
   * and the ring is still rising as you click; set it small and it snaps
   * upright the instant the template appears.
   */
  _buildRingTemplate() {
    const folder = this.gui.addFolder('◎  Ring template');
    const g = settings.ring;
    const R = Editor.range;

    const contour = folder.addFolder('The contour');
    R(contour, g, 'lobes', 0, 16, 1, 'lobes');
    R(contour, g, 'lobeDepth', 0, 0.3, 0.005, 'lobe depth');

    const sigil = folder.addFolder('The sigil (metres)');
    R(sigil, g, 'band', 0.01, 0.6, 0.005, 'contour thickness');
    R(sigil, g, 'bandGlow', 0, 8, 0.05, 'contour glow');
    R(sigil, g, 'softness', 0.005, 0.4, 0.005, 'edge softness');
    R(sigil, g, 'fill', 0, 1.5, 0.01, 'interior fill');
    R(sigil, g, 'fillFalloff', 0.1, 5, 0.05, 'fill falloff');
    R(sigil, g, 'spokes', 1, 40, 1, 'spokes');
    R(sigil, g, 'spokeWidth', 0.01, 0.5, 0.01, 'spoke duty');
    R(sigil, g, 'spokeLength', 0.05, 1, 0.01, 'spoke reach');
    R(sigil, g, 'ticks', 1, 60, 1, 'segment ticks');
    R(sigil, g, 'tickWidth', 0.01, 0.5, 0.01, 'tick duty');
    R(sigil, g, 'tickLength', 0.02, 1, 0.01, 'tick reach (m)');
    R(sigil, g, 'spin', -1, 1, 0.005, 'idle spin');
    R(sigil, g, 'noise', 0, 1.5, 0.01, 'break-up');
    R(sigil, g, 'noiseScale', 0.1, 6, 0.05, 'break-up scale');
    R(sigil, g, 'sweep', 0.05, 1, 0.01, 'drawn from the foot over');
    R(sigil, g, 'height', 0.005, 0.4, 0.005, 'hover height');

    const ghost = folder.addFolder('The tipping ghost');
    R(ghost, g, 'ghost', 0, 3, 0.01, 'master strength');
    R(ghost, g, 'ghostLine', 0.01, 0.5, 0.005, 'contour thickness');
    R(ghost, g, 'ghostGlow', 0, 8, 0.05, 'contour glow');
    R(ghost, g, 'ghostFill', 0, 1.5, 0.01, 'opening wash');
    R(ghost, g, 'ghostFillFalloff', 0.1, 5, 0.05, 'wash falloff');
    R(ghost, g, 'ghostDashes', 0, 8, 0.05, 'dashes / metre');
    R(ghost, g, 'ghostDashGap', 0, 0.95, 0.01, 'dash gap');
    R(ghost, g, 'ghostScroll', -6, 6, 0.05, 'dash creep (m/s)');
    R(ghost, g, 'ghostNoise', 0, 1.5, 0.01, 'break-up');
    R(ghost, g, 'ghostNoiseScale', 0.1, 6, 0.05, 'break-up scale');
    R(ghost, g, 'ghostRise', 0.05, 1, 0.01, 'stood up over');

    const reach = folder.addFolder('The reach ring');
    R(reach, g, 'reach', 0, 3, 0.01, 'reach brightness');
    R(reach, g, 'reachWidth', 0.005, 0.5, 0.005, 'reach width');
    R(reach, g, 'reachDashes', 0, 200, 1, 'dashes');
    R(reach, g, 'reachDashGap', 0, 0.95, 0.01, 'dash gap');
    R(reach, g, 'reachSpin', -1, 1, 0.005, 'dash creep');
    R(reach, g, 'reachLead', 0, 3, 0.01, 'lead marker');

    const look = folder.addFolder('Rendering');
    R(look, g, 'pulse', 0, 1, 0.01, 'pulse');
    R(look, g, 'pulseSpeed', 0, 8, 0.05, 'pulse speed');
    R(look, g, 'opacity', 0, 2, 0.01, 'opacity');
    R(look, g, 'reveal', 0.01, 1, 0.005, 'draw-out time');
    look.addColor(g, 'colorCore').name('core colour');
    look.addColor(g, 'colorEdge').name('fill colour');
    look.addColor(g, 'colorInvalid').name('too-close colour');
  }

  /* ------------------------------------------------------------------ */

  /**
   * The scribe template: the circle the Fire Portal will hang in.
   *
   * The shortest template folder in the panel, and it should be — there is no
   * footprint to diagram, so all it draws is the circle itself, standing in the
   * air exactly where the ring will be. The size comes from the ability's own
   * `clear radius` and `clears the floor by`, so the preview and the portal
   * cannot disagree, and the distance read the other templates get off the
   * ground is carried by the reach ring instead.
   */
  _buildScribeTemplate() {
    const folder = this.gui.addFolder('◌  Scribe template');
    const g = settings.scribe;
    const R = Editor.range;

    const circle = folder.addFolder('The circle (metres)');
    R(circle, g, 'line', 0.01, 0.5, 0.005, 'contour thickness');
    R(circle, g, 'lineGlow', 0, 8, 0.05, 'contour glow');
    R(circle, g, 'fill', 0, 1, 0.01, 'interior wash');
    R(circle, g, 'fillFalloff', 0.1, 5, 0.05, 'wash falloff');
    R(circle, g, 'dashes', 0, 8, 0.05, 'embers / metre');
    R(circle, g, 'dashGap', 0, 0.95, 0.01, 'ember gap');
    R(circle, g, 'scroll', -6, 6, 0.05, 'ember creep (m/s)');
    R(circle, g, 'sweep', 0.05, 1, 0.01, 'drawn from the foot over');

    const reach = folder.addFolder('The reach ring');
    R(reach, g, 'reach', 0, 3, 0.01, 'reach brightness');
    R(reach, g, 'reachWidth', 0.005, 0.5, 0.005, 'reach width');
    R(reach, g, 'reachDashes', 0, 200, 1, 'dashes');
    R(reach, g, 'reachDashGap', 0, 0.95, 0.01, 'dash gap');
    R(reach, g, 'reachSpin', -1, 1, 0.005, 'dash creep');
    R(reach, g, 'reachLead', 0, 3, 0.01, 'lead marker');

    const look = folder.addFolder('Rendering');
    R(look, g, 'pulse', 0, 1, 0.01, 'pulse');
    R(look, g, 'pulseSpeed', 0, 8, 0.05, 'pulse speed');
    R(look, g, 'opacity', 0, 2, 0.01, 'opacity');
    R(look, g, 'reveal', 0.01, 1, 0.005, 'draw-out time');
    R(look, g, 'height', 0.005, 0.4, 0.005, 'reach hover height');
    look.addColor(g, 'colorCore').name('contour core');
    look.addColor(g, 'colorEdge').name('wash colour');
    look.addColor(g, 'colorInvalid').name('too-close colour');
  }

  /* ------------------------------------------------------------------ */

  /**
   * The fire crown.
   *
   * Three groups carry this one. **Burning fire** is where the look is made, and
   * `sharp` is the control that matters most in it — it is the contrast curve
   * that turns a soft gradient into tongues with black voids between them, and
   * dropping it to 0 is the fastest way to see what the rest of the group is
   * actually doing. **The eruption** has no overshoot control, on purpose: it
   * ships with `riseSnap` and `creep` instead, which cannot bounce. And
   * **Combustion front & burn-down** is how the fire arrives and how it leaves.
   */
  _buildPyre() {
    const folder = this.gui.addFolder('☼  Pyre Crown');
    const c = settings.pyre;
    const R = Editor.range;

    const cast = folder.addFolder('The cast');
    R(cast, c, 'zoneRadius', 0.5, 14, 0.05, 'footprint radius');
    R(cast, c, 'range', 2, 50, 0.1, 'max range');
    R(cast, c, 'minRange', 0, 10, 0.1, 'min range');
    R(cast, c, 'speed', 5, 200, 1, 'front speed');
    R(cast, c, 'snapTime', 0.02, 1.5, 0.01, 'burn-out time');
    R(cast, c, 'lifetime', 0.2, 14, 0.05, 'blaze time');
    R(cast, c, 'burnDelay', 0, 4, 0.01, 'delay before it goes out');
    R(cast, c, 'burnSweep', 0, 3, 0.01, 'burn-out sweep');
    R(cast, c, 'burnStagger', 0, 3, 0.01, 'burn-out stagger');
    R(cast, c, 'ashTime', 0.05, 5, 0.01, 'burn-down time');
    R(cast, c, 'cooldown', 0, 8, 0.05, 'cooldown');
    Editor.castAnimation(cast, c);

    const hand = folder.addFolder('Where the fire leaves the hand');
    R(hand, c, 'handHeight', 0, 3, 0.01, 'hand height');
    R(hand, c, 'handForward', -1, 3, 0.01, 'hand forward');
    R(hand, c, 'handSide', -1.5, 1.5, 0.01, 'hand lateral');
    R(hand, c, 'castFlash', 0, 2, 0.01, 'flash on release');
    hand.addColor(c, 'colorCastFlash').name('release flash colour');

    const fill = folder.addFolder('Filling the footprint');
    R(fill, c, 'spikeCount', 1, 320, 1, 'blades');
    R(fill, c, 'density', 0.1, 2, 0.01, 'density');
    R(fill, c, 'ringShare', 0, 1, 0.01, 'share on the wall');
    R(fill, c, 'coreShare', 0, 0.5, 0.01, 'share on the pyre');
    R(fill, c, 'lateShare', 0, 0.5, 0.01, 'share held back');
    R(fill, c, 'ringSeat', 0.2, 1.4, 0.01, 'wall seat, × footprint');
    R(fill, c, 'ringScatter', 0, 0.6, 0.005, 'wall jitter, × footprint');
    R(fill, c, 'skirtSeat', 0, 1.4, 0.01, 'skirt inner lip, × footprint');
    R(fill, c, 'skirtBand', 0.02, 1.4, 0.01, 'skirt width, × footprint');
    R(fill, c, 'skirtBias', 0.2, 3, 0.01, 'skirt crowding');
    R(fill, c, 'coreSpread', 0.01, 0.6, 0.005, 'pyre cluster, × footprint');

    const shape = folder.addFolder('Silhouette');
    R(shape, c, 'ringHeight', 0.2, 12, 0.05, 'wall height');
    R(shape, c, 'ringWave', 0, 1, 0.01, 'crest unevenness');
    R(shape, c, 'skirtHeight', 0.05, 6, 0.05, 'skirt height');
    R(shape, c, 'coreHeight', 0.2, 12, 0.05, 'pyre height');
    R(shape, c, 'heightJitter', 0, 1.5, 0.01, 'height jitter');
    R(shape, c, 'ringLean', -1.5, 1.5, 0.01, 'wall lean (0 = a fence)');
    R(shape, c, 'skirtLean', -1.5, 1.5, 0.01, 'skirt lean');
    R(shape, c, 'coreLean', -1.5, 1.5, 0.01, 'pyre lean');
    R(shape, c, 'leanJitter', 0, 3, 0.01, 'lean jitter');
    R(shape, c, 'fan', 0, 1.6, 0.01, 'splay off the radius');
    R(shape, c, 'twist', 0, 1, 0.01, 'random yaw');
    R(shape, c, 'rubble', 0, 1, 0.01, 'rubble fraction');
    R(shape, c, 'rubbleScale', 0.05, 1, 0.01, 'rubble height');

    const blade = folder.addFolder('The blade');
    R(blade, c, 'radius', 0.05, 1.2, 0.005, 'base radius');
    R(blade, c, 'radiusJitter', 0, 1.5, 0.01, 'radius jitter');
    R(blade, c, 'belly', 0.4, 3, 0.01, 'belly (1 = a cone)');
    R(blade, c, 'bellyAt', 0.05, 0.95, 0.01, 'widest point up the blade');
    R(blade, c, 'taper', 0.01, 0.9, 0.01, 'tip taper');
    R(blade, c, 'facets', 3, 12, 1, 'facets');
    R(blade, c, 'roughness', 0, 1, 0.01, 'facet roughness');
    R(blade, c, 'bend', 0, 1.5, 0.01, 'bend');

    const bloom = folder.addFolder('The eruption');
    R(bloom, c, 'sweepTime', 0, 3, 0.01, 'sweep around the ring');
    R(bloom, c, 'skirtDelay', 0, 2, 0.01, 'skirt delay');
    R(bloom, c, 'skirtWave', 0, 2, 0.01, 'skirt wave');
    R(bloom, c, 'coreDelay', 0, 2, 0.01, 'pyre delay');
    R(bloom, c, 'stagger', 0, 1, 0.005, 'random stagger');
    R(bloom, c, 'bloomSpread', 0, 1, 0.01, 'late blades spread');
    R(bloom, c, 'riseTime', 0.02, 1.5, 0.01, 'rise time');
    R(bloom, c, 'riseSnap', 0, 1, 0.01, 'rise snap (never overshoots)');
    R(bloom, c, 'creep', 0, 0.5, 0.005, 'creep past full height');
    R(bloom, c, 'creepTime', 0.05, 6, 0.05, 'creep time');
    R(bloom, c, 'sink', 0, 1.5, 0.01, 'sink as it dies');

    const material = folder.addFolder('Burning fire');
    R(material, c, 'opacity', 0, 1, 0.01, 'opacity');
    R(material, c, 'flameGain', 0, 4, 0.01, 'heat');
    R(material, c, 'sharp', 0, 1, 0.01, 'tongue edges (0 = a wash)');
    R(material, c, 'flameScale', 0.5, 16, 0.05, 'flame scale');
    R(material, c, 'flameStretch', 0.02, 2, 0.01, 'stretch along the blade');
    R(material, c, 'flameSpeed', -6, 6, 0.01, 'climb speed');
    R(material, c, 'curl', 0, 2, 0.01, 'licking (domain warp)');
    R(material, c, 'heatBias', 0.2, 6, 0.01, 'crowding to the point');
    R(material, c, 'soot', 0, 1, 0.01, 'soot at the foot');
    R(material, c, 'sootHeight', 0.01, 1, 0.01, 'soot height');
    R(material, c, 'rim', 0, 3, 0.01, 'hot silhouette');
    R(material, c, 'rimPower', 0.5, 8, 0.01, 'silhouette tightness');
    R(material, c, 'tipStart', 0, 1, 0.01, 'tip start');
    R(material, c, 'tipGlow', 0, 6, 0.01, 'tip glow');
    R(material, c, 'flicker', 0, 1, 0.01, 'gutter depth');
    R(material, c, 'flickerSpeed', 0, 30, 0.1, 'gutter speed');
    R(material, c, 'rock', 0, 2, 0.01, 'charred stone showing through');
    R(material, c, 'envIntensity', 0, 3, 0.01, 'env reflection');
    R(material, c, 'specular', 0, 8, 0.05, 'sun glint');
    R(material, c, 'glow', 0, 4, 0.01, 'glow');
    R(material, c, 'birthGlow', 0, 6, 0.01, 'birth flash');
    R(material, c, 'birthFade', 0.02, 3, 0.01, 'birth fade');
    material.addColor(c, 'colorChar').name('voids');
    material.addColor(c, 'colorEmber').name('deep red');
    material.addColor(c, 'colorFlame').name('orange');
    material.addColor(c, 'colorCore').name('white-hot');
    material.addColor(c, 'colorRock').name('stone');
    material.addColor(c, 'colorRim').name('silhouette');
    material.addColor(c, 'colorAsh').name('ash');

    const growth = folder.addFolder('Combustion front & burn-down');
    R(growth, c, 'frontRough', 0, 1.5, 0.01, 'front raggedness');
    R(growth, c, 'frontWidth', 0.01, 0.8, 0.01, 'front width');
    R(growth, c, 'frontGlow', 0, 8, 0.05, 'front glow');
    R(growth, c, 'charRough', 0, 1.5, 0.01, 'ash-line raggedness');
    R(growth, c, 'charEdge', 0.005, 0.4, 0.005, 'ember rim width');
    R(growth, c, 'charGlow', 0, 8, 0.05, 'ember rim glow');
    R(growth, c, 'ashDrain', 0, 1, 0.01, 'how far the fire drains out');

    const field = folder.addFolder('The crater');
    R(field, c, 'fieldBoundary', 0.02, 2, 0.01, 'band thickness');
    R(field, c, 'fieldBoundaryGlow', 0, 8, 0.05, 'band glow');
    R(field, c, 'fieldFill', 0, 2, 0.01, 'interior fill');
    R(field, c, 'fieldFalloff', 0.1, 5, 0.05, 'fill falloff');
    R(field, c, 'fieldPlates', 0, 3, 0.01, 'crust break-up');
    R(field, c, 'fieldCrackScale', 0.2, 10, 0.05, 'plates / metre');
    R(field, c, 'fieldCrackWidth', 0.02, 1, 0.01, 'seam width');
    R(field, c, 'fieldCracks', 0, 4, 0.01, 'molten seams');
    R(field, c, 'fieldVeins', 0, 3, 0.01, 'runnels');
    R(field, c, 'fieldVeinScale', 0.1, 8, 0.05, 'runnels / metre');
    R(field, c, 'fieldWarp', 0, 2, 0.01, 'domain warp');
    R(field, c, 'fieldCrawl', -4, 4, 0.01, 'runnel crawl');
    R(field, c, 'fieldEmbers', 0, 4, 0.01, 'embers in the crust');
    R(field, c, 'fieldEmberScale', 0.5, 20, 0.1, 'embers / metre');
    R(field, c, 'fieldRings', 0, 12, 0.1, 'heat rings');
    R(field, c, 'fieldRingSpeed', -6, 6, 0.01, 'ring speed');
    R(field, c, 'fieldSweep', 0, 3, 0.01, 'sweep');
    R(field, c, 'fieldSweepSpeed', -2, 2, 0.01, 'sweep speed');
    R(field, c, 'fieldCore', 0, 4, 0.01, 'pool of melt');
    R(field, c, 'fieldCoreSize', 0.02, 1, 0.005, 'pool size, × footprint');
    R(field, c, 'fieldPulse', 0, 1, 0.01, 'pulse');
    R(field, c, 'fieldPulseSpeed', 0, 10, 0.05, 'pulse speed');
    R(field, c, 'fieldOpacity', 0, 2, 0.01, 'opacity');
    R(field, c, 'fieldHeight', 0.005, 0.4, 0.005, 'hover height');
    field.addColor(c, 'colorField').name('crust & runnels');
    field.addColor(c, 'colorFieldEdge').name('band & seams');

    const veil = folder.addFolder('The wall of flame');
    R(veil, c, 'veil', 0, 2, 0.01, 'opacity (0 hides it)');
    R(veil, c, 'veilHeight', 0.1, 8, 0.05, 'height');
    R(veil, c, 'veilRadius', 0.5, 1.6, 0.005, 'seat, × footprint');
    R(veil, c, 'veilFlare', -0.5, 1.5, 0.01, 'outward lean');
    R(veil, c, 'veilBillow', 0, 1.5, 0.01, 'silhouette lobes');
    R(veil, c, 'veilScale', 0.1, 6, 0.05, 'noise / metre');
    R(veil, c, 'veilStretch', 0.05, 3, 0.01, 'vertical stretch');
    R(veil, c, 'veilFlow', -6, 6, 0.01, 'climb speed');
    R(veil, c, 'veilErode', 0, 1, 0.01, 'erosion with height');
    R(veil, c, 'veilFalloff', 0.2, 6, 0.05, 'thinning with height');
    R(veil, c, 'veilSpin', -1, 1, 0.005, 'rotation');
    R(veil, c, 'veilSoftFade', 0.02, 3, 0.01, 'soft intersection');
    veil.addColor(c, 'colorVeil').name('body');
    veil.addColor(c, 'colorVeilCrest').name('crest (at the floor)');
    veil.addColor(c, 'colorVeilSmoke').name('smoke (at the top)');

    const haze = folder.addFolder('Heat haze');
    R(haze, c, 'haze', 0, 4, 0.01, 'strength (0 hides it)');
    R(haze, c, 'hazeHeight', 0.2, 12, 0.05, 'height');
    R(haze, c, 'hazeRadius', 0.5, 2.5, 0.01, 'seat, × footprint');
    R(haze, c, 'hazeFrequency', 0.2, 10, 0.05, 'cells / metre');
    R(haze, c, 'hazeSpeed', -6, 6, 0.01, 'rise speed');
    R(haze, c, 'hazeFalloff', 0.2, 6, 0.05, 'thinning with height');

    const ground = folder.addFolder('Scorch & fractures');
    R(ground, c, 'trailScorchRate', 0.05, 10, 0.05, 'trail scorch / metre');
    R(ground, c, 'trailScorchRadius', 0.05, 6, 0.05, 'trail scorch radius');
    R(ground, c, 'scorchSpread', 0.2, 4, 0.05, 'impact scorch, × footprint');
    R(ground, c, 'scorchLife', 0.5, 20, 0.1, 'scorch lifetime');
    R(ground, c, 'scorchIntensity', 0, 2, 0.01, 'scorch intensity');
    R(ground, c, 'scorchCollar', 0, 8, 0.05, 'collar, × blade radius');
    R(ground, c, 'scorchRate', 0, 20, 0.1, 'rim scorch / sec');
    R(ground, c, 'scorchRadius', 0.05, 6, 0.05, 'rim scorch radius');
    R(ground, c, 'fractureSpread', 0.2, 4, 0.05, 'fractures, × footprint');
    R(ground, c, 'fractureWidth', 0, 1, 0.01, 'fracture width');
    R(ground, c, 'fractureIntensity', 0, 3, 0.01, 'fracture intensity');
    R(ground, c, 'shockRadius', 0.5, 25, 0.1, 'shockwave radius');
    R(ground, c, 'ringRate', 0, 12, 0.1, 'heat rings / sec');
    ground.addColor(c, 'colorScorch').name('burnt ground');
    ground.addColor(c, 'colorScorchEmber').name('cooling embers');
    ground.addColor(c, 'colorFracture').name('molten fracture');
    ground.addColor(c, 'colorShockA').name('shockwave ring');
    ground.addColor(c, 'colorShockB').name('shockwave crest');

    const air = folder.addFolder('Smoke, embers & the updraft');
    R(air, c, 'smokeRate', 0, 900, 1, 'smoke rate');
    R(air, c, 'smokeSize', 0.05, 4, 0.01, 'smoke size');
    R(air, c, 'smokeSpeed', 0, 10, 0.05, 'smoke speed');
    R(air, c, 'smokeLifetime', 0.2, 8, 0.05, 'smoke lifetime');
    R(air, c, 'smokeOpacity', 0, 1, 0.005, 'smoke opacity');
    R(air, c, 'smokeRise', -3, 4, 0.01, 'smoke buoyancy');
    R(air, c, 'smokeTurbulence', 0, 3, 0.01, 'smoke swirl');
    R(air, c, 'emberRate', 0, 900, 1, 'ember rate');
    R(air, c, 'emberSize', 0.005, 0.4, 0.005, 'ember size');
    R(air, c, 'emberSpeed', 0, 20, 0.1, 'ember speed');
    R(air, c, 'emberLifetime', 0.1, 8, 0.05, 'ember lifetime');
    R(air, c, 'emberRise', -3, 8, 0.01, 'ember buoyancy');
    R(air, c, 'emberTurbulence', 0, 3, 0.01, 'ember swirl');
    R(air, c, 'emberStretch', 0, 2, 0.01, 'ember streaking');
    R(air, c, 'emberGlow', 0, 4, 0.01, 'ember glow');
    R(air, c, 'breachEmbers', 0, 40, 1, 'embers on breach');
    R(air, c, 'gutterEmbers', 0, 40, 1, 'embers on burn-down');
    R(air, c, 'updraftRate', 0, 600, 1, 'updraft rate');
    R(air, c, 'updraftSize', 0.005, 0.4, 0.005, 'updraft size');
    R(air, c, 'updraftSpeed', 0, 10, 0.05, 'initial push');
    R(air, c, 'updraftLifetime', 0.2, 10, 0.05, 'updraft lifetime');
    R(air, c, 'updraftLift', -2, 12, 0.05, 'updraft buoyancy');
    R(air, c, 'updraftSwirl', -6, 6, 0.01, 'column spin');
    R(air, c, 'updraftExpand', 0, 3, 0.01, 'spiral opening');
    R(air, c, 'updraftGlow', 0, 4, 0.01, 'updraft glow');
    R(air, c, 'updraftInset', 0.05, 1.4, 0.01, 'rise inset, × footprint');
    Editor.gradient(air, c, 'colorSmoke', 'Smoke colour');
    Editor.gradient(air, c, 'colorEmber', 'Ember colour');
    Editor.gradient(air, c, 'colorUpdraft', 'Updraft colour');

    const chips = folder.addFolder('Cinders');
    R(chips, c, 'cinderSize', 0.005, 0.5, 0.005, 'cinder size');
    R(chips, c, 'cinderSpeed', 0, 30, 0.1, 'cinder speed');
    R(chips, c, 'cinderLifetime', 0.1, 6, 0.05, 'cinder lifetime');
    R(chips, c, 'cinderGravity', -50, 0, 0.1, 'cinder gravity');
    R(chips, c, 'breachCinders', 0, 30, 1, 'cinders on breach');
    R(chips, c, 'gutterCinders', 0, 30, 1, 'cinders on burn-down');
    Editor.gradient(chips, c, 'colorCinder', 'Cinder colour');

    const impact = folder.addFolder('Bloom & blaze');
    R(impact, c, 'burstCinders', 0, 600, 1, 'bloom cinders');
    R(impact, c, 'burstSmoke', 0, 400, 1, 'bloom smoke');
    R(impact, c, 'burstEmbers', 0, 600, 1, 'bloom embers');
    R(impact, c, 'impactShake', 0, 3, 0.01, 'shake');
    R(impact, c, 'shakeDuration', 0.1, 4, 0.01, 'shake duration');
    R(impact, c, 'holdShake', 0, 0.5, 0.005, 'blaze rumble');
    R(impact, c, 'impactFlash', 0, 2, 0.01, 'screen flash');
    R(impact, c, 'rumble', 0, 0.5, 0.005, 'travel rumble');
    impact.addColor(c, 'colorFlash').name('bloom flash colour');

    const light = folder.addFolder('Dynamic light');
    R(light, c, 'lightIntensity', 0, 120, 0.5, 'light intensity');
    R(light, c, 'lightRadius', 0.5, 50, 0.1, 'light radius');
    R(light, c, 'lightHeight', 0, 1, 0.01, 'height up the crown');
    light.addColor(c, 'lightColor').name('light colour');

    this.pyreFolder = folder;
  }

  /* ------------------------------------------------------------------ */

  /**
   * The Kraken Crown. The only ability folder in this file whose most important
   * group is a *timing* group.
   *
   * Everything else here is tuned by looking at a paused frame; this one has to
   * be tuned by watching, because the ability is a beat. **The beat** is where
   * it is made — `smashPeriod` and `cycleScatter` decide whether the ring reads
   * as rolling thunder or as a drum machine, and `strikeTime` is the whip
   * itself, which wants to stay short. **The poses** is the other half: four
   * numbers per pose, all of them radians of total turn, positive inward over
   * the middle and negative out over the floor. Drag `strikeTurn` off π and the
   * arms stop landing in the centre — under it they punch short with their
   * points still up, over it they drive past and hammer with the back of the
   * curl, and both are worth seeing before it goes back.
   *
   * The one control that is not what it looks like is `reach`: it is not a
   * length, it is a multiplier on the length that lands an arm's point on the
   * exact middle of the footprint, whatever the footprint is.
   */
  _buildKraken() {
    const folder = this.gui.addFolder('🐙  Kraken Crown');
    const c = settings.kraken;
    const R = Editor.range;

    const cast = folder.addFolder('The cast');
    R(cast, c, 'zoneRadius', 0.5, 14, 0.05, 'footprint radius');
    R(cast, c, 'range', 2, 50, 0.1, 'max range');
    R(cast, c, 'minRange', 0, 10, 0.1, 'min range');
    R(cast, c, 'speed', 5, 200, 1, 'surge speed');
    R(cast, c, 'openTime', 0.02, 1.5, 0.01, 'rift tear time');
    R(cast, c, 'lifetime', 1, 16, 0.05, 'how long they hammer');
    R(cast, c, 'withdrawDelay', 0, 4, 0.01, 'delay before withdrawal');
    R(cast, c, 'withdrawTime', 0.05, 4, 0.01, 'withdrawal time');
    R(cast, c, 'withdrawStagger', 0, 3, 0.01, 'withdrawal stagger');
    R(cast, c, 'withdrawSink', 0, 4, 0.05, 'how far it sinks going under');
    R(cast, c, 'cooldown', 0, 8, 0.05, 'cooldown');
    Editor.castAnimation(cast, c);

    const hand = folder.addFolder('Where the cast leaves the hand');
    R(hand, c, 'handHeight', 0, 3, 0.01, 'hand height');
    R(hand, c, 'handForward', -1, 3, 0.01, 'hand forward');
    R(hand, c, 'handSide', -1.5, 1.5, 0.01, 'hand lateral');
    R(hand, c, 'castFlash', 0, 2, 0.01, 'flash on release');
    hand.addColor(c, 'colorCastFlash').name('release flash colour');

    const fill = folder.addFolder('Filling the ring');
    R(fill, c, 'armCount', 1, 20, 1, 'heavy arms');
    R(fill, c, 'whipCount', 0, 20, 1, 'thin whips');
    R(fill, c, 'density', 0.1, 2, 0.01, 'density');
    R(fill, c, 'ringSeat', 0.2, 1.4, 0.01, 'arm seat, × footprint');
    R(fill, c, 'ringScatter', 0, 0.6, 0.005, 'arm seat jitter');
    R(fill, c, 'whipSeat', 0.2, 1.6, 0.01, 'whip seat, × footprint');
    R(fill, c, 'whipScatter', 0, 0.6, 0.005, 'whip seat jitter');

    const arm = folder.addFolder('The arm');
    R(arm, c, 'reach', 0.3, 1.8, 0.01, 'reach (1 = dead centre)');
    R(arm, c, 'lengthJitter', 0, 1, 0.01, 'length jitter');
    R(arm, c, 'thickness', 0.05, 1.2, 0.01, 'base radius');
    R(arm, c, 'thicknessJitter', 0, 1, 0.01, 'thickness jitter');
    R(arm, c, 'whipLength', 0.1, 1.5, 0.01, 'whip length, × an arm');
    R(arm, c, 'whipThickness', 0.05, 1.5, 0.01, 'whip thickness, × an arm');
    R(arm, c, 'splay', 0, 1.4, 0.01, 'aim off the radius, ±');
    R(arm, c, 'rings', 8, 80, 1, 'rings (bend resolution)');
    R(arm, c, 'sides', 5, 24, 1, 'sides');
    R(arm, c, 'taper', 0.005, 0.5, 0.005, 'tip taper');
    R(arm, c, 'swell', 0.5, 2.5, 0.01, 'muscle swell');
    R(arm, c, 'swellAt', 0.02, 0.95, 0.01, 'where it is thickest');
    R(arm, c, 'armRoughness', 0, 1, 0.01, 'muscle segmentation');
    R(arm, c, 'flatten', 0.35, 1.4, 0.01, 'cross-section flattening');

    const pose = folder.addFolder('The poses');
    R(pose, c, 'coilLean', -2, 2, 0.01, 'coil lean');
    R(pose, c, 'coilCurl', 0, 10, 0.05, 'coil curl');
    R(pose, c, 'idleLean', -3, 3, 0.01, 'idle lean');
    R(pose, c, 'idleCurl', -3, 6, 0.01, 'idle curl');
    R(pose, c, 'rearLean', -3, 3, 0.01, 'rear lean');
    R(pose, c, 'rearCurl', -3, 8, 0.01, 'rear curl');
    R(pose, c, 'strikeTurn', 1.2, 5, 0.01, 'strike turn (π lands centre)');
    R(pose, c, 'turnJitter', 0, 0.6, 0.005, 'turn jitter');
    R(pose, c, 'strikeSquash', 0, 1.5, 0.01, 'thickening on the whip');
    R(pose, c, 'settle', 0, 1, 0.01, 'ring-out after landing');
    R(pose, c, 'settleSpeed', 2, 60, 0.5, 'ring-out speed');
    R(pose, c, 'twist', -3, 3, 0.01, 'roll from rift to point');

    const wave = folder.addFolder('The travelling wave');
    R(wave, c, 'waveIdle', 0, 2, 0.01, 'amplitude at rest');
    R(wave, c, 'waveRear', 0, 2, 0.01, '... while cocked');
    R(wave, c, 'waveStrike', 0, 2, 0.01, '... during the whip');
    R(wave, c, 'waveCoil', 0, 2, 0.01, '... while coming out');
    R(wave, c, 'waveFreq', 0.1, 5, 0.01, 'waves along the arm');
    R(wave, c, 'waveSpeed', -3, 3, 0.01, 'travel speed');

    const beat = folder.addFolder('The beat');
    R(beat, c, 'riseTime', 0.05, 3, 0.01, 'rise out of the rift');
    R(beat, c, 'sweepTime', 0, 3, 0.01, 'sweep around the ring');
    R(beat, c, 'stagger', 0, 1, 0.005, 'random stagger');
    R(beat, c, 'whipDelay', 0, 2, 0.01, 'whip delay');
    R(beat, c, 'smashPeriod', 0.25, 6, 0.01, 'seconds between strikes');
    R(beat, c, 'whipPeriod', 0.1, 2, 0.01, '× that, for the whips');
    R(beat, c, 'cycleScatter', 0, 1, 0.01, 'scatter around the ring');
    R(beat, c, 'rearTime', 0.05, 2, 0.01, 'wind-up');
    R(beat, c, 'strikeTime', 0.02, 1, 0.005, 'the whip itself');
    R(beat, c, 'holdTime', 0.02, 2, 0.01, 'pressed on the floor');
    R(beat, c, 'peelTime', 0.05, 2, 0.01, 'peel back off');
    R(beat, c, 'finaleLead', 0, 4, 0.01, 'finale, seconds before the end');

    const flesh = folder.addFolder('The flesh');
    R(flesh, c, 'opacity', 0, 1, 0.01, 'opacity');
    R(flesh, c, 'mottle', 0, 1.5, 0.01, 'mottling');
    R(flesh, c, 'mottleScale', 0.2, 12, 0.05, 'blotches along the arm');
    R(flesh, c, 'mottleWarp', 0, 2, 0.01, 'domain warp');
    R(flesh, c, 'bellyBlend', 0, 1.5, 0.01, 'pale underside');
    R(flesh, c, 'depthShade', 0, 1, 0.01, 'darkening at the rift');
    R(flesh, c, 'specular', 0, 6, 0.01, 'wet highlight');
    R(flesh, c, 'gloss', 4, 160, 1, 'highlight tightness');
    R(flesh, c, 'envIntensity', 0, 3, 0.01, 'env reflection');
    R(flesh, c, 'rim', 0, 3, 0.01, 'silhouette fresnel');
    R(flesh, c, 'rimPower', 0.5, 8, 0.01, 'fresnel tightness');
    R(flesh, c, 'translucency', 0, 3, 0.01, 'light through the tip');
    R(flesh, c, 'glow', 0, 4, 0.01, 'glow');
    flesh.addColor(c, 'colorSkin').name('skin');
    flesh.addColor(c, 'colorSkinDeep').name('skin (dark)');
    flesh.addColor(c, 'colorBelly').name('underside');
    flesh.addColor(c, 'colorFlush').name('chromatophore flush');
    flesh.addColor(c, 'colorRim').name('silhouette');

    const chroma = folder.addFolder('Chromatophores & biolume');
    R(chroma, c, 'chroma', 0, 2, 0.01, 'colour bands');
    R(chroma, c, 'chromaScale', 0.2, 10, 0.05, 'bands along the arm');
    R(chroma, c, 'chromaSpeed', -3, 3, 0.01, 'band travel speed');
    R(chroma, c, 'chromaSharp', 0.5, 12, 0.05, 'band sharpness');
    R(chroma, c, 'chromaWarp', 0, 3, 0.01, 'band break-up');
    R(chroma, c, 'biolume', 0, 3, 0.01, 'bioluminescence');
    R(chroma, c, 'biolumeScale', 0.2, 10, 0.05, 'veins along the arm');
    R(chroma, c, 'biolumeSpeed', -4, 4, 0.01, 'vein crawl');
    R(chroma, c, 'biolumePulse', 0, 1, 0.01, 'breathing');
    R(chroma, c, 'strikeFlash', 0, 6, 0.05, 'flood on landing');
    chroma.addColor(c, 'colorBiolume').name('biolume');

    const suckers = folder.addFolder('Suckers');
    R(suckers, c, 'suckers', 0, 2, 0.01, 'strength (0 hides them)');
    R(suckers, c, 'suckerDensity', 4, 90, 1, 'cups along the arm');
    R(suckers, c, 'suckerSize', 0.1, 1, 0.01, 'cup size');
    R(suckers, c, 'suckerSpan', 0.1, 2, 0.01, 'span around the arm, ±');
    R(suckers, c, 'suckerRows', 0.1, 1.2, 0.01, 'row spacing');
    R(suckers, c, 'suckerRelief', 0, 1.5, 0.01, 'cup depth');
    R(suckers, c, 'suckerGlow', 0, 4, 0.01, 'rim glow');
    R(suckers, c, 'suckerStart', 0, 0.5, 0.005, 'where the rows begin');
    suckers.addColor(c, 'colorSucker').name('cup rims');

    const emerge = folder.addFolder('Coming out of the rift');
    R(emerge, c, 'frontRough', 0, 1.5, 0.01, 'leading edge raggedness');
    R(emerge, c, 'frontWidth', 0.01, 0.8, 0.01, 'lit edge width');
    R(emerge, c, 'frontGlow', 0, 8, 0.05, 'edge glow');
    R(emerge, c, 'breachSpray', 0, 80, 1, 'spray on breach');
    R(emerge, c, 'breachInk', 0, 40, 1, 'ink on breach');
    R(emerge, c, 'breachDebris', 0, 40, 1, 'stone on breach');

    const smash = folder.addFolder('The smash');
    R(smash, c, 'smashShock', 0, 3, 0.01, 'shock ring, × footprint');
    R(smash, c, 'smashDust', 0, 3, 0.01, 'dust ring, × footprint');
    R(smash, c, 'smashDebris', 0, 200, 1, 'stone thrown');
    R(smash, c, 'smashSpray', 0, 300, 1, 'water thrown');
    R(smash, c, 'smashInk', 0, 100, 1, 'ink thrown');
    R(smash, c, 'smashShake', 0, 3, 0.01, 'shake per landing');
    R(smash, c, 'smashShakeDecay', 0.05, 3, 0.01, 'shake decay');
    R(smash, c, 'whipPower', 0, 1.5, 0.01, 'a whip landing, × an arm');
    R(smash, c, 'finalePower', 0.5, 4, 0.01, 'the finale, × an arm');
    R(smash, c, 'finaleFlash', 0, 2, 0.01, 'finale screen flash');
    R(smash, c, 'finaleShock', 0, 30, 0.1, 'finale ring, metres');

    const field = folder.addFolder('The rift');
    R(field, c, 'fieldBoundary', 0.02, 2, 0.01, 'band thickness');
    R(field, c, 'fieldBoundaryGlow', 0, 8, 0.05, 'band glow');
    R(field, c, 'fieldFill', 0, 2, 0.01, 'interior fill');
    R(field, c, 'fieldFalloff', 0.1, 5, 0.05, 'fill falloff');
    R(field, c, 'fieldPlates', 0, 3, 0.01, 'flagstone break-up');
    R(field, c, 'fieldCrackScale', 0.2, 10, 0.05, 'plates / metre');
    R(field, c, 'fieldCrackWidth', 0.02, 1, 0.01, 'seam width');
    R(field, c, 'fieldCracks', 0, 4, 0.01, 'lit seams');
    R(field, c, 'fieldSpiral', 0, 3, 0.01, 'the maelstrom');
    R(field, c, 'fieldSpiralArms', 1, 8, 1, 'spiral arms');
    R(field, c, 'fieldSpiralTwist', 0, 4, 0.01, 'how tightly it winds');
    R(field, c, 'fieldSpin', -2, 2, 0.005, 'rotation');
    R(field, c, 'fieldWarp', 0, 2, 0.01, 'domain warp');
    R(field, c, 'fieldCrawl', -4, 4, 0.01, 'spark drift');
    R(field, c, 'fieldSparks', 0, 4, 0.01, 'sparks in the water');
    R(field, c, 'fieldSparkScale', 0.5, 20, 0.1, 'sparks / metre');
    R(field, c, 'fieldRings', 0, 12, 0.1, 'swell rings');
    R(field, c, 'fieldRingSpeed', -6, 6, 0.01, 'ring speed');
    R(field, c, 'fieldGlyphRing', 0, 3, 0.01, 'summoning ring');
    R(field, c, 'fieldGlyphSeat', 0.1, 1.2, 0.01, 'its seat, × footprint');
    R(field, c, 'fieldGlyphTicks', 3, 48, 1, 'marks around it');
    R(field, c, 'fieldThroat', 0, 4, 0.01, 'the throat');
    R(field, c, 'fieldThroatSize', 0.02, 1, 0.005, 'throat size, × footprint');
    R(field, c, 'fieldPulse', 0, 1, 0.01, 'pulse');
    R(field, c, 'fieldPulseSpeed', 0, 10, 0.05, 'pulse speed');
    R(field, c, 'fieldOpacity', 0, 2, 0.01, 'opacity');
    R(field, c, 'fieldHeight', 0.005, 0.4, 0.005, 'hover height');
    field.addColor(c, 'colorField').name('water & spiral');
    field.addColor(c, 'colorFieldEdge').name('band & throat');

    const veil = folder.addFolder('The curtain of spray');
    R(veil, c, 'veil', 0, 2, 0.01, 'opacity (0 hides it)');
    R(veil, c, 'veilHeight', 0.1, 8, 0.05, 'height');
    R(veil, c, 'veilRadius', 0.5, 1.6, 0.005, 'seat, × footprint');
    R(veil, c, 'veilLean', -0.8, 1.2, 0.01, 'lean (negative closes it over)');
    R(veil, c, 'veilBillow', 0, 1.5, 0.01, 'silhouette lobes');
    R(veil, c, 'veilScale', 0.1, 6, 0.05, 'noise / metre');
    R(veil, c, 'veilStretch', 0.05, 3, 0.01, 'vertical stretch');
    R(veil, c, 'veilFlow', -4, 4, 0.01, 'settling speed');
    R(veil, c, 'veilSwirl', -2, 2, 0.01, 'drag around the ring');
    R(veil, c, 'veilErode', 0, 1, 0.01, 'erosion with height');
    R(veil, c, 'veilFalloff', 0.2, 6, 0.05, 'thinning with height');
    R(veil, c, 'veilSpin', -1, 1, 0.005, 'rotation');
    R(veil, c, 'veilSoftFade', 0.02, 4, 0.01, 'soft intersection');
    R(veil, c, 'veilGlint', 0, 4, 0.01, 'droplet glints');
    veil.addColor(c, 'colorVeil').name('body');
    veil.addColor(c, 'colorVeilFoam').name('foam (where it tears)');
    veil.addColor(c, 'colorVeilInk').name('ink (at the floor)');

    const ground = folder.addFolder('Wet stone & fractures');
    R(ground, c, 'trailSlickRate', 0.05, 10, 0.05, 'trail slick / metre');
    R(ground, c, 'trailSlickRadius', 0.05, 6, 0.05, 'trail slick radius');
    R(ground, c, 'slickSpread', 0.2, 4, 0.05, 'drowned sheet, × footprint');
    R(ground, c, 'slickLife', 0.5, 20, 0.1, 'slick lifetime');
    R(ground, c, 'slickIntensity', 0, 2, 0.01, 'slick intensity');
    R(ground, c, 'slickRate', 0, 20, 0.1, 'rim slick / sec');
    R(ground, c, 'slickRadius', 0.05, 6, 0.05, 'rim slick radius');
    R(ground, c, 'rippleRate', 0, 12, 0.1, 'swell rings / sec');
    R(ground, c, 'tearShock', 0.5, 25, 0.1, 'tear shockwave radius');
    ground.addColor(c, 'colorSlick').name('wet stone');
    ground.addColor(c, 'colorFoam').name('foam');
    ground.addColor(c, 'colorDrowned').name('drowned sheet');
    ground.addColor(c, 'colorShockA').name('shockwave ring');
    ground.addColor(c, 'colorShockB').name('shockwave crest');
    ground.addColor(c, 'colorRippleA').name('swell ring');
    ground.addColor(c, 'colorRippleB').name('swell crest');
    ground.addColor(c, 'colorDust').name('dust');

    const water = folder.addFolder('Ink, spray & marine snow');
    R(water, c, 'inkRate', 0, 900, 1, 'ink rate');
    R(water, c, 'inkSize', 0.05, 4, 0.01, 'ink size');
    R(water, c, 'inkSpeed', 0, 10, 0.05, 'ink speed');
    R(water, c, 'inkLifetime', 0.2, 8, 0.05, 'ink lifetime');
    R(water, c, 'inkOpacity', 0, 1, 0.005, 'ink opacity');
    R(water, c, 'inkRise', -3, 4, 0.01, 'ink buoyancy');
    R(water, c, 'inkTurbulence', 0, 3, 0.01, 'ink swirl');
    R(water, c, 'sprayRate', 0, 900, 1, 'spray rate');
    R(water, c, 'spraySize', 0.005, 0.4, 0.005, 'spray size');
    R(water, c, 'sprayFxSpeed', 0, 20, 0.1, 'spray speed');
    R(water, c, 'sprayLifetime', 0.1, 8, 0.05, 'spray lifetime');
    R(water, c, 'sprayGravity', -40, 0, 0.1, 'spray gravity');
    R(water, c, 'sprayOpacity', 0, 1, 0.01, 'spray opacity');
    R(water, c, 'sprayTurbulence', 0, 3, 0.01, 'spray swirl');
    R(water, c, 'moteRate', 0, 600, 1, 'marine snow rate');
    R(water, c, 'moteSize', 0.005, 0.4, 0.005, 'mote size');
    R(water, c, 'moteSpeed', 0, 10, 0.05, 'initial push');
    R(water, c, 'moteLifetime', 0.2, 12, 0.05, 'mote lifetime');
    R(water, c, 'moteDrift', -2, 3, 0.01, 'mote buoyancy');
    R(water, c, 'moteSwirl', -6, 6, 0.01, 'turn about the throat');
    R(water, c, 'moteExpand', 0, 3, 0.01, 'spiral opening');
    R(water, c, 'moteTurbulence', 0, 3, 0.01, 'mote swirl');
    R(water, c, 'moteGlow', 0, 4, 0.01, 'mote glow');
    R(water, c, 'moteInset', 0.05, 1.4, 0.01, 'rise inset, × footprint');
    R(water, c, 'moteSeat', 0.1, 8, 0.05, 'release height');
    Editor.gradient(water, c, 'colorInk', 'Ink colour');
    Editor.gradient(water, c, 'colorSpray', 'Spray colour');
    Editor.gradient(water, c, 'colorMote', 'Marine snow colour');

    const chips = folder.addFolder('Broken floor');
    R(chips, c, 'debrisSize', 0.005, 0.5, 0.005, 'chip size');
    R(chips, c, 'debrisSpeed', 0, 30, 0.1, 'chip speed');
    R(chips, c, 'debrisLifetime', 0.1, 6, 0.05, 'chip lifetime');
    R(chips, c, 'debrisGravity', -50, 0, 0.1, 'chip gravity');
    Editor.gradient(chips, c, 'colorDebris', 'Chip colour');

    const impact = folder.addFolder('The tear & the standing crown');
    R(impact, c, 'tearSpray', 0, 600, 1, 'tear spray');
    R(impact, c, 'tearInk', 0, 400, 1, 'tear ink');
    R(impact, c, 'tearDebris', 0, 400, 1, 'tear stone');
    R(impact, c, 'tearShake', 0, 3, 0.01, 'tear shake');
    R(impact, c, 'shakeDuration', 0.1, 4, 0.01, 'shake duration');
    R(impact, c, 'tearFlash', 0, 2, 0.01, 'tear screen flash');
    R(impact, c, 'holdShake', 0, 0.5, 0.005, 'standing rumble');
    R(impact, c, 'rumble', 0, 0.5, 0.005, 'travel rumble');
    impact.addColor(c, 'colorFlash').name('tear flash colour');

    const light = folder.addFolder('Dynamic light');
    R(light, c, 'lightIntensity', 0, 120, 0.5, 'light intensity');
    R(light, c, 'lightRadius', 0.5, 50, 0.1, 'light radius');
    R(light, c, 'lightHeight', 0, 6, 0.05, 'height above the floor');
    light.addColor(c, 'lightColor').name('light colour');

    this.krakenFolder = folder;
  }

  /* ------------------------------------------------------------------ */

  /**
   * Electrical Sphere.
   *
   * The fifth far cast: a dark charged orb dropped at the aimed point. The
   * whole thing is three GPU shaders — the sphere body, the ground platform,
   * and the radial corona of bolts — and every one of them is read by the
   * editor live, so dragging a slider reshapes a sphere that is already
   * standing, with the clock stopped.
   *
   * The folder worth reaching for first is **Reflective shell**: it is what
   * decides whether the ball reads as polished chrome or as a ball of smoke
   * (`reflectivity`, `fresnelPower`, `specular`, `envRoughness`), and the two
   * colours at the bottom of it are what keep the body near black. After that,
   * **Surface discharge** is the flat electricity crawling on the skin
   * (`surfaceArcWidth` and `surfaceArcCharge` are the two that decide whether
   * it reads as hairlines or as a rash), **Fresnel light** is the entire
   * silhouette read now that the corona shell is gone, and the **radial
   * corona** is the arcs leaving the ball (`arcCount`, `arcLength`,
   * `arcJitterAmp` and `arcBranchFraction` decide how chaotic it reads). The
   * **pulse** controls the breathing rhythm — `pulseFrequency` is the heart
   * rate.
   */
  _buildElectrical() {
    const folder = this.gui.addFolder('🔮  Electrical Sphere');
    const c = settings.electrical;
    const R = Editor.range;

    const cast = folder.addFolder('The cast');
    R(cast, c, 'range', 2, 60, 0.1, 'max range');
    R(cast, c, 'minRange', 0, 10, 0.1, 'min range');
    R(cast, c, 'zoneRadius', 1.5, 12, 0.1, 'platform radius');
    R(cast, c, 'speed', 5, 200, 1, 'travel speed');
    R(cast, c, 'snapTime', 0.05, 2, 0.01, 'bloom time');
    R(cast, c, 'lifetime', 0.5, 12, 0.1, 'hold time');
    R(cast, c, 'collapseTime', 0.05, 3, 0.05, 'collapse time');
    R(cast, c, 'fadeTime', 0.05, 3, 0.05, 'fade out time');
    R(cast, c, 'cooldown', 0, 8, 0.05, 'cooldown');
    Editor.castAnimation(cast, c);

    const anchor = folder.addFolder('Where it leaves the hand');
    R(anchor, c, 'handHeight', 0, 3, 0.01, 'hand height');
    R(anchor, c, 'handForward', -1, 3, 0.01, 'hand forward');
    R(anchor, c, 'handSide', -1.5, 1.5, 0.01, 'hand lateral');

    const sphere = folder.addFolder('The sphere');
    R(sphere, c, 'sphereRadius', 0.3, 5, 0.05, 'radius');
    R(sphere, c, 'hoverHeight', 0.4, 5, 0.05, 'hover height');
    R(sphere, c, 'hoverAmplitude', 0, 0.3, 0.005, 'hover amplitude');
    R(sphere, c, 'hoverSpeed', 0, 4, 0.05, 'hover speed');
    R(sphere, c, 'distortion', 0, 1, 0.01, 'reflection ripple');
    R(sphere, c, 'opacity', 0, 1, 0.01, 'body opacity');
    R(sphere, c, 'glow', 0, 8, 0.05, 'emissive gain');

    // The folder that decides whether the ball reads as chrome or as smoke.
    // `reflectivity` is the head-on mirror, `fresnelPower` how fast it climbs
    // to a full mirror at the silhouette, `specular` the hard key glint.
    const shell = folder.addFolder('Reflective shell');
    R(shell, c, 'envIntensity', 0, 4, 0.01, 'room brightness');
    R(shell, c, 'envRoughness', 0, 1, 0.005, 'reflection blur');
    R(shell, c, 'reflectivity', 0, 1, 0.01, 'head-on mirror');
    R(shell, c, 'fresnelPower', 0.5, 8, 0.05, 'limb falloff');
    R(shell, c, 'specular', 0, 10, 0.05, 'key glint');
    R(shell, c, 'specSharp', 8, 600, 1, 'glint tightness');
    R(shell, c, 'shellDiffuse', 0, 2, 0.01, 'skin lighting');
    R(shell, c, 'shellRipple', 0.2, 12, 0.05, 'ripple scale');
    shell.addColor(c, 'colorShell').name('lit skin');
    shell.addColor(c, 'colorDeep').name('unlit skin');

    const plasma = folder.addFolder('Charge under the skin');
    R(plasma, c, 'plasmaScale', 0.5, 12, 0.05, 'charge scale');
    R(plasma, c, 'plasmaSpeed', 0, 4, 0.01, 'charge speed');
    R(plasma, c, 'plasmaIntensity', 0, 4, 0.01, 'charge brightness');
    R(plasma, c, 'plasmaCore', 0.2, 6, 0.05, 'core concentration');
    R(plasma, c, 'plasmaWarp', 0, 2, 0.01, 'domain warp');

    const hex = folder.addFolder('Hex panelling (off by default)');
    R(hex, c, 'hexScale', 0.5, 20, 0.1, 'panels / radius');
    R(hex, c, 'hexWidth', 0.02, 0.6, 0.005, 'panel edge width');
    R(hex, c, 'hexIntensity', 0, 3, 0.01, 'panel brightness');
    R(hex, c, 'hexPulse', 0, 2, 0.01, 'pulse-on-beat lift');

    // The flat electricity on the black skin. `filament width` is the one to
    // pull first: past about 0.15 the hairlines fatten into a rash and the
    // ball stops reading as dark.
    const arcs = folder.addFolder('Surface discharge');
    R(arcs, c, 'surfaceArcScale', 0.5, 16, 0.1, 'filaments / radius');
    R(arcs, c, 'surfaceArcSpeed', 0, 4, 0.01, 'net evolution');
    R(arcs, c, 'surfaceArcCrawl', -4, 4, 0.05, 'net crawl');
    R(arcs, c, 'surfaceArcWidth', 0.01, 0.4, 0.005, 'filament width');
    R(arcs, c, 'surfaceArcGlowWidth', 0, 0.6, 0.005, 'glow width');
    R(arcs, c, 'surfaceArcIntensity', 0, 5, 0.01, 'discharge brightness');
    R(arcs, c, 'surfaceArcFlicker', 0, 1, 0.01, 'stutter depth');
    R(arcs, c, 'surfaceArcRestrike', 0.5, 30, 0.5, 'restrikes / sec');
    R(arcs, c, 'surfaceArcWarp', 0, 2, 0.01, 'fork / buckle');
    R(arcs, c, 'surfaceArcCharge', 0, 1, 0.01, 'live-patch mask');
    arcs.addColor(c, 'colorSurfaceArcCore').name('filament core');
    arcs.addColor(c, 'colorSurfaceArcGlow').name('filament glow');

    // With the corona shell gone this is the whole silhouette read.
    const rim = folder.addFolder('Fresnel light');
    R(rim, c, 'fresnelGlow', 0, 6, 0.01, 'halo brightness');
    R(rim, c, 'fresnelGlowPower', 0.5, 10, 0.05, 'halo falloff');
    R(rim, c, 'rimPower', 0.5, 8, 0.05, 'rim sharpness');
    R(rim, c, 'rimIntensity', 0, 6, 0.01, 'rim brightness');
    R(rim, c, 'rimWidth', 0.1, 1.5, 0.01, 'rim band width');

    const platform = folder.addFolder('Ground platform');
    R(platform, c, 'platformRadius', 1.5, 16, 0.1, 'platform radius');
    R(platform, c, 'platformRings', 0, 16, 1, 'concentric rings');
    R(platform, c, 'platformRingWidth', 0.01, 0.5, 0.005, 'ring width');
    R(platform, c, 'platformRingGlow', 0, 4, 0.01, 'ring glow');
    R(platform, c, 'platformInnerGlow', 0, 4, 0.01, 'inner band glow');
    R(platform, c, 'platformInnerPad', 0, 4, 0.05, 'inner band reach');
    R(platform, c, 'platformHexScale', 0.5, 16, 0.1, 'hex grain');
    R(platform, c, 'platformHexIntensity', 0, 2, 0.01, 'hex intensity');
    R(platform, c, 'platformOpacity', 0, 2, 0.01, 'platform opacity');
    R(platform, c, 'platformGlow', 0, 4, 0.01, 'platform glow');

    const corona = folder.addFolder('Radial corona');
    R(corona, c, 'arcCount', 0, 80, 1, 'strands');
    R(corona, c, 'arcLength', 0.4, 8, 0.05, 'arc length');
    R(corona, c, 'arcVariance', 0, 1, 0.01, 'length variance');
    R(corona, c, 'arcJitter', 0, 1, 0.01, 'lateral wander');
    R(corona, c, 'arcEscape', 0.95, 1.4, 0.005, 'surface offset');
    R(corona, c, 'arcCurl', 0, 1.5, 0.01, 'in-flight bend');
    R(corona, c, 'arcUpBias', -0.5, 1, 0.01, 'vertical bias');
    R(corona, c, 'arcBranchFraction', 0, 0.9, 0.01, 'short arc share');

    const arcShape = folder.addFolder('Corona: per-arc shape');
    R(arcShape, c, 'arcJitterAmp', 0, 1, 0.01, 'kink amplitude');
    R(arcShape, c, 'arcJitterFreq', 0.2, 16, 0.1, 'kinks / metre');
    R(arcShape, c, 'arcOctaves', 1, 5, 1, 'octaves');
    R(arcShape, c, 'arcJitterFalloff', 0.1, 0.95, 0.01, 'octave falloff');
    R(arcShape, c, 'arcCrawl', -20, 20, 0.1, 'kink crawl');
    R(arcShape, c, 'arcPinch', 0.01, 0.5, 0.005, 'end pinch');
    R(arcShape, c, 'arcBow', 0, 1, 0.01, 'mid-span bow');

    const arcRibbon = folder.addFolder('Corona: the ribbon');
    R(arcRibbon, c, 'arcWidth', 0.005, 0.6, 0.005, 'width at the surface');
    R(arcRibbon, c, 'arcWidthTip', 0.0, 2, 0.01, 'width at tip');
    R(arcRibbon, c, 'arcCoreWidth', 0.5, 5, 0.05, 'spine multiplier');
    R(arcRibbon, c, 'arcCoreSharp', 0.5, 12, 0.05, 'core sharpness');
    R(arcRibbon, c, 'arcGlowFalloff', 0.2, 8, 0.05, 'halo falloff');
    R(arcRibbon, c, 'arcHaloWidth', 1, 30, 0.1, 'halo width');
    R(arcRibbon, c, 'arcHaloOpacity', 0, 2, 0.01, 'halo opacity');
    R(arcRibbon, c, 'arcOpacity', 0, 2, 0.01, 'core opacity');
    R(arcRibbon, c, 'arcGlow', 0, 6, 0.01, 'arc glow');
    R(arcRibbon, c, 'arcSoftFade', 0.02, 3, 0.01, 'soft intersection');
    R(arcRibbon, c, 'arcFlicker', 0, 1, 0.01, 'arc stutter');
    R(arcRibbon, c, 'arcFlickerSpeed', 1, 120, 1, 'stutter rate');
    R(arcRibbon, c, 'arcStrandFlash', 0, 1, 0.01, 'strand blink');
    R(arcRibbon, c, 'arcRate', 0.5, 60, 0.5, 'cycles / sec');
    R(arcRibbon, c, 'arcLife', 0.05, 1, 0.01, 'lit fraction of cycle');

    const pulse = folder.addFolder('The pulse');
    R(pulse, c, 'pulseFrequency', 0.1, 8, 0.05, 'pulses / sec');
    R(pulse, c, 'pulseStrength', 0, 1, 0.01, 'pulse strength');
    R(pulse, c, 'pulseParticleBoost', 1, 4, 0.05, 'particle boost');

    const sphereColor = folder.addFolder('Sphere colours');
    sphereColor.addColor(c, 'colorCore').name('glint tint');
    sphereColor.addColor(c, 'colorInner').name('limb lift');
    sphereColor.addColor(c, 'colorMid').name('charge under skin');
    sphereColor.addColor(c, 'colorOuter').name('Fresnel halo');
    sphereColor.addColor(c, 'colorEdge').name('Fresnel rim');
    sphereColor.addColor(c, 'colorHex').name('hex panels');
    sphereColor.addColor(c, 'colorPulse').name('pulse flash');

    const arcColor = folder.addFolder('Corona colours');
    arcColor.addColor(c, 'colorArcCore').name('hot core');
    arcColor.addColor(c, 'colorArcInner').name('inner');
    arcColor.addColor(c, 'colorArcOuter').name('outer');
    arcColor.addColor(c, 'colorArcHalo').name('halo');

    const platformColor = folder.addFolder('Platform colours');
    platformColor.addColor(c, 'colorPlatformRing').name('rings');
    platformColor.addColor(c, 'colorPlatformInner').name('inner band');
    platformColor.addColor(c, 'colorPlatformHex').name('hex grain');
    platformColor.addColor(c, 'colorPlatformDeep').name('dark fill');

    const ground = folder.addFolder('Ground burns');
    R(ground, c, 'platformScorchRate', 0.05, 8, 0.05, 'burns / metre');
    R(ground, c, 'platformScorchRadius', 0.05, 4, 0.05, 'burn radius');
    R(ground, c, 'platformScorchLife', 0.5, 20, 0.1, 'burn lifetime');
    R(ground, c, 'platformScorchIntensity', 0, 2, 0.01, 'burn intensity');
    ground.addColor(c, 'colorScorch').name('scorch');
    ground.addColor(c, 'colorEmber').name('ember');

    const sparks = folder.addFolder('Sparks & motes');
    R(sparks, c, 'sparkRate', 0, 1500, 1, 'front spark rate');
    R(sparks, c, 'sparkSize', 0.005, 0.8, 0.005, 'spark size');
    R(sparks, c, 'sparkSpeed', 0, 40, 0.1, 'spark speed');
    R(sparks, c, 'sparkLifetime', 0.05, 4, 0.01, 'spark lifetime');
    R(sparks, c, 'sparkGravity', -50, 5, 0.1, 'spark gravity');
    R(sparks, c, 'sparkStretch', 0, 3, 0.01, 'spark stretch');
    R(sparks, c, 'sparkGlow', 0, 5, 0.01, 'spark glow');
    Editor.gradient(sparks, c, 'colorSpark', 'Spark colour');
    R(sparks, c, 'moteRate', 0, 800, 1, 'front mote rate');
    R(sparks, c, 'moteSize', 0.005, 0.4, 0.005, 'mote size');
    R(sparks, c, 'moteSpeed', 0, 12, 0.05, 'mote speed');
    R(sparks, c, 'moteLifetime', 0.1, 8, 0.05, 'mote lifetime');
    R(sparks, c, 'moteRise', -3, 8, 0.05, 'mote rise');
    R(sparks, c, 'moteTurbulence', 0, 3, 0.01, 'mote turbulence');
    Editor.gradient(sparks, c, 'colorMote', 'Mote colour');
    R(sparks, c, 'emberRate', 0, 600, 1, 'ember rate');
    R(sparks, c, 'emberSize', 0.005, 0.4, 0.005, 'ember size');
    R(sparks, c, 'emberSpeed', 0, 12, 0.05, 'ember speed');
    R(sparks, c, 'emberLifetime', 0.1, 8, 0.05, 'ember lifetime');
    R(sparks, c, 'emberRise', -3, 8, 0.05, 'ember rise');
    R(sparks, c, 'emberTurbulence', 0, 3, 0.01, 'ember turbulence');
    R(sparks, c, 'emberGlow', 0, 5, 0.01, 'ember glow');
    R(sparks, c, 'emberStretch', 0, 3, 0.01, 'ember stretch');
    Editor.gradient(sparks, c, 'colorEmber', 'Ember colour');

    const fieldFx = folder.addFolder('Sphere-shed particles');
    R(fieldFx, c, 'fieldSparkRate', 0, 1500, 1, 'surface spark rate');
    R(fieldFx, c, 'fieldSparkSpeed', 0, 20, 0.1, 'surface spark speed');
    R(fieldFx, c, 'fieldSparkLifetime', 0.05, 4, 0.01, 'surface spark life');
    R(fieldFx, c, 'fieldMoteRate', 0, 1000, 1, 'surface mote rate');
    R(fieldFx, c, 'fieldMoteSpeed', 0, 12, 0.05, 'surface mote speed');
    R(fieldFx, c, 'fieldMoteLifetime', 0.1, 8, 0.05, 'surface mote life');
    R(fieldFx, c, 'fieldEmberRate', 0, 800, 1, 'surface ember rate');
    R(fieldFx, c, 'fieldEmberSpeed', 0, 12, 0.05, 'surface ember speed');
    R(fieldFx, c, 'fieldEmberLifetime', 0.1, 8, 0.05, 'surface ember life');
    R(fieldFx, c, 'fieldSmokeRate', 0, 200, 1, 'platform smoke rate');
    R(fieldFx, c, 'fieldSmokeSpeed', 0, 8, 0.05, 'smoke speed');
    R(fieldFx, c, 'fieldSmokeLifetime', 0.2, 8, 0.05, 'smoke life');
    R(fieldFx, c, 'smokeSize', 0.05, 4, 0.01, 'smoke size');
    R(fieldFx, c, 'smokeSpeed', 0, 8, 0.05, 'smoke speed (global)');
    R(fieldFx, c, 'smokeLifetime', 0.2, 8, 0.05, 'smoke life (global)');
    R(fieldFx, c, 'smokeOpacity', 0, 1, 0.005, 'smoke opacity');
    R(fieldFx, c, 'smokeRise', -2, 4, 0.01, 'smoke rise');
    Editor.gradient(fieldFx, c, 'colorSmoke', 'Smoke colour');

    const impact = folder.addFolder('Muzzle & impact');
    R(impact, c, 'muzzleSize', 0.05, 6, 0.05, 'muzzle size');
    R(impact, c, 'muzzleIntensity', 0, 5, 0.01, 'muzzle intensity');
    impact.addColor(c, 'colorMuzzleA').name('muzzle shell');
    impact.addColor(c, 'colorMuzzleB').name('muzzle body');
    impact.addColor(c, 'colorMuzzleC').name('muzzle arcs');
    R(impact, c, 'castFlash', 0, 2, 0.01, 'flash on release');
    impact.addColor(c, 'colorCastFlash').name('release flash colour');
    R(impact, c, 'burstSparks', 0, 600, 1, 'burst sparks');
    R(impact, c, 'burstEmbers', 0, 300, 1, 'burst embers');
    R(impact, c, 'impactShake', 0, 3, 0.01, 'shake');
    R(impact, c, 'impactFlash', 0, 2, 0.01, 'screen flash');
    R(impact, c, 'shakeDuration', 0.1, 4, 0.01, 'shake duration');
    R(impact, c, 'rumble', 0, 0.5, 0.005, 'travel rumble');
    R(impact, c, 'holdShake', 0, 0.5, 0.005, 'hold rumble');
    R(impact, c, 'shockRadius', 0.5, 25, 0.1, 'shockwave radius');
    impact.addColor(c, 'colorShockA').name('shockwave ring');
    impact.addColor(c, 'colorShockB').name('shockwave crest');
    impact.addColor(c, 'colorFlash').name('screen flash colour');

    const light = folder.addFolder('Dynamic light');
    R(light, c, 'lightIntensity', 0, 120, 0.5, 'light intensity');
    R(light, c, 'lightRadius', 0.5, 50, 0.1, 'light radius');
    R(light, c, 'lightFlicker', 0, 1, 0.01, 'light gutter');
    R(light, c, 'lightFlickerSpeed', 1, 90, 1, 'gutter rate');
    light.addColor(c, 'lightColor').name('light colour');

    this.electricalFolder = folder;
  }

  /* ------------------------------------------------------------------ */

  /**
   * The earth ability.
   *
   * The first **line cast** in the set, aimed with the existing ground
   * arrow. The cast parameters (`range`, `minRange`, `speed`) sit at the top
   * of the folder, then the wave that runs along the line, the towers, and
   * the dust shed by both. Every control in the panel drives either the
   * crust, the boulder ring, the impact tower or the dust trail.
   */
  _buildEarth() {
    const folder = this.gui.addFolder('⛰  Earthen Spire');
    const c = settings.earth;
    const R = Editor.range;

    const cast = folder.addFolder('The cast');
    R(cast, c, 'range', 2, 60, 0.1, 'max range');
    R(cast, c, 'minRange', 0, 10, 0.1, 'min range');
    R(cast, c, 'speed', 5, 120, 1, 'front speed');
    R(cast, c, 'cooldown', 0, 8, 0.05, 'cooldown');
    Editor.castAnimation(cast, c);

    const hand = folder.addFolder('Where the wave leaves the caster');
    R(hand, c, 'handHeight', 0, 3, 0.01, 'hand height');
    R(hand, c, 'handForward', -1, 3, 0.01, 'hand forward');
    R(hand, c, 'handSide', -1.5, 1.5, 0.01, 'hand lateral');
    R(hand, c, 'castFlash', 0, 2, 0.01, 'flash on release');
    hand.addColor(c, 'colorCastFlash').name('release flash colour');

    const wave = folder.addFolder('The travelling wave');
    R(wave, c, 'startOffset', 0, 6, 0.05, 'start offset');
    R(wave, c, 'crustWidth', 0.4, 8, 0.05, 'crust width');
    R(wave, c, 'crustDensity', 0.2, 4, 0.01, 'plate density');
    R(wave, c, 'paintTime', 0.02, 1.0, 0.005, 'plate paint time');
    R(wave, c, 'crackDelay', 0, 1.5, 0.01, 'fracture delay');
    R(wave, c, 'crackSharpness', 0.02, 1.0, 0.01, 'fracture snap');

    const plates = folder.addFolder('The plates');
    R(plates, c, 'plateSize', 0.1, 2, 0.01, 'plate radius');
    R(plates, c, 'plateThickness', 0.02, 0.8, 0.005, 'plate thickness');
    R(plates, c, 'plateTilt', 0, 2.5, 0.01, 'max tilt');
    R(plates, c, 'plateLift', 0, 2, 0.01, 'lift on fracture');
    R(plates, c, 'plateSpread', 0, 1.5, 0.01, 'slide apart');
    R(plates, c, 'crackDepth', 0, 2, 0.01, 'drop into crack');

    const boulders = folder.addFolder('Travelling boulders');
    R(boulders, c, 'rockCount', 1, 60, 1, 'count');
    R(boulders, c, 'rockSpacing', 0.4, 6, 0.05, 'spacing');
    R(boulders, c, 'rockSize', 0.1, 1.6, 0.01, 'base size');
    R(boulders, c, 'rockRandomness', 0, 2, 0.01, 'randomness');
    R(boulders, c, 'riseHeight', 0, 2, 0.01, 'rise height');
    R(boulders, c, 'riseSpeed', 1, 12, 0.05, 'rise speed');
    R(boulders, c, 'tumble', 0, 12, 0.05, 'tumble rate');
    R(boulders, c, 'lifetime', 0.2, 8, 0.05, 'stand time');
    R(boulders, c, 'sinkDelay', 0, 2, 0.01, 'sink delay');

    const tower = folder.addFolder('The tower');
    R(tower, c, 'towerRiseTime', 0.1, 3, 0.01, 'rise time');
    R(tower, c, 'towerHold', 0, 6, 0.05, 'hold time');
    R(tower, c, 'towerWidth', 0.4, 4, 0.05, 'base half-width');
    R(tower, c, 'towerHeight', 1, 12, 0.05, 'height');
    R(tower, c, 'towerRockRadius', 0.5, 5, 0.05, 'boulder ring radius');
    R(tower, c, 'towerRocks', 4, 60, 1, 'boulder ring count');
    R(tower, c, 'groundDisplacement', 0.2, 3, 0.01, 'ring rock lift');

    const look = folder.addFolder('The rock');
    R(look, c, 'glow', 0, 4, 0.01, 'hot-seam glow');
    look.addColor(c, 'colorRock').name('rock body');
    look.addColor(c, 'colorRockDark').name('rock shadow');
    look.addColor(c, 'colorMoss').name('moss');

    const glass = folder.addFolder('Tower glass body');
    glass.addColor(c, 'glassColor').name('tint');
    R(glass, c, 'glassTransmission', 0, 1, 0.01, 'transmission (0 = opaque)');
    R(glass, c, 'glassRoughness', 0, 1, 0.005, 'roughness');
    R(glass, c, 'glassIor', 1, 2.5, 0.005, 'index of refraction');
    R(glass, c, 'glassThickness', 0, 2, 0.01, 'refraction depth (m)');
    glass.addColor(c, 'glassAttenuationColor').name('refraction tint');
    R(glass, c, 'glassAttenuationDistance', 0.05, 4, 0.01, 'refraction tint depth (m)');
    R(glass, c, 'glassOpacity', 0, 1, 0.01, 'opacity (on top of transmission)');
    glass.addColor(c, 'glassEmissive').name('emissive');
    R(glass, c, 'glassEmissiveStrength', 0, 3, 0.01, 'emissive gain');

    const outline = folder.addFolder('Outline glow');
    outline.addColor(c, 'outlineColor').name('rim colour');
    R(outline, c, 'outlineThickness', 0, 0.4, 0.005, 'shell offset (m)');
    R(outline, c, 'outlineStrength', 0, 5, 0.01, 'master gain');
    R(outline, c, 'outlinePulseSpeed', 0, 10, 0.05, 'pulse rate (Hz)');
    R(outline, c, 'outlinePulseDepth', 0, 1, 0.01, 'pulse depth (0 = steady)');
    R(outline, c, 'outlinePulseOnImpact', 0, 6, 0.05, 'impact spike peak');
    R(outline, c, 'outlinePulseSettle', 0, 3, 0.01, 'standing baseline');
    R(outline, c, 'outlinePulseRampDown', 0.05, 6, 0.05, 'spike decay rate (/s)');

    const fx = folder.addFolder('Dust & debris');
    R(fx, c, 'dustAmount', 0, 3, 0.01, 'dust amount');
    R(fx, c, 'dustSize', 0.2, 6, 0.05, 'dust size');
    R(fx, c, 'dustLifetime', 0.4, 6, 0.05, 'dust life');
    R(fx, c, 'debrisSize', 0.1, 2, 0.01, 'debris size');
    R(fx, c, 'debrisVelocity', 1, 16, 0.1, 'debris speed');
    R(fx, c, 'debrisLifetime', 0.2, 4, 0.05, 'debris life');
    R(fx, c, 'pebbleRate', 0, 80, 1, 'pebble rate');

    const impact = folder.addFolder('The impact');
    R(impact, c, 'explosionFlash', 0, 1.5, 0.01, 'screen flash');
    R(impact, c, 'impactShake', 0, 3, 0.01, 'shake amount');
    R(impact, c, 'shakeDuration', 0.1, 4, 0.05, 'shake duration');
    R(impact, c, 'shakeIntensity', 0, 3, 0.01, 'global shake scale');
    impact.addColor(c, 'colorFlash').name('flash colour');

    this.earthFolder = folder;
  }


  /* ------------------------------------------------------------------ */

  /**
   * The gate.
   *
   * The one ability in the set you can leave standing, which changes what the
   * panel is for: every control in it applies to the gate that is already up,
   * so this folder is best driven with one built and the clock paused. Drag
   * `clear span` and the whole arch re-lays itself around the new opening,
   * keystone included; drag `block size` and the courses re-space.
   *
   * The three groups that carry it are **the opening** (what gets built), **the
   * construction** (how it arrives — `first stone -> keystone` against `one
   * stone's flight` is the whole rhythm of it) and **the portal** (what stands
   * in it afterwards, where `spiral wind` and `spiral arms` decide whether the
   * surface reads as a funnel or as a spinning disc).
   */
  _buildPortal() {
    const folder = this.gui.addFolder('⛩  Verdant Gate');
    const c = settings.portal;
    const R = Editor.range;

    const cast = folder.addFolder('The cast');
    R(cast, c, 'range', 2, 60, 0.1, 'max range');
    R(cast, c, 'minRange', 0, 12, 0.1, 'min range');
    R(cast, c, 'speed', 5, 120, 1, 'seam speed');
    R(cast, c, 'cooldown', 0, 12, 0.05, 'cooldown');
    Editor.castAnimation(cast, c);

    const hand = folder.addFolder('Where the seam leaves the caster');
    R(hand, c, 'handHeight', 0, 3, 0.01, 'hand height');
    R(hand, c, 'handForward', -1, 3, 0.01, 'hand forward');
    R(hand, c, 'handSide', -1.5, 1.5, 0.01, 'hand lateral');
    R(hand, c, 'castFlash', 0, 2, 0.01, 'flash on release');
    hand.addColor(c, 'colorCastFlash').name('release flash colour');

    const opening = folder.addFolder('The opening (metres)');
    R(opening, c, 'gateWidth', 1, 10, 0.05, 'clear span');
    R(opening, c, 'gateHeight', 0.6, 8, 0.05, 'springing line');
    R(opening, c, 'gateDepth', 0.2, 3, 0.05, 'wall thickness');

    const stones = folder.addFolder('The stones');
    R(stones, c, 'stoneSize', 0.15, 2, 0.01, 'block size');
    R(stones, c, 'stoneStep', 0.15, 2, 0.01, 'spacing along the arch');
    R(stones, c, 'stoneCourses', 1, 4, 1, 'courses');
    R(stones, c, 'stoneCourseStep', 0.1, 1.5, 0.01, 'course spacing');
    R(stones, c, 'stoneTilt', 0, 1, 0.01, 'set-angle jitter');
    R(stones, c, 'stoneRandomness', 0, 2, 0.01, 'randomness');

    const build = folder.addFolder('The construction');
    R(build, c, 'buildTime', 0.1, 5, 0.05, 'first stone to keystone');
    R(build, c, 'stoneFly', 0.1, 2, 0.01, 'one stone flight');
    R(build, c, 'stoneStart', 0.2, 4, 0.05, 'starts below floor');
    R(build, c, 'stoneArc', 0, 3, 0.05, 'bows out by');
    R(build, c, 'stoneSpin', 0, 10, 0.05, 'tumble');
    R(build, c, 'landShake', 0, 0.6, 0.005, 'shake per stone');
    R(build, c, 'keystoneShake', 0, 2, 0.01, 'keystone shake');

    const surface = folder.addFolder('The portal');
    R(surface, c, 'openDelay', 0, 2, 0.01, 'delay after keystone');
    R(surface, c, 'openTime', 0.1, 4, 0.01, 'aperture flood time');
    R(surface, c, 'closeTime', 0.2, 5, 0.05, 'collapse time');
    R(surface, c, 'spin', -3, 3, 0.01, 'wisp spin (turns/s)');
    R(surface, c, 'twist', 0, 6, 0.05, 'shear toward the middle');
    R(surface, c, 'focus', 0, 1.5, 0.01, 'focus height, x spring');
    R(surface, c, 'turbulence', 0, 2, 0.01, 'wisp strength');
    R(surface, c, 'noiseScale', 0.2, 8, 0.05, 'wisp scale');
    R(surface, c, 'flow', 0, 3, 0.01, 'boil speed');
    R(surface, c, 'core', 0, 4, 0.01, 'glow at the focus');
    R(surface, c, 'coreSize', 0.05, 1.5, 0.01, 'its radius');
    R(surface, c, 'column', 0, 3, 0.01, 'column up the middle');
    R(surface, c, 'rim', 0, 3, 0.01, 'glow hugging the arch');
    R(surface, c, 'rimWidth', 0.05, 3, 0.01, 'how far it reaches (m)');
    R(surface, c, 'rimFalloff', 0.2, 6, 0.05, 'its falloff');
    R(surface, c, 'rimHot', 0, 4, 0.01, 'white lip at the stone');
    R(surface, c, 'updraft', 0, 3, 0.01, 'light up the jambs');
    R(surface, c, 'clear', 0, 1, 0.01, 'see through the middle');
    R(surface, c, 'clearSize', 0.05, 1.5, 0.01, 'clearing radius');
    R(surface, c, 'clearFalloff', 0.2, 5, 0.05, 'clearing falloff');
    R(surface, c, 'halo', 0, 4, 0.01, 'spill onto the stones');
    R(surface, c, 'haloWidth', 0.05, 2, 0.01, 'spill reach (m)');
    R(surface, c, 'overlap', 0, 1.5, 0.01, 'tucked under the stones (m)');
    R(surface, c, 'surfaceOpacity', 0, 1, 0.01, 'how solid it reads');

    const colors = folder.addFolder('Colour');
    colors.addColor(c, 'colorCore').name('vortex centre');
    colors.addColor(c, 'colorMid').name('the gate itself');
    colors.addColor(c, 'colorDeep').name('between the bands');
    colors.addColor(c, 'colorRim').name('contour & halo');
    colors.addColor(c, 'colorRock').name('stone body');
    colors.addColor(c, 'colorRockDark').name('stone shadow');
    colors.addColor(c, 'colorMoss').name('moss');

    const fx = folder.addFolder('Motes, mist & dust');
    R(fx, c, 'moteRate', 0, 160, 1, 'motes / second');
    R(fx, c, 'moteSize', 0.01, 0.6, 0.005, 'mote size');
    R(fx, c, 'moteLife', 0.3, 8, 0.05, 'mote life');
    R(fx, c, 'moteRise', 0, 6, 0.05, 'mote rise speed');
    R(fx, c, 'mistRate', 0, 80, 1, 'mist / second');
    R(fx, c, 'mistSize', 0.1, 4, 0.05, 'mist size');
    R(fx, c, 'mistLife', 0.3, 8, 0.05, 'mist life');
    R(fx, c, 'dustAmount', 0, 3, 0.01, 'build dust');
    R(fx, c, 'dustSize', 0.2, 4, 0.05, 'dust size');
    R(fx, c, 'dustLifetime', 0.2, 5, 0.05, 'dust life');
    R(fx, c, 'debrisSize', 0.02, 1, 0.01, 'chip size');
    R(fx, c, 'debrisVelocity', 0.5, 14, 0.1, 'chip speed');
    R(fx, c, 'debrisLifetime', 0.2, 4, 0.05, 'chip life');

    const light = folder.addFolder('Light & impact');
    R(light, c, 'lightIntensity', 0, 40, 0.1, 'light intensity');
    R(light, c, 'lightRadius', 1, 40, 0.5, 'light radius');
    R(light, c, 'lightHeight', 0, 5, 0.05, 'light height');
    R(light, c, 'lightFlicker', 0, 1, 0.01, 'flicker depth');
    light.addColor(c, 'lightColor').name('light colour');
    R(light, c, 'explosionFlash', 0, 1.5, 0.01, 'screen flash on open');
    R(light, c, 'shakeIntensity', 0, 3, 0.01, 'shake scale');

    this.portalFolder = folder;
  }

  /* ------------------------------------------------------------------ */

  /**
   * The ring.
   *
   * The other standing cast, and the one whose panel is really a *timeline*:
   * `The forging`, `Standing up` and `The rift` run one after the other, each
   * measured off the end of the last, so dragging `first segment -> crown`
   * pushes the tip-up and the opening along with it and the sequence never
   * comes apart. Best driven with one raised and the clock paused — `clear
   * radius` re-forges a standing ring around a new circle, and `stand up over`
   * re-poses one frozen halfway through its hinge.
   *
   * `The rift` is where its argument with the Verdant Gate is: `the dark at the
   * middle` takes the centre of the surface *away*, which is the inverse of the
   * gate's lit fog, and `rim` puts everything that is left against the stone.
   * Turn the eye down to zero and what is left is a glowing plate; that one
   * slider is most of the difference between a portal and a hole.
   */
  _buildAether() {
    const folder = this.gui.addFolder('◎  Tidewrought Ring');
    const c = settings.aether;
    const R = Editor.range;

    const cast = folder.addFolder('The cast');
    R(cast, c, 'range', 2, 60, 0.1, 'max range');
    R(cast, c, 'minRange', 0, 12, 0.1, 'min range');
    R(cast, c, 'speed', 5, 120, 1, 'tide speed');
    R(cast, c, 'cooldown', 0, 12, 0.05, 'cooldown');
    Editor.castAnimation(cast, c);

    const hand = folder.addFolder('Where the tide leaves the caster');
    R(hand, c, 'handHeight', 0, 3, 0.01, 'hand height');
    R(hand, c, 'handForward', -1, 3, 0.01, 'hand forward');
    R(hand, c, 'handSide', -1.5, 1.5, 0.01, 'hand lateral');
    R(hand, c, 'castFlash', 0, 2, 0.01, 'flash on release');
    hand.addColor(c, 'colorCastFlash').name('release flash colour');

    const hoop = folder.addFolder('The ring (metres)');
    R(hoop, c, 'ringRadius', 0.6, 6, 0.05, 'clear radius');
    R(hoop, c, 'ringDepth', 0.2, 3, 0.05, 'hoop thickness');
    R(hoop, c, 'ringHover', 0, 2, 0.01, 'clears the floor by');
    R(hoop, c, 'layHeight', 0, 1, 0.01, 'lies at');
    R(hoop, c, 'lobes', 0, 16, 1, 'lobes');
    R(hoop, c, 'lobeDepth', 0, 0.3, 0.005, 'lobe depth');

    const segments = folder.addFolder('The segments');
    R(segments, c, 'segmentSize', 0.1, 2, 0.01, 'segment size');
    R(segments, c, 'segmentStep', 0.1, 2, 0.01, 'spacing along the ring');
    R(segments, c, 'courses', 1, 4, 1, 'courses');
    R(segments, c, 'courseStep', 0.1, 1.5, 0.01, 'course spacing');
    R(segments, c, 'spurs', 0, 24, 1, 'spurs under the foot');
    R(segments, c, 'segmentTilt', 0, 1, 0.01, 'set-angle jitter');
    R(segments, c, 'segmentRandomness', 0, 2, 0.01, 'randomness');

    const forge = folder.addFolder('The forging');
    R(forge, c, 'assembleTime', 0.1, 5, 0.05, 'first segment to crown');
    R(forge, c, 'segmentFly', 0.05, 2, 0.01, 'one segment swing');
    R(forge, c, 'swarmRadius', 1, 8, 0.05, 'comes from, x its radius');
    R(forge, c, 'swarmTurns', 0, 2, 0.01, 'turns on the way in');
    R(forge, c, 'swarmDepth', 0, 4, 0.05, 'out of plane by (m)');
    R(forge, c, 'segmentSpin', 0, 12, 0.05, 'tumble');
    R(forge, c, 'spinTurns', -4, 4, 0.01, 'closing turns');
    R(forge, c, 'idleSpin', -0.5, 0.5, 0.005, 'idle spin (turns/s)');
    R(forge, c, 'lockShake', 0, 0.6, 0.005, 'shake per segment');
    R(forge, c, 'crownShake', 0, 2, 0.01, 'crown shake');

    const stand = folder.addFolder('Standing up');
    R(stand, c, 'riseDelay', 0, 2, 0.01, 'delay after the crown');
    R(stand, c, 'riseTime', 0.1, 4, 0.01, 'stand up over');

    const rift = folder.addFolder('The rift');
    R(rift, c, 'openDelay', 0, 2, 0.01, 'delay after standing');
    R(rift, c, 'openTime', 0.05, 4, 0.01, 'surge time');
    R(rift, c, 'closeTime', 0.2, 5, 0.05, 'break-up time');
    R(rift, c, 'churn', 0, 1, 0.01, 'boil on the filling edge');
    R(rift, c, 'spin', -3, 3, 0.01, 'pool shear (turns/s)');
    R(rift, c, 'twist', 0, 6, 0.05, 'shear toward the eye');
    R(rift, c, 'turbulence', 0, 2, 0.01, 'water strength');
    R(rift, c, 'noiseScale', 0.2, 8, 0.05, 'water scale');
    R(rift, c, 'flow', 0, 3, 0.01, 'boil speed');
    R(rift, c, 'ripples', 0, 12, 0.1, 'rings across the radius');
    R(rift, c, 'rippleSpeed', -4, 4, 0.05, 'how fast they run in');
    R(rift, c, 'rippleDepth', 0, 1, 0.01, 'how deep they cut');
    R(rift, c, 'rim', 0, 3, 0.01, 'light at the segments');
    R(rift, c, 'rimWidth', 0.05, 3, 0.01, 'how far it reaches (m)');
    R(rift, c, 'rimFalloff', 0.2, 6, 0.05, 'its falloff');
    R(rift, c, 'rimHot', 0, 4, 0.01, 'white lip at the stone');
    R(rift, c, 'eye', 0, 2, 0.01, 'the dark at the middle');
    R(rift, c, 'eyeSize', 0.05, 1.2, 0.01, 'eye radius');
    R(rift, c, 'eyeClear', 0, 1, 0.01, 'see through the eye');
    R(rift, c, 'sparkle', 0, 3, 0.01, 'motes in the pool');
    R(rift, c, 'sparkleScale', 0.5, 10, 0.1, 'how many');
    R(rift, c, 'halo', 0, 4, 0.01, 'spill onto the segments');
    R(rift, c, 'haloWidth', 0.05, 2, 0.01, 'spill reach (m)');
    R(rift, c, 'overlap', 0, 1.5, 0.01, 'tucked under the stone (m)');
    R(rift, c, 'surfaceOpacity', 0, 1, 0.01, 'how solid it reads');

    const runes = folder.addFolder('The runes');
    R(runes, c, 'runes', 0, 3, 0.01, 'band strength');
    R(runes, c, 'runeCount', 1, 40, 1, 'marks per half');
    R(runes, c, 'runeRadius', 0, 1.5, 0.01, 'band offset (m)');
    R(runes, c, 'runeWidth', 0.01, 0.5, 0.005, 'band thickness (m)');
    R(runes, c, 'runeGap', 0.02, 0.5, 0.01, 'mark duty');
    R(runes, c, 'runeGlow', 0, 4, 0.01, 'burned into the stone');

    const apart = folder.addFolder('Coming apart');
    R(apart, c, 'scatterOut', 0, 10, 0.05, 'flung outward (m)');
    R(apart, c, 'scatterSpin', 0, 6, 0.05, 'and off the spindle (m)');

    const colors = folder.addFolder('Colour');
    colors.addColor(c, 'colorCore').name('lip at the stone');
    colors.addColor(c, 'colorMid').name('the water');
    colors.addColor(c, 'colorDeep').name('the deep & the eye');
    colors.addColor(c, 'colorRim').name('rim, halo & runes');
    colors.addColor(c, 'colorMetal').name('segment body');
    colors.addColor(c, 'colorMetalDark').name('segment shadow');

    const fx = folder.addFolder('Motes, spray & mist');
    R(fx, c, 'moteRate', 0, 160, 1, 'motes / second');
    R(fx, c, 'moteSize', 0.01, 0.6, 0.005, 'mote size');
    R(fx, c, 'moteLife', 0.2, 8, 0.05, 'mote life');
    R(fx, c, 'moteDraw', 0, 8, 0.05, 'drawn inward at');
    R(fx, c, 'moteCurl', 0, 2, 0.01, 'lean into the turn');
    R(fx, c, 'sprayRate', 0, 160, 1, 'spray / second');
    R(fx, c, 'spraySize', 0.01, 0.8, 0.005, 'spray size');
    R(fx, c, 'sprayLife', 0.2, 6, 0.05, 'spray life');
    R(fx, c, 'sprayRise', 0, 10, 0.05, 'leaves the pool at');
    R(fx, c, 'surgeSpeed', 1, 30, 0.5, 'surge speed');
    R(fx, c, 'mistRate', 0, 80, 1, 'mist / second');
    R(fx, c, 'mistSize', 0.1, 4, 0.05, 'mist size');
    R(fx, c, 'mistLife', 0.3, 8, 0.05, 'mist life');
    R(fx, c, 'debrisSize', 0.02, 1, 0.01, 'chip size');
    R(fx, c, 'debrisVelocity', 0.5, 14, 0.1, 'chip speed');
    R(fx, c, 'debrisLifetime', 0.2, 4, 0.05, 'chip life');

    const light = folder.addFolder('Light & impact');
    R(light, c, 'lightIntensity', 0, 40, 0.1, 'light intensity');
    R(light, c, 'lightRadius', 1, 40, 0.5, 'light radius');
    R(light, c, 'lightFlicker', 0, 1, 0.01, 'swell depth');
    light.addColor(c, 'lightColor').name('light colour');
    R(light, c, 'explosionFlash', 0, 1.5, 0.01, 'screen flash on open');
    R(light, c, 'shakeIntensity', 0, 3, 0.01, 'shake scale');

    this.aetherFolder = folder;
  }

  /* ------------------------------------------------------------------ */
  /**
   * The portal that is a disc and an emitter.
   *
   * By far the shortest of the three standing-cast folders, and that is the
   * argument the ability is making: the gate needs fourteen controls to say how
   * its stones are stacked and the ring needs ten to say how its segments swing
   * in, and this one has no pieces at all. There is a black disc, there is a
   * ring, and everything else you can see is one particle system.
   *
   * So `The sparks` is where the whole look lives, and the two to find first are
   * `spark speed` and `drag`. The sparks leave the ring on a straight tangent —
   * nothing in the ability draws a curve — and the drag is what bends them into
   * the long lines. Low drag gives a starburst; high drag scrolls them tight
   * round the rim. `spark life` is then how far the fan reaches, because the
   * four colours below are spread across it.
   *
   * `licks back over the hole`, under `The ring`, is the one slider that can
   * ruin it. Push it past a couple of centimetres and the ring's bloom crosses
   * the contour, the middle lights, and the hole is gone — and the hole is the
   * ability.
   */
  _buildFirePortal() {
    const folder = this.gui.addFolder('◌  Fire Portal');
    const c = settings.firePortal;
    const R = Editor.range;

    const cast = folder.addFolder('The cast');
    R(cast, c, 'range', 2, 60, 0.1, 'max range');
    R(cast, c, 'minRange', 0, 12, 0.1, 'min range');
    R(cast, c, 'speed', 5, 120, 1, 'cast speed');
    R(cast, c, 'cooldown', 0, 12, 0.05, 'cooldown');
    Editor.castAnimation(cast, c);

    const circle = folder.addFolder('The circle (metres)');
    R(circle, c, 'ringRadius', 0.6, 6, 0.05, 'clear radius');
    R(circle, c, 'ringHover', 0, 3, 0.01, 'clears the floor by');
    R(circle, c, 'lean', -0.6, 0.6, 0.005, 'tips back by (rad)');
    R(circle, c, 'closeTime', 0.2, 5, 0.05, 'goes out over');

    const draw = folder.addFolder('Struck — the spark that draws it');
    R(draw, c, 'scribeTime', 0.1, 3, 0.01, 'runs round in');
    R(draw, c, 'scribeHead', 0, 8, 0.05, 'the spark itself');
    R(draw, c, 'scribeHeadSize', 0.03, 0.8, 0.005, 'how big it is (m)');
    R(draw, c, 'scribeFeather', 0.02, 1.2, 0.01, 'line comes up over (m)');
    R(draw, c, 'scribeTrail', 0.1, 8, 0.05, 'still white-hot for (m)');
    R(draw, c, 'scribeTrailHeat', 0, 5, 0.05, 'how much hotter');
    R(draw, c, 'scribeRate', 0, 30000, 100, 'shower / second');
    R(draw, c, 'scribeTail', 0.05, 4, 0.01, 'born within (m) of it');
    R(draw, c, 'scribeSpeed', 0, 40, 0.1, 'shower speed (m/s)');
    R(draw, c, 'scribeOut', -1, 2, 0.01, 'thrown outward by');
    R(draw, c, 'scribeSpread', 0, 1, 0.01, 'cone spread at the head');
    R(draw, c, 'scribeInherit', 0, 1.5, 0.01, 'carries its travel');
    R(draw, c, 'openTime', 0.05, 4, 0.01, 'stroke settles over');
    R(draw, c, 'apertureDelay', 0, 1, 0.01, 'hole waits for (of the draw)');
    R(draw, c, 'apertureTime', 0.05, 4, 0.01, 'hole irises over');

    const ring = folder.addFolder('The ring');
    R(ring, c, 'ring', 0, 4, 0.01, 'bloom brightness');
    R(ring, c, 'ringWidth', 0.02, 2, 0.01, 'bloom outward (m)');
    R(ring, c, 'ringInner', 0.01, 0.6, 0.005, 'licks back over the hole (m)');
    R(ring, c, 'ringHot', 0, 6, 0.01, 'the white line itself');
    ring.addColor(c, 'colorRing').name('bloom colour');
    R(ring, c, 'surfaceOpacity', 0, 1, 0.01, 'how solid the hole reads');

    const middle = folder.addFolder('The middle');
    R(middle, c, 'voidDark', 0, 1, 0.01, 'how black it is');
    R(middle, c, 'voidWarm', 0, 2, 0.01, 'bounce inside the lip');
    R(middle, c, 'voidFeather', 0.02, 2, 0.01, 'feathers into the ring (m)');
    middle.addColor(c, 'colorVoid').name('the middle');

    const sparks = folder.addFolder('The sparks');
    R(sparks, c, 'sparkRate', 0, 6000, 20, 'sparks / second');
    R(sparks, c, 'sparkSpeed', 0, 40, 0.1, 'spark speed (m/s)');
    R(sparks, c, 'sparkDrag', 0, 6, 0.01, 'drag — what curves them');
    R(sparks, c, 'sparkLife', 0.1, 4, 0.01, 'spark life');
    R(sparks, c, 'sparkSwirl', -2, 2, 0.05, 'which way round');
    R(sparks, c, 'sparkOut', -1, 2, 0.01, 'thrown outward by');
    R(sparks, c, 'sparkSpread', 0, 1, 0.01, 'cone spread');
    R(sparks, c, 'sparkGravity', -20, 10, 0.1, 'gravity');
    R(sparks, c, 'sparkSize', 0.005, 0.4, 0.005, 'spark width');
    R(sparks, c, 'sparkStretch', 0, 1, 0.005, 'streak length');
    R(sparks, c, 'sparkEndSize', 0, 2, 0.01, 'width when it dies');
    R(sparks, c, 'sparkFadeOut', 0, 1, 0.01, 'fades over');
    R(sparks, c, 'sparkWander', 0, 1.5, 0.01, 'wobble');
    R(sparks, c, 'sparkJitter', 0, 0.6, 0.005, 'birth scatter (m)');
    R(sparks, c, 'sparkSpeedVariance', 0, 1, 0.01, 'speed variance');
    R(sparks, c, 'sparkLifeVariance', 0, 1, 0.01, 'life variance');

    const grade = folder.addFolder('Spark colour over its life');
    grade.addColor(c, 'colorBirth').name('birth — white');
    grade.addColor(c, 'colorEarly').name('early — orange');
    grade.addColor(c, 'colorLate').name('late — red');
    grade.addColor(c, 'colorDeath').name('death');

    const light = folder.addFolder('Light');
    R(light, c, 'lightIntensity', 0, 40, 0.1, 'light intensity');
    R(light, c, 'lightRadius', 1, 40, 0.5, 'light radius');
    R(light, c, 'lightFlicker', 0, 1, 0.01, 'gutter depth');
    light.addColor(c, 'lightColor').name('light colour');

    this.firePortalFolder = folder;
  }

  /* ------------------------------------------------------------------ */

  /**
   * The self buff. Not an ability folder: there is no range, no min range and
   * no cast speed, because there is nothing to aim — what a skillshot spends on
   * targeting, this spends on the body it is worn by.
   */
  _buildBoost() {
    const folder = this.gui.addFolder('⚡  Electric Boost');
    const c = settings.boost;
    const R = Editor.range;

    const buff = folder.addFolder('The buff');
    R(buff, c, 'duration', 1, 60, 0.1, 'duration');
    R(buff, c, 'rampIn', 0.05, 3, 0.01, 'ramp in');
    R(buff, c, 'rampOut', 0.05, 4, 0.01, 'ramp out');
    R(buff, c, 'cooldown', 0, 20, 0.05, 'cooldown');
    buff.add(c, 'playAnimation').name('throw a clip');
    Editor.castAnimation(buff, c);

    // The fresnel is on the character's *own* materials, so these apply to a
    // rig that is already charged — including a paused one.
    const rim = folder.addFolder('Fresnel on the character');
    R(rim, c, 'fresnel', 0, 3, 0.01, 'rim strength');
    R(rim, c, 'fresnelPower', 0.2, 8, 0.05, 'rim tightness');
    R(rim, c, 'fresnelBias', 0, 1, 0.005, 'body glow');
    R(rim, c, 'fresnelGlow', 0, 8, 0.05, 'glow');
    R(rim, c, 'fresnelPulse', 0, 1, 0.01, 'breathing');
    R(rim, c, 'fresnelPulseSpeed', 0.1, 12, 0.05, 'breathing rate');
    R(rim, c, 'fresnelFlicker', 0, 1, 0.01, 'stutter');
    R(rim, c, 'fresnelFlickerSpeed', 1, 90, 1, 'stutter rate');
    rim.addColor(c, 'colorRim').name('rim');
    rim.addColor(c, 'colorCore').name('rim core');
    rim.addColor(c, 'colorVein').name('veins');

    const skin = folder.addFolder('Veins & sweep');
    R(skin, c, 'veins', 0, 3, 0.01, 'vein strength');
    R(skin, c, 'veinScale', 0.5, 30, 0.1, 'veins / metre');
    R(skin, c, 'veinSpeed', -6, 6, 0.05, 'vein crawl');
    R(skin, c, 'veinSharp', 0, 1, 0.01, 'vein sharpness');
    R(skin, c, 'scan', 0, 3, 0.01, 'sweep strength');
    R(skin, c, 'scanSpeed', 0, 4, 0.01, 'sweeps / sec');
    R(skin, c, 'scanWidth', 0.02, 1, 0.005, 'sweep width');

    const arcs = folder.addFolder('The arcs');
    R(arcs, c, 'arcs', 1, 32, 1, 'arcs at once');
    R(arcs, c, 'arcRate', 0.2, 20, 0.1, 'strikes / sec');
    R(arcs, c, 'arcLife', 0.05, 1, 0.01, 'lit fraction');
    R(arcs, c, 'arcSpan', 0.02, 1, 0.01, 'travel up the body');
    R(arcs, c, 'arcSweep', 0.05, 3.2, 0.01, 'travel around it');
    R(arcs, c, 'arcEscape', 0, 1, 0.01, 'fraction leaving');
    R(arcs, c, 'arcReach', 0, 4, 0.01, 'reach off the body');
    R(arcs, c, 'arcBow', 0, 1, 0.005, 'bow off the skin');

    const body = folder.addFolder('The body they are struck on');
    R(body, c, 'bodyRadius', 0.05, 1.5, 0.01, 'radius');
    R(body, c, 'bodyDepth', 0.1, 2, 0.01, 'front-to-back');
    R(body, c, 'bodyLow', -0.2, 1, 0.01, 'lowest point');
    R(body, c, 'bodyHigh', 0, 1.6, 0.01, 'highest point');
    R(body, c, 'bodyProfile', 0, 1, 0.01, 'silhouette');

    const shape = folder.addFolder('The shape of one arc');
    R(shape, c, 'arcJitter', 0, 1, 0.005, 'kink amplitude');
    R(shape, c, 'arcJitterScale', 0.2, 30, 0.1, 'kinks / metre');
    R(shape, c, 'arcOctaves', 1, 5, 1, 'octaves');
    R(shape, c, 'arcJitterFalloff', 0.1, 0.95, 0.01, 'octave falloff');
    R(shape, c, 'arcCrawl', -20, 20, 0.1, 'kink crawl');
    R(shape, c, 'arcPinch', 0.01, 0.5, 0.005, 'end pinch');

    const ribbon = folder.addFolder('The ribbon');
    R(ribbon, c, 'arcWidth', 0.002, 0.3, 0.001, 'width');
    R(ribbon, c, 'arcTaper', 0.05, 3, 0.01, 'end taper');
    R(ribbon, c, 'arcCoreWidth', 1, 6, 0.01, 'spine thickness');
    R(ribbon, c, 'arcCoreSharp', 0.5, 12, 0.05, 'core sharpness');
    R(ribbon, c, 'arcGlowWidth', 1, 30, 0.1, 'halo width');
    R(ribbon, c, 'arcGlowFalloff', 0.2, 8, 0.05, 'halo falloff');
    R(ribbon, c, 'arcGlowOpacity', 0, 2, 0.01, 'halo opacity');
    R(ribbon, c, 'arcSoftFade', 0.02, 3, 0.01, 'soft intersection');
    R(ribbon, c, 'arcFlicker', 0, 1, 0.01, 'brightness stutter');
    R(ribbon, c, 'arcFlickerSpeed', 1, 120, 1, 'stutter rate');
    R(ribbon, c, 'arcStrandFlash', 0, 1, 0.01, 'arc blink');
    R(ribbon, c, 'arcGlow', 0, 8, 0.01, 'glow');
    R(ribbon, c, 'arcOpacity', 0, 2, 0.01, 'opacity');
    ribbon.addColor(c, 'colorArcCore').name('core');
    ribbon.addColor(c, 'colorArcInner').name('inner');
    ribbon.addColor(c, 'colorArcOuter').name('outer');
    ribbon.addColor(c, 'colorArcHalo').name('halo');

    const shed = folder.addFolder('Sparks & motes');
    R(shed, c, 'sparkRate', 0, 800, 1, 'spark rate');
    R(shed, c, 'sparkSize', 0.005, 0.8, 0.005, 'spark size');
    R(shed, c, 'sparkSpeed', 0, 30, 0.1, 'spark speed');
    R(shed, c, 'sparkLifetime', 0.05, 4, 0.01, 'spark lifetime');
    R(shed, c, 'sparkGravity', -50, 5, 0.1, 'spark gravity');
    R(shed, c, 'sparkStretch', 0, 3, 0.01, 'spark stretch');
    R(shed, c, 'moteRate', 0, 500, 1, 'mote rate');
    R(shed, c, 'moteSize', 0.005, 0.4, 0.005, 'mote size');
    R(shed, c, 'moteSpeed', 0, 12, 0.05, 'mote speed');
    R(shed, c, 'moteLifetime', 0.1, 8, 0.05, 'mote lifetime');
    R(shed, c, 'moteRise', -3, 8, 0.05, 'mote rise');
    R(shed, c, 'moteTurbulence', 0, 3, 0.01, 'mote turbulence');
    Editor.gradient(shed, c, 'colorSpark', 'Spark colour');
    Editor.gradient(shed, c, 'colorMote', 'Mote colour');

    const crater = folder.addFolder('The crater under the feet');
    R(crater, c, 'fieldRadius', 0.2, 12, 0.05, 'radius');
    R(crater, c, 'fieldHeight', 0, 0.5, 0.005, 'height off the floor');
    R(crater, c, 'fieldEdge', 0.02, 2, 0.01, 'lip width');
    R(crater, c, 'fieldEdgeGlow', 0, 6, 0.01, 'lip glow');
    R(crater, c, 'fieldTear', 0, 0.6, 0.005, 'out of round');
    R(crater, c, 'fieldDark', 0, 1, 0.01, 'darkness');
    R(crater, c, 'fieldDarkScale', 0.1, 12, 0.05, 'grain / metre');
    R(crater, c, 'fieldDarkContrast', 0.2, 6, 0.05, 'grain contrast');
    R(crater, c, 'fieldPlateScale', 0.1, 8, 0.05, 'shards / metre');
    R(crater, c, 'fieldPlateTone', 0, 1, 0.01, 'shard variation');
    R(crater, c, 'fieldSeamWidth', 0.005, 0.4, 0.005, 'seam width');
    R(crater, c, 'fieldSeams', 0, 4, 0.01, 'seam glow');
    R(crater, c, 'fieldVeins', 0, 3, 0.01, 'filaments');
    R(crater, c, 'fieldVeinScale', 0.1, 12, 0.05, 'filaments / metre');
    R(crater, c, 'fieldWarp', 0, 3, 0.01, 'warp');
    R(crater, c, 'fieldCrawl', -4, 4, 0.01, 'crawl');
    R(crater, c, 'fieldEmbers', 0, 3, 0.01, 'embers');
    R(crater, c, 'fieldEmberScale', 0.5, 20, 0.1, 'embers / metre');
    R(crater, c, 'fieldFalloff', 0.05, 5, 0.05, 'light falloff');
    R(crater, c, 'fieldPulse', 0, 1, 0.01, 'breathing');
    R(crater, c, 'fieldPulseSpeed', 0.05, 8, 0.05, 'breathing rate');
    R(crater, c, 'fieldOpacity', 0, 2, 0.01, 'opacity');
    R(crater, c, 'fieldGlow', 0, 8, 0.01, 'glow');
    crater.addColor(c, 'colorFieldCrust').name('crust');
    crater.addColor(c, 'colorFieldPlate').name('shards');
    crater.addColor(c, 'colorFieldSeam').name('seams');
    crater.addColor(c, 'colorFieldEmber').name('embers & lip');

    const rings = folder.addFolder('Rings around the crater');
    R(rings, c, 'ringCount', 0, 16, 1, 'rings at once');
    R(rings, c, 'ringRate', 0.05, 10, 0.05, 'strikes / sec');
    R(rings, c, 'ringLife', 0.05, 1, 0.01, 'lit fraction');
    R(rings, c, 'ringInner', 0, 1.5, 0.01, 'innermost × radius');
    R(rings, c, 'ringOuter', 0, 1.5, 0.01, 'outermost × radius');
    R(rings, c, 'ringLift', 0, 4, 0.01, 'stack height');
    R(rings, c, 'ringSweep', 0.05, 1, 0.01, 'turn covered');
    R(rings, c, 'ringWobble', 0, 2, 0.01, 'radial distortion');
    R(rings, c, 'ringWobbleScale', 0.2, 10, 0.05, 'lobes around');
    R(rings, c, 'ringRipple', 0, 1, 0.005, 'vertical ripple');
    R(rings, c, 'ringWrithe', -4, 4, 0.01, 'lobe crawl');
    R(rings, c, 'ringWidth', 0.002, 0.2, 0.001, 'width');

    const spires = folder.addFolder('Uprights across the circle');
    R(spires, c, 'spireCount', 0, 32, 1, 'uprights at once');
    R(spires, c, 'spireRate', 0.05, 20, 0.05, 'strikes / sec');
    R(spires, c, 'spireLife', 0.05, 1, 0.01, 'lit fraction');
    R(spires, c, 'spireHeight', 0.1, 8, 0.05, 'height reached');
    R(spires, c, 'spireCross', 0, 1, 0.01, 'fraction crossing');
    R(spires, c, 'spireSpan', 0.05, 3.14, 0.01, 'arch span');
    R(spires, c, 'spireSpread', 0, 1.5, 0.01, 'climber drift');
    R(spires, c, 'spireLean', 0, 2, 0.01, 'outward lean');
    R(spires, c, 'spireWidth', 0.002, 0.2, 0.001, 'width');

    const coil = folder.addFolder('The coil ribbon');
    R(coil, c, 'coilJitter', 0, 1, 0.005, 'kink amplitude');
    R(coil, c, 'coilJitterScale', 0.2, 30, 0.1, 'kinks / metre');
    R(coil, c, 'coilOctaves', 1, 5, 1, 'octaves');
    R(coil, c, 'coilJitterFalloff', 0.1, 0.95, 0.01, 'octave falloff');
    R(coil, c, 'coilCrawl', -20, 20, 0.1, 'kink crawl');
    R(coil, c, 'coilPinch', 0.01, 0.5, 0.005, 'end pinch');
    R(coil, c, 'coilTaper', 0.05, 3, 0.01, 'end taper');
    R(coil, c, 'coilCoreWidth', 1, 6, 0.01, 'spine thickness');
    R(coil, c, 'coilCoreSharp', 0.5, 12, 0.05, 'core sharpness');
    R(coil, c, 'coilGlowWidth', 1, 30, 0.1, 'halo width');
    R(coil, c, 'coilGlowFalloff', 0.2, 8, 0.05, 'halo falloff');
    R(coil, c, 'coilGlowOpacity', 0, 2, 0.01, 'halo opacity');
    R(coil, c, 'coilSoftFade', 0.02, 3, 0.01, 'soft intersection');
    R(coil, c, 'coilFlicker', 0, 1, 0.01, 'brightness stutter');
    R(coil, c, 'coilFlickerSpeed', 1, 120, 1, 'stutter rate');
    R(coil, c, 'coilStrandFlash', 0, 1, 0.01, 'filament blink');
    R(coil, c, 'coilGlow', 0, 8, 0.01, 'glow');
    R(coil, c, 'coilOpacity', 0, 2, 0.01, 'opacity');
    coil.addColor(c, 'colorCoilCore').name('core');
    coil.addColor(c, 'colorCoilInner').name('inner');
    coil.addColor(c, 'colorCoilOuter').name('outer');
    coil.addColor(c, 'colorCoilHalo').name('halo');

    const ground = folder.addFolder('Burns under the feet');
    R(ground, c, 'groundRate', 0, 30, 0.1, 'burns / sec');
    R(ground, c, 'groundRadius', 0.05, 5, 0.05, 'burn radius');
    R(ground, c, 'groundSpread', 0, 5, 0.05, 'scatter');
    R(ground, c, 'groundLife', 0.05, 5, 0.05, 'burn lifetime');
    R(ground, c, 'groundIntensity', 0, 3, 0.01, 'burn intensity');
    R(ground, c, 'groundBranches', 0, 3, 0.01, 'branch detail');
    ground.addColor(c, 'colorGround').name('burn');
    ground.addColor(c, 'colorGroundEmber').name('ember');

    const light = folder.addFolder('Dynamic light');
    R(light, c, 'lightIntensity', 0, 60, 0.5, 'intensity');
    R(light, c, 'lightRadius', 1, 40, 0.5, 'radius');
    R(light, c, 'lightHeight', 0, 3, 0.01, 'height');
    R(light, c, 'lightFlicker', 0, 1, 0.01, 'gutter');
    R(light, c, 'lightFlickerSpeed', 1, 90, 1, 'gutter rate');
    light.addColor(c, 'lightColor').name('colour');

    const beats = folder.addFolder('Charge & release');
    R(beats, c, 'burstSparks', 0, 600, 1, 'sparks on charge');
    R(beats, c, 'ringRadius', 0.5, 20, 0.1, 'shockwave radius');
    R(beats, c, 'activateFlash', 0, 2, 0.01, 'flash on charge');
    R(beats, c, 'endFlash', 0, 2, 0.01, 'flash on release');
    R(beats, c, 'activateShake', 0, 4, 0.01, 'shake on charge');
    R(beats, c, 'shakeDuration', 0.05, 3, 0.01, 'shake duration');
    R(beats, c, 'rumble', 0, 0.4, 0.001, 'rumble while held');
    beats.addColor(c, 'colorFlash').name('flash colour');
  }

  /* ------------------------------------------------------------------ */

  /**
   * The second self buff. Same shape of folder as the charge's — the buff, the
   * fresnel, the thing wound around the body, the floor, the shed and the two
   * beats — because they are the same kind of effect read two ways, and tuning
   * one should not mean learning a different panel.
   */
  _buildMagic() {
    const folder = this.gui.addFolder('✦  Magic Boost');
    const c = settings.magic;
    const R = Editor.range;

    const buff = folder.addFolder('The buff');
    R(buff, c, 'duration', 1, 60, 0.1, 'duration');
    R(buff, c, 'rampIn', 0.05, 4, 0.01, 'ramp in');
    R(buff, c, 'rampOut', 0.05, 6, 0.01, 'ramp out');
    R(buff, c, 'cooldown', 0, 20, 0.05, 'cooldown');
    buff.add(c, 'playAnimation').name('throw a clip');
    Editor.castAnimation(buff, c);

    // The same patch on the character's own materials the electric buff uses,
    // shaded from this block — so these apply to a rig that is already lit,
    // including a paused one.
    const rim = folder.addFolder('Fresnel on the character');
    R(rim, c, 'fresnel', 0, 3, 0.01, 'rim strength');
    R(rim, c, 'fresnelPower', 0.2, 8, 0.05, 'rim tightness');
    R(rim, c, 'fresnelBias', 0, 1, 0.005, 'body glow');
    R(rim, c, 'fresnelGlow', 0, 8, 0.05, 'glow');
    R(rim, c, 'fresnelPulse', 0, 1, 0.01, 'breathing');
    R(rim, c, 'fresnelPulseSpeed', 0.1, 12, 0.05, 'breathing rate');
    R(rim, c, 'fresnelFlicker', 0, 1, 0.01, 'stutter');
    R(rim, c, 'fresnelFlickerSpeed', 1, 90, 1, 'stutter rate');
    rim.addColor(c, 'colorRim').name('rim');
    rim.addColor(c, 'colorCore').name('rim core');
    rim.addColor(c, 'colorVein').name('veins');

    const skin = folder.addFolder('Veins & sweep');
    R(skin, c, 'veins', 0, 3, 0.01, 'vein strength');
    R(skin, c, 'veinScale', 0.5, 30, 0.1, 'veins / metre');
    R(skin, c, 'veinSpeed', -6, 6, 0.05, 'vein crawl');
    R(skin, c, 'veinSharp', 0, 1, 0.01, 'vein sharpness');
    R(skin, c, 'scan', 0, 3, 0.01, 'sweep strength');
    R(skin, c, 'scanSpeed', 0, 4, 0.01, 'sweeps / sec');
    R(skin, c, 'scanWidth', 0.02, 1, 0.005, 'sweep width');

    const vortex = folder.addFolder('The ribbons');
    R(vortex, c, 'ribbons', 1, 24, 1, 'ribbons at once');
    R(vortex, c, 'ribbonRate', 0.02, 4, 0.01, 're-rolls / sec');
    R(vortex, c, 'ribbonLife', 0.05, 1, 0.01, 'visible fraction');
    R(vortex, c, 'ribbonRadius', 0.1, 6, 0.01, 'vortex radius');
    R(vortex, c, 'ribbonRadiusVary', 0, 1, 0.01, 'radius variation');
    R(vortex, c, 'ribbonDepth', 0.1, 2, 0.01, 'front-to-back');
    R(vortex, c, 'ribbonFlare', 0, 1, 0.01, 'barrel');
    R(vortex, c, 'ribbonLow', -1, 1, 0.01, 'lowest point');
    R(vortex, c, 'ribbonHigh', 0, 2.5, 0.01, 'highest point');
    R(vortex, c, 'ribbonScatter', 0, 3.2, 0.01, 'bearing scatter');
    R(vortex, c, 'ribbonTurns', 0.05, 5, 0.01, 'turns per ribbon');
    R(vortex, c, 'ribbonTurnVary', 0, 1, 0.01, 'turn variation');
    R(vortex, c, 'ribbonSpin', -3, 3, 0.01, 'vortex spin');
    R(vortex, c, 'ribbonSpinVary', 0, 1, 0.01, 'spin variation');
    R(vortex, c, 'ribbonCounter', 0, 1, 0.01, 'fraction reversed');
    R(vortex, c, 'ribbonClimb', -3, 3, 0.01, 'climb / sec');

    const wander = folder.addFolder('How far a ribbon wanders');
    R(wander, c, 'ribbonWobble', 0, 2, 0.01, 'radial wander');
    R(wander, c, 'ribbonWobbleScale', 0.1, 12, 0.05, 'lobes along it');
    R(wander, c, 'ribbonWave', 0, 2, 0.01, 'vertical wander');
    R(wander, c, 'ribbonWaveScale', 0.1, 12, 0.05, 'waves along it');
    R(wander, c, 'ribbonCrawl', -4, 4, 0.01, 'wander crawl');

    const sheet = folder.addFolder('The sheet');
    R(sheet, c, 'ribbonWidth', 0.01, 2, 0.005, 'width');
    R(sheet, c, 'ribbonWidthVary', 0, 0.95, 0.01, 'width variation');
    R(sheet, c, 'ribbonTaper', 0.05, 3, 0.01, 'end taper');
    R(sheet, c, 'ribbonBank', 0, 1, 0.01, 'bank into the helix');
    R(sheet, c, 'ribbonFill', 0, 2, 0.01, 'interior wash');
    R(sheet, c, 'ribbonFillFalloff', 0.1, 8, 0.05, 'wash falloff');
    R(sheet, c, 'ribbonEdge', 0, 3, 0.01, 'lit edges');
    R(sheet, c, 'ribbonEdgeWidth', 0.01, 1, 0.01, 'edge width');
    R(sheet, c, 'ribbonGlowWidth', 1, 12, 0.05, 'halo width');
    R(sheet, c, 'ribbonGlowFalloff', 0.2, 8, 0.05, 'halo falloff');
    R(sheet, c, 'ribbonGlowOpacity', 0, 2, 0.01, 'halo opacity');
    R(sheet, c, 'ribbonWisp', 0, 1, 0.01, 'strands');
    R(sheet, c, 'ribbonWispScale', 0.1, 20, 0.1, 'strands along it');
    R(sheet, c, 'ribbonWispCross', 0, 4, 0.01, 'strands across it');
    R(sheet, c, 'ribbonWispSpeed', -4, 4, 0.01, 'strand scroll');
    R(sheet, c, 'ribbonWispSharp', 0.1, 6, 0.05, 'strand sharpness');
    R(sheet, c, 'ribbonEndFade', 0.01, 0.5, 0.005, 'tip dissolve');
    R(sheet, c, 'ribbonSoftFade', 0.02, 3, 0.01, 'soft intersection');
    R(sheet, c, 'ribbonFlicker', 0, 1, 0.01, 'brightness stutter');
    R(sheet, c, 'ribbonFlickerSpeed', 1, 120, 1, 'stutter rate');
    R(sheet, c, 'ribbonStrandFade', 0, 1, 0.01, 'ribbon dimming');
    R(sheet, c, 'ribbonGlow', 0, 8, 0.01, 'glow');
    R(sheet, c, 'ribbonOpacity', 0, 2, 0.01, 'opacity');
    sheet.addColor(c, 'colorRibbonCore').name('lit lip');
    sheet.addColor(c, 'colorRibbonInner').name('inner');
    sheet.addColor(c, 'colorRibbonOuter').name('outer');
    sheet.addColor(c, 'colorRibbonHalo').name('halo');

    const cloud = folder.addFolder('The smoke on the floor');
    R(cloud, c, 'fieldRadius', 0.2, 12, 0.05, 'radius');
    R(cloud, c, 'fieldHeight', 0, 0.5, 0.005, 'height off the floor');
    R(cloud, c, 'fieldFeather', 0.02, 1, 0.01, 'edge fade');
    R(cloud, c, 'fieldTear', 0, 0.6, 0.005, 'out of round');
    R(cloud, c, 'fieldDark', 0, 1, 0.01, 'darkness');
    R(cloud, c, 'fieldSmokeScale', 0.05, 6, 0.05, 'billows / metre');
    R(cloud, c, 'fieldSmokeContrast', 0.2, 6, 0.05, 'billow contrast');
    R(cloud, c, 'fieldSwirl', -3, 3, 0.01, 'turn / sec');
    R(cloud, c, 'fieldCurl', -3, 3, 0.01, 'shear with radius');
    R(cloud, c, 'fieldBillow', 0, 3, 0.01, 'warp');
    R(cloud, c, 'fieldCrawl', -3, 3, 0.01, 'boil');
    R(cloud, c, 'fieldPool', 0, 3, 0.01, 'pooled light');
    R(cloud, c, 'fieldPoolFalloff', 0.1, 8, 0.05, 'pool falloff');
    R(cloud, c, 'fieldRing', 0, 3, 0.01, 'ring');
    R(cloud, c, 'fieldRingWidth', 0.01, 1, 0.01, 'ring width');
    R(cloud, c, 'fieldRingSeat', 0, 1, 0.01, 'ring seat');
    R(cloud, c, 'fieldGlints', 0, 3, 0.01, 'glints');
    R(cloud, c, 'fieldGlintScale', 0.5, 20, 0.1, 'glints / metre');
    R(cloud, c, 'fieldPulse', 0, 1, 0.01, 'breathing');
    R(cloud, c, 'fieldPulseSpeed', 0.05, 8, 0.05, 'breathing rate');
    R(cloud, c, 'fieldOpacity', 0, 2, 0.01, 'opacity');
    R(cloud, c, 'fieldGlow', 0, 8, 0.01, 'glow');
    cloud.addColor(c, 'colorFieldSmoke').name('deep smoke');
    cloud.addColor(c, 'colorFieldSmokeLit').name('lit smoke');
    cloud.addColor(c, 'colorFieldPool').name('pool');
    cloud.addColor(c, 'colorFieldGlint').name('glints');

    const shed = folder.addFolder('Smoke & motes');
    R(shed, c, 'smokeRate', 0, 300, 1, 'smoke rate');
    R(shed, c, 'smokeSize', 0.05, 3, 0.01, 'smoke size');
    R(shed, c, 'smokeSpeed', 0, 8, 0.05, 'smoke speed');
    R(shed, c, 'smokeLifetime', 0.1, 8, 0.05, 'smoke lifetime');
    R(shed, c, 'smokeRise', -3, 5, 0.05, 'smoke rise');
    R(shed, c, 'smokeSpread', 0, 4, 0.05, 'release radius');
    R(shed, c, 'smokeSeat', 0, 2, 0.01, 'release height');
    R(shed, c, 'smokeTurbulence', 0, 3, 0.01, 'smoke turbulence');
    R(shed, c, 'smokeGlow', 0, 3, 0.01, 'smoke glow');
    R(shed, c, 'moteRate', 0, 500, 1, 'mote rate');
    R(shed, c, 'moteSize', 0.005, 0.4, 0.005, 'mote size');
    R(shed, c, 'moteSpeed', 0, 12, 0.05, 'mote speed');
    R(shed, c, 'moteLifetime', 0.1, 8, 0.05, 'mote lifetime');
    R(shed, c, 'moteRise', -3, 8, 0.05, 'mote rise');
    R(shed, c, 'moteRadius', 0.05, 5, 0.05, 'orbit radius');
    R(shed, c, 'moteLow', -0.5, 1.5, 0.01, 'lowest release');
    R(shed, c, 'moteHigh', 0, 2, 0.01, 'highest release');
    R(shed, c, 'moteSwirl', -6, 6, 0.05, 'orbit rate');
    R(shed, c, 'moteExpand', -1, 3, 0.01, 'orbit opening');
    R(shed, c, 'moteTurbulence', 0, 3, 0.01, 'mote turbulence');
    R(shed, c, 'moteGlow', 0, 4, 0.01, 'mote glow');
    Editor.gradient(shed, c, 'colorSmoke', 'Smoke colour');
    Editor.gradient(shed, c, 'colorMote', 'Mote colour');

    const ground = folder.addFolder('Rings under the feet');
    R(ground, c, 'groundRate', 0, 20, 0.1, 'rings / sec');
    R(ground, c, 'groundRadius', 0.05, 5, 0.05, 'ring radius');
    R(ground, c, 'groundSpread', 0, 5, 0.05, 'scatter');
    R(ground, c, 'groundLife', 0.05, 6, 0.05, 'ring lifetime');
    R(ground, c, 'groundIntensity', 0, 3, 0.01, 'ring intensity');
    ground.addColor(c, 'colorGround').name('ring');
    ground.addColor(c, 'colorGroundEmber').name('highlight');

    const light = folder.addFolder('Dynamic light');
    R(light, c, 'lightIntensity', 0, 60, 0.5, 'intensity');
    R(light, c, 'lightRadius', 1, 40, 0.5, 'radius');
    R(light, c, 'lightHeight', 0, 3, 0.01, 'height');
    R(light, c, 'lightPulse', 0, 1, 0.01, 'swell');
    R(light, c, 'lightPulseSpeed', 0.05, 6, 0.05, 'swell rate');
    light.addColor(c, 'lightColor').name('colour');

    const beats = folder.addFolder('Open & close');
    R(beats, c, 'burstMotes', 0, 800, 1, 'motes on opening');
    R(beats, c, 'ringRadius', 0.5, 20, 0.1, 'shockwave radius');
    R(beats, c, 'activateFlash', 0, 2, 0.01, 'flash on opening');
    R(beats, c, 'endFlash', 0, 2, 0.01, 'flash on closing');
    R(beats, c, 'activateShake', 0, 4, 0.01, 'shake on opening');
    R(beats, c, 'shakeDuration', 0.05, 3, 0.01, 'shake duration');
    R(beats, c, 'rumble', 0, 0.4, 0.001, 'rumble while held');
    beats.addColor(c, 'colorFlash').name('flash colour');
  }

  _buildFire() {
    const folder = this.gui.addFolder('♨  Fire Boost');
    const c = settings.fire;
    const R = Editor.range;

    const buff = folder.addFolder('The buff');
    R(buff, c, 'duration', 1, 60, 0.1, 'duration');
    R(buff, c, 'rampIn', 0.05, 4, 0.01, 'ramp in');
    R(buff, c, 'rampOut', 0.05, 6, 0.01, 'burn down');
    R(buff, c, 'cooldown', 0, 20, 0.05, 'cooldown');
    buff.add(c, 'playAnimation').name('throw a clip');
    Editor.castAnimation(buff, c);

    // The same patch on the character's own materials the other two buffs use,
    // shaded as heat from this block — so these apply to a rig that is already
    // burning, including a paused one.
    const rim = folder.addFolder('Fresnel mask on the character');
    R(rim, c, 'fresnel', 0, 3, 0.01, 'rim strength');
    R(rim, c, 'fresnelPower', 0.2, 8, 0.05, 'rim tightness');
    R(rim, c, 'fresnelBias', 0, 1, 0.005, 'body heat');
    R(rim, c, 'fresnelGlow', 0, 8, 0.05, 'glow');
    R(rim, c, 'fresnelPulse', 0, 1, 0.01, 'breathing');
    R(rim, c, 'fresnelPulseSpeed', 0.1, 12, 0.05, 'breathing rate');
    R(rim, c, 'fresnelFlicker', 0, 1, 0.01, 'gutter');
    R(rim, c, 'fresnelFlickerSpeed', 1, 90, 1, 'gutter rate');
    rim.addColor(c, 'colorRim').name('rim');
    rim.addColor(c, 'colorCore').name('rim core');
    rim.addColor(c, 'colorVein').name('veins');

    const skin = folder.addFolder('Veins & sweep');
    R(skin, c, 'veins', 0, 3, 0.01, 'vein strength');
    R(skin, c, 'veinScale', 0.5, 30, 0.1, 'veins / metre');
    R(skin, c, 'veinSpeed', -6, 6, 0.05, 'vein crawl');
    R(skin, c, 'veinSharp', 0, 1, 0.01, 'vein sharpness');
    R(skin, c, 'scan', 0, 3, 0.01, 'sweep strength');
    R(skin, c, 'scanSpeed', 0, 4, 0.01, 'sweeps / sec');
    R(skin, c, 'scanWidth', 0.02, 1, 0.005, 'sweep width');

    // No capsule: the tongues are rooted on the rig's own limb segments, so the
    // only thing the shape needs is how thick a limb is taken to be.
    const skeleton = folder.addFolder('The skeleton the fire is rooted on');
    R(skeleton, c, 'boneThickness', 0, 4, 0.01, 'limb thickness');

    const tongues = folder.addFolder('The tongues');
    R(tongues, c, 'flames', 1, 96, 1, 'tongues at once');
    R(tongues, c, 'flameRate', 0.05, 6, 0.01, 're-rolls / sec');
    R(tongues, c, 'flameLife', 0.05, 1, 0.01, 'burning fraction');
    R(tongues, c, 'flameSprout', 0, 1, 0.01, 'length when it catches');
    R(tongues, c, 'flameLength', 0.05, 3, 0.01, 'length');
    R(tongues, c, 'flameLengthVary', 0, 0.95, 0.01, 'length variation');
    // The three that weld the fire to the rig. Drop `cling to the limb` to 0
    // and a tongue leaves the skin straight up, which is the old shape.
    R(tongues, c, 'flameBend', 0.2, 6, 0.05, 'cling to the limb');
    R(tongues, c, 'flameLimbTaper', 0, 1, 0.01, 'size follows the limb');
    R(tongues, c, 'flameWrap', -6, 6, 0.05, 'wind about the limb');
    R(tongues, c, 'flameLean', 0, 1.5, 0.01, 'lean off the body');
    R(tongues, c, 'flameClimb', -2, 3, 0.01, 'climb / sec');
    R(tongues, c, 'flameOffset', 0, 0.4, 0.005, 'root off the skin');
    R(tongues, c, 'flameSway', 0, 1, 0.005, 'tip wander');
    R(tongues, c, 'flameSwayPower', 0.1, 5, 0.05, 'wander held to root');
    R(tongues, c, 'flameSwayScale', 0.1, 12, 0.05, 'waves along it');
    R(tongues, c, 'flameSwaySpeed', -6, 6, 0.05, 'wander travel');

    const sheet = folder.addFolder('The sheet a tongue is drawn on');
    R(sheet, c, 'flameWidth', 0.005, 1, 0.005, 'width at the root');
    R(sheet, c, 'flameWidthVary', 0, 0.95, 0.01, 'width variation');
    R(sheet, c, 'flameTaper', 0.05, 4, 0.01, 'tip taper');
    R(sheet, c, 'flameRootPinch', 0.01, 0.6, 0.005, 'root pinch');
    R(sheet, c, 'flameBank', 0, 1, 0.01, 'stand off the skin');
    R(sheet, c, 'flameSharp', 0.1, 6, 0.05, 'cross falloff');
    R(sheet, c, 'flameGlowWidth', 1, 12, 0.05, 'heat width');
    R(sheet, c, 'flameGlowFalloff', 0.2, 8, 0.05, 'heat falloff');
    R(sheet, c, 'flameGlowOpacity', 0, 2, 0.01, 'heat opacity');
    R(sheet, c, 'flameTear', 0, 1, 0.01, 'tearing');
    R(sheet, c, 'flameTearScale', 0.1, 20, 0.1, 'licks along it');
    R(sheet, c, 'flameTearCross', 0, 4, 0.01, 'licks across it');
    R(sheet, c, 'flameTearSpeed', -4, 4, 0.01, 'lick travel');
    R(sheet, c, 'flameTearBias', 0, 1.5, 0.01, 'where tearing starts');
    R(sheet, c, 'flameHeat', 0, 4, 0.01, 'heat');
    R(sheet, c, 'flameCoreSize', 0.05, 4, 0.01, 'white core');
    R(sheet, c, 'flameSmoke', 0, 2, 0.01, 'smoke in the voids');
    R(sheet, c, 'flameFlicker', 0, 1, 0.01, 'gutter');
    R(sheet, c, 'flameFlickerSpeed', 1, 120, 1, 'gutter rate');
    R(sheet, c, 'flameStrandFade', 0, 1, 0.01, 'tongue dimming');
    R(sheet, c, 'flameSoftFade', 0.02, 3, 0.01, 'soft intersection');
    R(sheet, c, 'flameGlow', 0, 8, 0.01, 'glow');
    R(sheet, c, 'flameOpacity', 0, 2, 0.01, 'opacity');
    sheet.addColor(c, 'colorFlameCore').name('core');
    sheet.addColor(c, 'colorFlameBody').name('flame');
    sheet.addColor(c, 'colorFlameEmber').name('ember');
    sheet.addColor(c, 'colorFlameSmoke').name('voids');

    const orbit = folder.addFolder('The orbs');
    R(orbit, c, 'orbs', 0, 16, 1, 'orbs at once');
    // At 1 the six ring sliders below do nothing: the orbs are wound about the
    // bones instead. The three under it are the helix that replaces them.
    R(orbit, c, 'orbCling', 0, 1, 0.01, 'ride the bones');
    R(orbit, c, 'orbCloud', 0, 0.6, 0.005, 'helix off the limb');
    R(orbit, c, 'orbSpiral', -2, 2, 0.01, 'slides along it / sec');
    R(orbit, c, 'orbWhip', 0, 8, 0.05, 'whip around it');
    R(orbit, c, 'orbRadius', 0.1, 5, 0.01, 'ring radius');
    R(orbit, c, 'orbRadiusVary', 0, 1, 0.01, 'radius variation');
    R(orbit, c, 'orbSeat', -0.2, 1.6, 0.01, 'ring height');
    R(orbit, c, 'orbTilt', 0, 1.6, 0.01, 'ring lean');
    R(orbit, c, 'orbPrecess', -1, 1, 0.005, 'precession / sec');
    R(orbit, c, 'orbRate', -3, 3, 0.01, 'turns / sec');
    R(orbit, c, 'orbRateVary', 0, 1, 0.01, 'rate variation');
    R(orbit, c, 'orbBob', 0, 1, 0.005, 'bob');
    R(orbit, c, 'orbBobRate', 0, 4, 0.01, 'bob rate');
    R(orbit, c, 'orbSize', 0.01, 0.8, 0.005, 'orb radius');
    R(orbit, c, 'orbSizeVary', 0, 1, 0.01, 'size variation');
    R(orbit, c, 'orbStretch', 0, 3, 0.01, 'stretch along travel');

    const ball = folder.addFolder('How an orb burns');
    R(ball, c, 'orbFalloff', 0.05, 4, 0.01, 'edge falloff');
    R(ball, c, 'orbRim', 0, 3, 0.01, 'hot rim');
    R(ball, c, 'orbRimPower', 0.2, 8, 0.05, 'rim tightness');
    R(ball, c, 'orbCells', 0, 1, 0.01, 'convection');
    R(ball, c, 'orbCellScale', 0.2, 12, 0.05, 'cells per orb');
    R(ball, c, 'orbCellWarp', 0, 2, 0.01, 'cell warp');
    R(ball, c, 'orbBoil', -4, 4, 0.01, 'boil');
    R(ball, c, 'orbHeat', 0, 4, 0.01, 'heat');
    R(ball, c, 'orbCoreSize', 0.05, 4, 0.01, 'white core');
    R(ball, c, 'orbCoronaSize', 1, 8, 0.05, 'corona size');
    R(ball, c, 'orbCoronaFalloff', 0.05, 6, 0.05, 'corona falloff');
    R(ball, c, 'orbCoronaOpacity', 0, 2, 0.01, 'corona opacity');
    R(ball, c, 'orbFlicker', 0, 1, 0.01, 'gutter');
    R(ball, c, 'orbFlickerSpeed', 1, 120, 1, 'gutter rate');
    R(ball, c, 'orbGlow', 0, 8, 0.01, 'glow');
    R(ball, c, 'orbOpacity', 0, 2, 0.01, 'opacity');
    R(ball, c, 'orbEmberRate', 0, 800, 1, 'embers / sec');
    R(ball, c, 'orbEmberSpeed', 0, 8, 0.05, 'ember speed');
    ball.addColor(c, 'colorOrbCore').name('core');
    ball.addColor(c, 'colorOrbFlame').name('flame');
    ball.addColor(c, 'colorOrbEmber').name('ember');
    ball.addColor(c, 'colorOrbSmoke').name('shadow');

    // The wake is the orbit sampled backward in time, so every control in the
    // folder above re-sweeps it live — including with the clock stopped.
    const wake = folder.addFolder('The trails');
    R(wake, c, 'trailSpan', 0.05, 4, 0.01, 'seconds of wake');
    R(wake, c, 'trailRise', -2, 4, 0.01, 'lift / sec');
    R(wake, c, 'trailWander', 0, 2, 0.01, 'fray');
    R(wake, c, 'trailWanderScale', 0.1, 12, 0.05, 'fray scale');
    R(wake, c, 'trailWanderSpeed', -4, 4, 0.01, 'fray travel');
    R(wake, c, 'trailWidth', 0.05, 6, 0.01, 'width at the head');
    R(wake, c, 'trailTaper', 0.05, 4, 0.01, 'tail taper');
    R(wake, c, 'trailHeadSwell', 0, 3, 0.01, 'head swell');
    R(wake, c, 'trailSharp', 0.1, 6, 0.05, 'cross falloff');
    R(wake, c, 'trailGlowWidth', 1, 12, 0.05, 'halo width');
    R(wake, c, 'trailGlowFalloff', 0.2, 8, 0.05, 'halo falloff');
    R(wake, c, 'trailGlowOpacity', 0, 2, 0.01, 'halo opacity');
    R(wake, c, 'trailTear', 0, 1, 0.01, 'tearing');
    R(wake, c, 'trailTearScale', 0.1, 20, 0.1, 'puffs along it');
    R(wake, c, 'trailTearSpeed', -4, 4, 0.01, 'puff travel');
    R(wake, c, 'trailTearBias', 0, 1.5, 0.01, 'where tearing starts');
    R(wake, c, 'trailHeat', 0, 4, 0.01, 'heat');
    R(wake, c, 'trailCoreSize', 0.05, 4, 0.01, 'white core');
    R(wake, c, 'trailCool', 0.05, 6, 0.05, 'cooling with age');
    R(wake, c, 'trailEndFade', 0.01, 0.9, 0.01, 'tail dissolve');
    R(wake, c, 'trailFlicker', 0, 1, 0.01, 'gutter');
    R(wake, c, 'trailFlickerSpeed', 1, 120, 1, 'gutter rate');
    R(wake, c, 'trailSoftFade', 0.02, 3, 0.01, 'soft intersection');
    R(wake, c, 'trailGlow', 0, 8, 0.01, 'glow');
    R(wake, c, 'trailOpacity', 0, 2, 0.01, 'opacity');
    wake.addColor(c, 'colorTrailCore').name('core');
    wake.addColor(c, 'colorTrailFlame').name('flame');
    wake.addColor(c, 'colorTrailEmber').name('ember');
    wake.addColor(c, 'colorTrailSmoke').name('voids');

    const burn = folder.addFolder('The burn on the floor');
    R(burn, c, 'fieldRadius', 0.2, 12, 0.05, 'radius');
    R(burn, c, 'fieldHeight', 0, 0.5, 0.005, 'height off the floor');
    R(burn, c, 'fieldFeather', 0.02, 1.5, 0.01, 'edge fade');
    R(burn, c, 'fieldTear', 0, 0.6, 0.005, 'out of round');
    R(burn, c, 'fieldChar', 0, 1, 0.01, 'char');
    R(burn, c, 'fieldCharScale', 0.05, 6, 0.05, 'char grain');
    R(burn, c, 'fieldCharContrast', 0.2, 6, 0.05, 'char contrast');
    R(burn, c, 'fieldCrackScale', 0.1, 8, 0.05, 'splits / metre');
    R(burn, c, 'fieldCrackWidth', 0.01, 0.6, 0.005, 'split width');
    R(burn, c, 'fieldCracks', 0, 4, 0.01, 'split brightness');
    R(burn, c, 'fieldWarp', 0, 3, 0.01, 'warp');
    R(burn, c, 'fieldCrawl', -3, 3, 0.01, 'crust crawl');
    R(burn, c, 'fieldEmbers', 0, 4, 0.01, 'embers');
    R(burn, c, 'fieldEmberScale', 0.5, 20, 0.1, 'embers / metre');
    R(burn, c, 'fieldRing', 0, 4, 0.01, 'burning lip');
    R(burn, c, 'fieldRingWidth', 0.01, 1, 0.01, 'lip width');
    R(burn, c, 'fieldSweep', 0, 1, 0.01, 'lip sweep');
    R(burn, c, 'fieldSweepSpeed', -2, 2, 0.01, 'sweep / sec');
    R(burn, c, 'fieldFalloff', 0.1, 8, 0.05, 'light falloff');
    R(burn, c, 'fieldPulse', 0, 1, 0.01, 'breathing');
    R(burn, c, 'fieldPulseSpeed', 0.05, 8, 0.05, 'breathing rate');
    R(burn, c, 'fieldOpacity', 0, 2, 0.01, 'opacity');
    R(burn, c, 'fieldGlow', 0, 8, 0.01, 'glow');
    burn.addColor(c, 'colorFieldChar').name('char');
    burn.addColor(c, 'colorFieldCrack').name('splits');
    burn.addColor(c, 'colorFieldEmber').name('embers');
    burn.addColor(c, 'colorFieldRing').name('lip');

    const shed = folder.addFolder('Embers & smoke');
    R(shed, c, 'emberRate', 0, 900, 1, 'ember rate');
    R(shed, c, 'emberSize', 0.005, 0.4, 0.005, 'ember size');
    R(shed, c, 'emberSpeed', 0, 12, 0.05, 'ember speed');
    R(shed, c, 'emberLifetime', 0.1, 8, 0.05, 'ember lifetime');
    R(shed, c, 'emberRise', -3, 8, 0.05, 'ember rise');
    R(shed, c, 'emberTurbulence', 0, 3, 0.01, 'ember turbulence');
    R(shed, c, 'emberGlow', 0, 4, 0.01, 'ember glow');
    R(shed, c, 'smokeRate', 0, 300, 1, 'smoke rate');
    R(shed, c, 'smokeSize', 0.05, 3, 0.01, 'smoke size');
    R(shed, c, 'smokeSpeed', 0, 8, 0.05, 'smoke speed');
    R(shed, c, 'smokeLifetime', 0.1, 8, 0.05, 'smoke lifetime');
    R(shed, c, 'smokeRise', -3, 5, 0.05, 'smoke rise');
    R(shed, c, 'smokeTurbulence', 0, 3, 0.01, 'smoke turbulence');
    R(shed, c, 'smokeGlow', 0, 3, 0.01, 'smoke glow');
    Editor.gradient(shed, c, 'colorEmber', 'Ember colour');
    Editor.gradient(shed, c, 'colorSmoke', 'Smoke colour');

    const ground = folder.addFolder('Scorches under the feet');
    R(ground, c, 'groundRate', 0, 20, 0.1, 'scorches / sec');
    R(ground, c, 'groundRadius', 0.05, 5, 0.05, 'scorch radius');
    R(ground, c, 'groundSpread', 0, 5, 0.05, 'scatter');
    R(ground, c, 'groundLife', 0.05, 8, 0.05, 'scorch lifetime');
    R(ground, c, 'groundIntensity', 0, 3, 0.01, 'intensity');
    ground.addColor(c, 'colorGround').name('burn');
    ground.addColor(c, 'colorGroundEmber').name('embers');

    const light = folder.addFolder('Dynamic light');
    R(light, c, 'lightIntensity', 0, 60, 0.5, 'intensity');
    R(light, c, 'lightRadius', 1, 40, 0.5, 'radius');
    R(light, c, 'lightHeight', 0, 3, 0.01, 'height');
    R(light, c, 'lightFlicker', 0, 1, 0.01, 'gutter');
    R(light, c, 'lightFlickerSpeed', 0.5, 40, 0.5, 'gutter rate');
    light.addColor(c, 'lightColor').name('colour');

    const beats = folder.addFolder('Catch & burn out');
    R(beats, c, 'burstEmbers', 0, 800, 1, 'embers on ignition');
    R(beats, c, 'burstSpread', 0.05, 3, 0.01, 'ember release radius');
    R(beats, c, 'ringRadius', 0.5, 20, 0.1, 'shockwave radius');
    R(beats, c, 'activateFlash', 0, 2, 0.01, 'flash on ignition');
    R(beats, c, 'endFlash', 0, 2, 0.01, 'flash on burn out');
    R(beats, c, 'endSmoke', 0, 400, 1, 'smoke on burn out');
    R(beats, c, 'activateShake', 0, 4, 0.01, 'shake on ignition');
    R(beats, c, 'shakeDuration', 0.05, 3, 0.01, 'shake duration');
    R(beats, c, 'rumble', 0, 0.4, 0.001, 'rumble while held');
    beats.addColor(c, 'colorFlash').name('flash colour');
  }

  _buildEnvironment() {
    const folder = this.gui.addFolder('Environment');
    const e = settings.environment;
    const R = Editor.range;

    R(folder, e, 'sunIntensity', 0, 8, 0.01, 'key intensity');
    folder.addColor(e, 'sunColor').name('key colour');
    R(folder, e, 'sunAzimuth', 0, Math.PI * 2, 0.01, 'key azimuth');
    R(folder, e, 'sunElevation', 0.05, 1.5, 0.01, 'key elevation');
    R(folder, e, 'ambientIntensity', 0, 3, 0.01, 'ambient');
    folder.addColor(e, 'ambientColor').name('ambient colour');
    R(folder, e, 'hemiIntensity', 0, 3, 0.01, 'hemisphere');
    R(folder, e, 'envIntensity', 0, 3, 0.01, 'env (IBL)');
    R(folder, e, 'shadowRadius', 0, 8, 0.05, 'shadow softness');
    R(folder, e, 'shadowBias', -0.01, 0.001, 0.0001, 'shadow bias');
    R(folder, e, 'contactShadow', 0, 1.5, 0.01, 'contact shadow');

    const rim = folder.addFolder('Rim light');
    R(rim, e, 'rimIntensity', 0, 4, 0.01, 'rim intensity');
    rim.addColor(e, 'rimColor').name('rim colour');
    R(rim, e, 'rimAzimuth', 0, Math.PI * 2, 0.01, 'rim azimuth');
    R(rim, e, 'rimElevation', 0.05, 1.5, 0.01, 'rim elevation');
    rim.addColor(e, 'hemiSkyColor').name('hemi sky');
    rim.addColor(e, 'hemiGroundColor').name('hemi bounce');

    const fog = folder.addFolder('Backdrop, fog & dust');
    fog.addColor(e, 'backgroundColor').name('backdrop');
    fog.add(e, 'fogEnabled').name('fog enabled');
    fog.addColor(e, 'fogColor').name('fog colour');
    // near = where the fog starts, far = where it is total; widening the gap or
    // pushing both out thins the fog, closing it thickens it.
    R(fog, e, 'fogNear', 1, 200, 1, 'fog near');
    R(fog, e, 'fogFar', 10, 400, 1, 'fog far');
    R(fog, e, 'dustAmount', 0, 3, 0.01, 'floating dust');

    const floor = folder.addFolder('Stage floor');
    floor.add(e, 'floorTexture').name('stone tile');
    R(floor, e, 'floorTextureScale', 0.5, 24, 0.1, 'tile size (m)');
    R(floor, e, 'floorNormalScale', 0, 3, 0.01, 'relief strength');
    R(floor, e, 'floorTexTint', 0, 1, 0.01, 'tint toward floor');
    floor.addColor(e, 'floorColor').name('floor colour');
    floor.addColor(e, 'floorTint').name('floor tint');
    R(floor, e, 'floorRoughness', 0.05, 1, 0.01, 'roughness');
    R(floor, e, 'floorSheen', 0, 1, 0.01, 'sheen');
    R(floor, e, 'floorPool', 0, 1, 0.01, 'light pool');
  }

  _buildPost() {
    const folder = this.gui.addFolder('Post processing');
    const p = settings.post;
    const R = Editor.range;

    folder.add(p, 'enabled').name('enabled');
    R(folder, p, 'exposure', 0.1, 3, 0.01, 'exposure');
    R(folder, p, 'bloomStrength', 0, 3, 0.01, 'bloom intensity');
    R(folder, p, 'bloomRadius', 0, 1.5, 0.01, 'bloom radius');
    R(folder, p, 'bloomThreshold', 0, 2, 0.01, 'bloom threshold');
    R(folder, p, 'contrast', 0.5, 2, 0.01, 'contrast');
    R(folder, p, 'saturation', 0, 2.5, 0.01, 'saturation');
    R(folder, p, 'temperature', -0.5, 0.5, 0.01, 'temperature');
    R(folder, p, 'lift', -0.2, 0.2, 0.005, 'lift');
    R(folder, p, 'gain', 0.5, 2, 0.01, 'gain');
    R(folder, p, 'vignette', 0, 1.5, 0.01, 'vignette');
    R(folder, p, 'chromaticAberration', 0, 3, 0.01, 'chromatic aberration');
    R(folder, p, 'grain', 0, 0.2, 0.001, 'film grain');
    R(folder, p, 'distortion', 0, 0.2, 0.001, 'screen warp');
    R(folder, p, 'flashStrength', 0, 2, 0.01, 'impact flash');
  }

  _buildCamera() {
    const folder = this.gui.addFolder('Camera');
    const c = settings.camera;
    const R = Editor.range;

    // The wheel writes `distance` straight into settings, so the slider listens.
    R(folder, c, 'distance', 1, 40, 0.1, 'distance').listen();
    R(folder, c, 'minDistance', 1, 20, 0.1, 'min distance');
    R(folder, c, 'maxDistance', 4, 40, 0.1, 'max distance');
    R(folder, c, 'zoomSpeed', 0.1, 3, 0.01, 'zoom speed');
    R(folder, c, 'fov', 20, 90, 0.5, 'field of view');
    R(folder, c, 'targetHeight', 0, 4, 0.01, 'target height');
    R(folder, c, 'minPolar', 0.05, 1.5, 0.01, 'min pitch');
    R(folder, c, 'maxPolar', 0.2, 1.55, 0.01, 'max pitch');
    R(folder, c, 'damping', 0.001, 0.5, 0.001, 'follow damping');
    R(folder, c, 'autoFrame', 0, 1, 0.01, 'auto framing');

    folder.add({ clear: () => this.hooks.onClear?.() }, 'clear').name('Clear effects (C)');
  }

  _buildCharacter() {
    const folder = this.gui.addFolder('Character');
    const c = settings.character;
    const R = Editor.range;

    // The mixer's own rate, so it scales the idle and the cast clips together.
    // The same value as Global → animation speed, mirrored here where it is
    // actually reached for; `listen` keeps the two readouts honest.
    R(folder, settings.global, 'animationSpeed', 0.1, 3, 0.01, 'playback rate').listen();

    // Which clip each ability throws lives in that ability's own folder, under
    // "The cast"; these are the edges of the blend that lays it over the idle.
    const cast = folder.addFolder('Casting');
    R(cast, c, 'castBlendIn', 0.01, 1, 0.01, 'blend into cast');
    R(cast, c, 'castBlendOut', 0.01, 1.5, 0.01, 'blend back to idle');
    cast.add(c, 'turnToAim').name('turn to aim');
    R(cast, c, 'turnRate', 0.000001, 0.02, 0.000001, 'turn follow');

    // The procedural accent that rides on top of the clip. Zero both leans to
    // let the animation carry the cast on its own.
    const lunge = folder.addFolder('Lunge');
    R(lunge, c, 'castLean', 0, 1.2, 0.01, 'lunge lean');
    R(lunge, c, 'castRecoil', 0, 0.8, 0.005, 'lunge recoil');
    R(lunge, c, 'castSettle', 0.2, 8, 0.05, 'lunge settle');
  }

  dispose() {
    this.gui.destroy();
  }
}

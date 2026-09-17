import { LoadingManager, TextureLoader } from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';

/**
 * A 1×1 opaque white PNG.
 *
 * Authoring tools bake absolute local texture paths into FBX files (this model
 * points at `C:/Users/.../textures/...`). Those requests can never resolve from
 * a web server, so they are redirected here: the material keeps a neutral map
 * instead of a permanently pending texture, and the console stays clean.
 */
export const PLACEHOLDER_TEXTURE_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

/** Matches a drive-letter or UNC path that leaked into an asset reference. */
const ABSOLUTE_LOCAL_PATH = /(^|\/)[A-Za-z]:[\\/]|^\\\\/;

/** Matches a final path segment that carries a file extension. */
const HAS_EXTENSION = /\/?[^/]+\.[A-Za-z0-9]{2,5}(\?.*)?$/;

/**
 * True for an asset reference that can never resolve.
 *
 * Two flavours show up in these FBX files: absolute authoring-machine paths,
 * and bare embedded-texture names with no extension at all (`./models/Image_0`,
 * what the exporter writes for packed textures). Both get the placeholder, so
 * the material keeps a neutral map and the console stays clean instead of
 * firing a 404 per reference. Everything the app loads by hand — the models,
 * the HDRI, the ground textures — names a real file with an extension and is
 * passed through untouched.
 */
function isUnresolvable(url) {
  if (url.startsWith('data:') || url.startsWith('blob:')) return false;
  return ABSOLUTE_LOCAL_PATH.test(url) || !HAS_EXTENSION.test(url);
}

/**
 * Central asset loading with a single progress stream.
 *
 * Every loader shares one LoadingManager so the boot screen can report real
 * aggregate progress instead of guessing.
 */
export class AssetLoader {
  constructor() {
    this.manager = new LoadingManager();
    this.manager.setURLModifier((url) =>
      isUnresolvable(url) ? PLACEHOLDER_TEXTURE_URL : url
    );

    this.fbx = new FBXLoader(this.manager);
    this.gltf = new GLTFLoader(this.manager);
    this.hdr = new HDRLoader(this.manager);
    this.texture = new TextureLoader(this.manager);

    this._onProgress = null;
    this._loaded = 0;
    this._total = 0;
    this._settleWaiters = [];

    this.manager.onStart = (url, loaded, total) => {
      this._loaded = loaded;
      this._total = total;
    };
    this.manager.onProgress = (url, loaded, total) => {
      this._loaded = loaded;
      this._total = total;
      this._onProgress?.(total ? loaded / total : 0, url);
    };
    this.manager.onLoad = () => {
      this._loaded = this._total;
      this._settleWaiters.splice(0).forEach((resolve) => resolve());
    };
    this.manager.onError = (url) => console.error(`[AssetLoader] failed: ${url}`);
  }

  onProgress(callback) {
    this._onProgress = callback;
  }

  /**
   * Resolves once every queued request has settled.
   *
   * Loaders resolve as soon as the *model* is parsed; its textures are still in
   * flight at that point, so anything that inspects `texture.image` has to wait
   * for this first or it will read a half-initialised texture.
   */
  settled() {
    if (this._total === 0 || this._loaded >= this._total) return Promise.resolve();
    return new Promise((resolve) => this._settleWaiters.push(resolve));
  }

  /** @returns {Promise<THREE.Group>} */
  loadFBX(url) {
    return new Promise((resolve, reject) => {
      this.fbx.load(
        encodeURI(url),
        resolve,
        (event) => {
          if (event.lengthComputable) this._onProgress?.(event.loaded / event.total, url);
        },
        reject
      );
    });
  }

  /**
   * Load a glTF/GLB.
   *
   * Unlike the FBX path this needs no help from the URL modifier: a GLB carries
   * its images inline as buffer views, so there are no authoring-machine paths
   * to redirect and no extensionless names to stand in for.
   *
   * @returns {Promise<{scene: THREE.Group, animations: THREE.AnimationClip[]}>}
   */
  loadGLTF(url) {
    return new Promise((resolve, reject) => {
      this.gltf.load(encodeURI(url), resolve, undefined, reject);
    });
  }

  /** @returns {Promise<THREE.Texture>} */
  loadTexture(url) {
    return new Promise((resolve, reject) => {
      this.texture.load(encodeURI(url), resolve, undefined, reject);
    });
  }

  /** @returns {Promise<THREE.DataTexture>} */
  loadHDR(url) {
    return new Promise((resolve, reject) => {
      this.hdr.load(encodeURI(url), resolve, undefined, reject);
    });
  }
}

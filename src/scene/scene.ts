import {
  Color,
  DirectionalLight,
  HemisphereLight,
  type Mesh,
  PerspectiveCamera,
  Scene,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createMeshSurface, type Heightfield, type MeshSurface } from './heightfield';
import { createTerrainMesh } from './terrain';
import { CAMERA_FOV_DEG, computeViews, minCameraY, type ViewName } from './views';

export type FrameCallback = (deltaMs: number) => void;

/** What #12 to #14 attach to. They never reach into this file's internals. */
export interface SceneHandle {
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  readonly renderer: WebGLRenderer;
  readonly controls: OrbitControls;
  readonly terrain: Mesh;
  readonly surface: MeshSurface;
  setView(name: ViewName): void;
  /** Registers a per-frame callback; returns an unsubscribe function. */
  onFrame(callback: FrameCallback): () => void;
  /** Stops the loop and releases geometry, material, renderer, controls and the resize observer. */
  dispose(): void;
}

/** Maximum polar angle (radians from straight up): just under horizontal, so the camera stays above the target plane. */
const MAX_POLAR_ANGLE = Math.PI / 2 - 0.05;
const BACKGROUND_COLOR = 0x9db4c8;

export function createScene(container: HTMLElement, field: Heightfield): SceneHandle {
  const surface = createMeshSurface(field);
  const renderer = new WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  container.appendChild(renderer.domElement);

  const scene = new Scene();
  scene.background = new Color(BACKGROUND_COLOR);
  const terrain = createTerrainMesh(surface);
  scene.add(terrain);

  scene.add(new HemisphereLight(0xdde8ff, 0x3a3a30, 1.2));
  // From the south-west at low elevation, so lift corridors read as terrain shape. No shadows (cost).
  const sun = new DirectionalLight(0xfff2dd, 2.2);
  sun.position.set(-1, 0.45, 1).normalize().multiplyScalar(1000);
  scene.add(sun);

  const aspectOf = () => container.clientWidth / Math.max(container.clientHeight, 1);
  const initial = computeViews(surface, aspectOf());
  const camera = new PerspectiveCamera(CAMERA_FOV_DEG, aspectOf(), initial.near, initial.far);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.maxPolarAngle = MAX_POLAR_ANGLE;
  controls.minDistance = 50;
  controls.maxDistance = initial.far * 0.9;

  const setView = (name: ViewName): void => {
    const set = computeViews(surface, aspectOf());
    const view = set.views[name];
    camera.near = set.near;
    camera.far = set.far;
    camera.up.copy(view.up);
    camera.position.copy(view.position);
    controls.target.copy(view.target);
    camera.lookAt(view.target);
    camera.updateProjectionMatrix();
    controls.update();
  };
  setView('overview');

  const resize = (): void => {
    renderer.setSize(container.clientWidth, container.clientHeight);
    camera.aspect = aspectOf();
    camera.updateProjectionMatrix();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(container);

  const callbacks = new Set<FrameCallback>();
  let last = performance.now();
  let logged = false;
  renderer.setAnimationLoop((now: number) => {
    controls.update();
    const floor = minCameraY(surface, camera.position.x, camera.position.z);
    if (camera.position.y < floor) camera.position.y = floor;
    for (const callback of callbacks) callback(now - last);
    last = now;
    renderer.render(scene, camera);
    if (!logged) {
      logged = true;
      console.info('terrain mesh', {
        triangles: renderer.info.render.triangles,
        calls: renderer.info.render.calls,
      });
    }
  });

  return {
    scene,
    camera,
    renderer,
    controls,
    terrain,
    surface,
    setView,
    onFrame(callback) {
      callbacks.add(callback);
      return () => callbacks.delete(callback);
    },
    dispose() {
      renderer.setAnimationLoop(null);
      observer.disconnect();
      controls.dispose();
      terrain.geometry.dispose();
      (terrain.material as { dispose(): void }).dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}

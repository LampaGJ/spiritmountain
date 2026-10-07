import {
  Color,
  DirectionalLight,
  HemisphereLight,
  type MeshStandardMaterial,
  type ColorRepresentation,
  type Mesh,
  PerspectiveCamera,
  Scene,
  type Texture,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createMeshSurface, type Heightfield, type MeshSurface } from './heightfield';
import { setFadeCentre } from './fade';
import { createGround, groundSlopeColor } from './ground';
import { createSkyControl, SKY_FALLBACK_COLOR } from './sky';
import { createTerrainMesh, setTerrainImagery, terrainFade } from './terrain';
import { computeViews, minCameraY, verticalFovDeg, type FocusBox, type ViewName } from './views';

export type FrameCallback = (deltaMs: number) => void;

/** What #12 to #14 attach to. They never reach into this file's internals. */
export interface SceneHandle {
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  readonly renderer: WebGLRenderer;
  readonly controls: OrbitControls;
  readonly terrain: Mesh;
  readonly surface: MeshSurface;
  /** Moves the camera to a named view. A focus box is remembered and reused by later calls without one. */
  setView(name: ViewName, focus?: FocusBox): void;
  /** Shows the texture on the terrain, or restores slope shading with null. */
  setImagery(texture: Texture | null): void;
  /** Photo sky as background and environment light; the sun and hemisphere are trimmed so it is not blown out. */
  setSky(texture: Texture): void;
  /** Restores the flat sky colour, no environment, and the original light intensities. */
  setSkyFallback(): void;
  /** Installs (or replaces) the opaque ground plane at base elevation minus 0.5 m, beyond the faded terrain, in a linear-light colour. */
  setGround(colorLinear: { r: number; g: number; b: number }, baseElevationM: number): void;
  /** Re-tints the ground: the photo mean (colour) or the slope-shading mid colour (null). */
  setGroundColor(color: ColorRepresentation | null): void;
  /** Moves the radial fade centre of the centre terrain (local metres east and north). */
  setFadeCentre(centre: { readonly east: number; readonly north: number }): void;
  /**
   * Makes room for geometry that reaches radiusM beyond the centre tile (the context ring): the camera far plane
   * grows by 2 x radiusM, the same rule computeViews applies to the centre tile's own radius, and controls.maxDistance follows.
   */
  setContextExtent(radiusM: number): void;
  /** Registers a per-frame callback; returns an unsubscribe function. */
  onFrame(callback: FrameCallback): () => void;
  /** Stops the loop and releases geometry, material, renderer, controls and the resize observer. */
  dispose(): void;
}

/** Maximum polar angle (radians from straight up): just under horizontal, so the camera stays above the target plane. */
const MAX_POLAR_ANGLE = Math.PI / 2 - 0.05;

export function createScene(container: HTMLElement, field: Heightfield): SceneHandle {
  const surface = createMeshSurface(field);
  const renderer = new WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  container.appendChild(renderer.domElement);

  const scene = new Scene();
  scene.background = new Color(SKY_FALLBACK_COLOR);
  const terrain = createTerrainMesh(surface);
  scene.add(terrain);

  const hemisphere = new HemisphereLight(0xdde8ff, 0x3a3a30, 1.2);
  scene.add(hemisphere);
  // From the south-west at low elevation, so lift corridors read as terrain shape. No shadows (cost).
  const sun = new DirectionalLight(0xfff2dd, 2.2);
  sun.position.set(-1, 0.45, 1).normalize().multiplyScalar(1000);
  scene.add(sun);
  const sky = createSkyControl(scene, { sun, hemisphere });
  let ground: Mesh | null = null;

  const aspectOf = () => container.clientWidth / Math.max(container.clientHeight, 1);
  const initial = computeViews(surface, aspectOf());
  const camera = new PerspectiveCamera(initial.fov, aspectOf(), initial.near, initial.far);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.maxPolarAngle = MAX_POLAR_ANGLE;
  controls.minDistance = 50;
  controls.maxDistance = initial.far * 0.9;

  let contextRadius = 0;
  const farOf = (computed: number): number => computed + 2 * contextRadius;
  let lastFocus: FocusBox | undefined;
  const setView = (name: ViewName, focus?: FocusBox): void => {
    if (focus) lastFocus = focus;
    const set = computeViews(surface, aspectOf(), lastFocus);
    const view = set.views[name];
    camera.near = set.near;
    camera.far = farOf(set.far);
    controls.maxDistance = camera.far * 0.9;
    camera.fov = set.fov;
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
    camera.fov = verticalFovDeg(camera.aspect);
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
    setImagery(texture) {
      setTerrainImagery(terrain, texture);
    },
    setSky: sky.setSky,
    setSkyFallback: sky.setSkyFallback,
    setGround(colorLinear, baseElevationM) {
      if (ground) {
        scene.remove(ground);
        ground.geometry.dispose();
        (ground.material as { dispose(): void }).dispose();
      }
      const { extent } = surface;
      ground = createGround(
        new Color(colorLinear.r, colorLinear.g, colorLinear.b),
        baseElevationM,
        {
          east: extent.centreEast,
          north: extent.centreNorth,
        },
      );
      scene.add(ground);
    },
    setGroundColor(color) {
      if (!ground) return;
      (ground.material as MeshStandardMaterial).color.set(color ?? groundSlopeColor());
    },
    setFadeCentre(centre) {
      setFadeCentre(terrainFade(terrain), centre);
    },
    setContextExtent(radiusM) {
      contextRadius = radiusM;
      camera.far = farOf(computeViews(surface, aspectOf(), lastFocus).far);
      controls.maxDistance = camera.far * 0.9;
      camera.updateProjectionMatrix();
    },
    onFrame(callback) {
      callbacks.add(callback);
      return () => callbacks.delete(callback);
    },
    dispose() {
      renderer.setAnimationLoop(null);
      observer.disconnect();
      controls.dispose();
      if (ground) {
        ground.geometry.dispose();
        (ground.material as { dispose(): void }).dispose();
      }
      terrain.geometry.dispose();
      (terrain.material as { dispose(): void }).dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}

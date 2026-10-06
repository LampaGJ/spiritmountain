import { Raycaster, Vector2, type Camera, type Object3D } from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/**
 * Screen-space pick threshold for Line2. three adds it to the full line width (LineSegments2.js:345),
 * so linewidth 3 plus threshold 6 gives a hit band of about +/-4.5 px around the line centre.
 * Tuned manually; the final value is recorded in the PR.
 */
export const LINE2_PICK_THRESHOLD_PX = 6;
/** A pointerup counts as a click only if the pointer moved fewer than this many px since pointerdown. */
export const CLICK_MAX_DISTANCE_PX = 5;
/** ...and fewer than this many ms elapsed. A long press never opens the panel. */
export const CLICK_MAX_DURATION_MS = 400;

/** The part of THREE.Raycaster that pickArea uses, so a unit test can pass a fake. */
export interface RayPicker {
  setFromCamera(coords: Vector2, camera: Camera): void;
  intersectObjects(objects: Object3D[], recursive?: boolean): { object: Object3D }[];
}

/**
 * @displayName Line raycaster factory
 * @strategicPurpose Gives every pick one Raycaster configured for screen-space Line2 picking.
 * @tacticalObjective Returns a Raycaster with params.Line2 = { threshold: LINE2_PICK_THRESHOLD_PX }.
 */
export function createLineRaycaster(): Raycaster {
  const raycaster = new Raycaster();
  raycaster.params.Line2 = { threshold: LINE2_PICK_THRESHOLD_PX };
  return raycaster;
}

/** Converts client coordinates to normalised device coordinates using the canvas rect, not the window. */
export function pointerToNdc(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
): Vector2 {
  return new Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
  );
}

export interface PointerSample {
  readonly x: number;
  readonly y: number;
  readonly t: number;
}

/** True when pointerup followed pointerdown closely enough in space and time to be a click, not an orbit drag. */
export function isClick(down: PointerSample, up: PointerSample): boolean {
  const distance = Math.hypot(up.x - down.x, up.y - down.y);
  return distance < CLICK_MAX_DISTANCE_PX && up.t - down.t < CLICK_MAX_DURATION_MS;
}

/**
 * @displayName Pick area
 * @strategicPurpose Resolves a pointer position to the area id under it, ignoring lines the user cannot see.
 * @tacticalObjective Filters candidates to visible lines (Raycaster ignores `visible`), casts once, and returns the nearest hit's userData.areaId, or null. Terrain occlusion is not handled in the spike.
 */
export function pickArea(
  picker: RayPicker,
  ndc: Vector2,
  camera: Camera,
  candidates: readonly Object3D[],
): { areaId: string; object: Object3D } | null {
  const visible = candidates.filter((object) => object.visible);
  if (visible.length === 0) return null;
  picker.setFromCamera(ndc, camera);
  const hit = picker.intersectObjects(visible, false)[0];
  if (hit === undefined) return null;
  const areaId: unknown = hit.object.userData['areaId'];
  if (typeof areaId !== 'string') {
    throw new Error('pickArea: a pickable object has no string userData.areaId');
  }
  return { areaId, object: hit.object };
}

export interface PickingOptions {
  readonly canvas: HTMLCanvasElement;
  readonly camera: Camera;
  readonly controls: OrbitControls;
  /** Called every frame by the scene handle; the raycast runs here, at most once per frame. */
  readonly onFrame: (callback: () => void) => void;
  readonly candidates: () => readonly Object3D[];
  readonly onHover: (areaId: string | null, clientX: number, clientY: number) => void;
  readonly onSelect: (areaId: string) => void;
  readonly picker?: RayPicker;
  readonly now?: () => number;
}

/**
 * @displayName Attach picking
 * @strategicPurpose Wires pointer and orbit events to hover and click picking on the scene canvas.
 * @tacticalObjective Re-picks only when the pointer moved or OrbitControls emitted `change`, skips while a button is down, and treats pointerup as a click only per isClick.
 */
export function attachPicking(options: PickingOptions): { dispose(): void } {
  const { canvas, camera, controls } = options;
  const picker = options.picker ?? createLineRaycaster();
  const now = options.now ?? (() => performance.now());
  let disposed = false;
  let dirty = false;
  let inside = false;
  let buttons = 0;
  let last = { x: 0, y: 0 };
  let down: PointerSample | null = null;

  const pickAt = (x: number, y: number) =>
    pickArea(
      picker,
      pointerToNdc(x, y, canvas.getBoundingClientRect()),
      camera,
      options.candidates(),
    );

  const onPointerMove = (event: PointerEvent): void => {
    inside = true;
    buttons = event.buttons;
    last = { x: event.clientX, y: event.clientY };
    dirty = true;
  };
  const onPointerLeave = (): void => {
    inside = false;
    dirty = false;
    options.onHover(null, last.x, last.y);
  };
  const onPointerDown = (event: PointerEvent): void => {
    buttons = event.buttons;
    if (event.button === 0) down = { x: event.clientX, y: event.clientY, t: now() };
    options.onHover(null, event.clientX, event.clientY);
  };
  const onPointerUp = (event: PointerEvent): void => {
    buttons = event.buttons;
    const start = down;
    down = null;
    dirty = true;
    if (start === null || event.button !== 0) return;
    if (!isClick(start, { x: event.clientX, y: event.clientY, t: now() })) return;
    const hit = pickAt(event.clientX, event.clientY);
    if (hit !== null) options.onSelect(hit.areaId);
  };
  const onControlsChange = (): void => {
    dirty = true;
  };

  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointerup', onPointerUp);
  controls.addEventListener('change', onControlsChange);

  options.onFrame(() => {
    if (disposed || !dirty) return;
    dirty = false;
    if (!inside || buttons !== 0) return;
    const hit = pickAt(last.x, last.y);
    options.onHover(hit === null ? null : hit.areaId, last.x, last.y);
  });

  return {
    dispose() {
      disposed = true;
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointerup', onPointerUp);
      controls.removeEventListener('change', onControlsChange);
    },
  };
}

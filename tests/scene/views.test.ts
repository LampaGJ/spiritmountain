import { Frustum, Matrix4, PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { fromScene, toScene } from '../../src/scene/frame';
import { createMeshSurface } from '../../src/scene/heightfield';
import {
  CAMERA_CLEARANCE_M,
  NAMED_VIEWS,
  RESORT_FALLBACK_HALF_SIZE_M,
  RESORT_VIEW_MAX_DISTANCE_M,
  RESORT_VIEW_MIN_DISTANCE_M,
  computeViews,
  findSummit,
  focusBoxOf,
  type Landmarks,
  type FocusBox,
  minCameraY,
  type ViewName,
} from '../../src/scene/views';
import { mapY } from '../../src/scene/elevated';
import { makeFixtureField } from '../fixtures/make-field';

const field = makeFixtureField();
const surface = createMeshSurface(field);

function cameraFor(name: ViewName, aspect: number) {
  const set = computeViews(surface, aspect);
  const view = set.views[name];
  const camera = new PerspectiveCamera(set.fov, aspect, set.near, set.far);
  camera.up.copy(view.up);
  camera.position.copy(view.position);
  camera.lookAt(view.target);
  camera.updateMatrixWorld(true);
  const frustum = new Frustum().setFromProjectionMatrix(
    new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
  );
  return { set, camera, frustum, view };
}

function corners(box: { min: Vector3; max: Vector3 }): Vector3[] {
  const out: Vector3[] = [];
  for (const x of [box.min.x, box.max.x]) {
    for (const y of [box.min.y, box.max.y]) {
      for (const z of [box.min.z, box.max.z]) out.push(new Vector3(x, y, z));
    }
  }
  return out;
}

describe('named views', () => {
  it('lists overview, topdown, summit-south and resort', () => {
    expect([...NAMED_VIEWS]).toEqual(['overview', 'topdown', 'summit-south', 'resort']);
  });

  it.each([16 / 9, 4 / 3, 1, 9 / 19.5])(
    'overview frames the whole terrain box at aspect %f',
    (aspect) => {
      const { set, frustum, view } = cameraFor('overview', aspect);
      expect(view.position.z).toBeGreaterThan(set.sphere.center.z);
      expect(view.position.y).toBeGreaterThan(set.sphere.center.y);
      for (const corner of corners(set.box)) expect(frustum.containsPoint(corner)).toBe(true);
    },
  );

  it('overview camera sits south-south-west of centre, about 40 degrees up', () => {
    const { set, view } = cameraFor('overview', 16 / 9);
    const d = view.position.clone().sub(set.sphere.center);
    expect(d.x).toBeLessThan(0);
    const elevationDeg = (Math.asin(d.y / d.length()) * 180) / Math.PI;
    expect(elevationDeg).toBeCloseTo(40, 6);
  });

  it('topdown looks straight down with north up the screen, whole terrain in frame', () => {
    const { set, frustum, view } = cameraFor('topdown', 16 / 9);
    expect(view.position.x).toBeCloseTo(set.sphere.center.x, 6);
    expect(view.position.z).toBeCloseTo(set.sphere.center.z, 6);
    expect(view.up.toArray()).toEqual([0, 0, -1]);
    for (const corner of corners(set.box)) expect(frustum.containsPoint(corner)).toBe(true);
  });

  it('summit-south targets the highest cell from the south, above it, and keeps it at screen centre', () => {
    const summit = findSummit(field);
    const s = toScene(summit.east, summit.north, summit.elevation);
    const { view, camera } = cameraFor('summit-south', 16 / 9);
    expect(view.target.toArray()).toEqual([s.x, s.y, s.z]);
    expect(view.position.z).toBeGreaterThan(s.z);
    expect(view.position.y).toBeGreaterThan(s.y);
    const ndc = new Vector3(s.x, s.y, s.z).project(camera);
    expect(Math.abs(ndc.x)).toBeLessThan(1e-6);
    expect(Math.abs(ndc.y)).toBeLessThan(1e-6);
  });

  it('sizes near and far from the extent: near well above 0.1 and far past the camera', () => {
    const { set, view } = cameraFor('overview', 16 / 9);
    expect(set.near).toBeGreaterThanOrEqual(1);
    expect(set.far).toBeGreaterThan(
      view.position.distanceTo(set.sphere.center) + set.sphere.radius,
    );
    expect(set.far / set.near).toBeLessThanOrEqual(5000 + 1e-9);
  });
});

describe('findSummit', () => {
  it('returns the first maximum in row-major order', () => {
    const data = new Float32Array(9).fill(1);
    data[4] = 5;
    data[7] = 5;
    const summit = findSummit({
      cols: 3,
      rows: 3,
      originEast: 0,
      originNorth: 20,
      cellSizeEast: 10,
      cellSizeNorth: 10,
      data,
    });
    expect(summit).toEqual({ col: 1, row: 1, elevation: 5, east: 10, north: 10 });
  });
});

describe('minCameraY', () => {
  it('is the surface height plus the clearance', () => {
    const p = toScene(60, -20, 0);
    expect(minCameraY(surface, p.x, p.z)).toBeCloseTo(
      surface.sample(60, -20).height + CAMERA_CLEARANCE_M,
      9,
    );
  });
});

describe('minCameraY with exaggeration', () => {
  it('maps the sampled height about the base before adding the clearance', () => {
    const p = toScene(60, -20, 0);
    const height = surface.sample(60, -20).height;
    const base = height - 10;
    expect(minCameraY(surface, p.x, p.z, { k: 3, base })).toBeCloseTo(
      mapY(height, 3, base) + CAMERA_CLEARANCE_M,
      9,
    );
  });
  it('is unchanged at k = 1', () => {
    const p = toScene(60, -20, 0);
    expect(minCameraY(surface, p.x, p.z, { k: 1, base: 5 })).toBeCloseTo(
      minCameraY(surface, p.x, p.z),
      9,
    );
  });
});

describe('resort view', () => {
  const focus: FocusBox = { minEast: -100, maxEast: 100, minNorth: -100, maxNorth: 100 };
  const deg = (rad: number) => (rad * 180) / Math.PI;
  const resort = (f?: FocusBox) => computeViews(surface, 16 / 9, f).views.resort;

  it('targets a point inside the focus box, on the terrain or above it', () => {
    const { target } = resort(focus);
    const local = fromScene(target.x, target.y, target.z);
    expect(local.east).toBeGreaterThanOrEqual(focus.minEast);
    expect(local.east).toBeLessThanOrEqual(focus.maxEast);
    expect(local.north).toBeGreaterThanOrEqual(focus.minNorth);
    expect(local.north).toBeLessThanOrEqual(focus.maxNorth);
    expect(target.y).toBeGreaterThanOrEqual(surface.sample(local.east, local.north).height);
  });

  it('puts the camera on the base side, so the view looks uphill', () => {
    const { position, target } = resort(focus);
    const mids = [
      { east: 0, north: focus.minNorth },
      { east: 0, north: focus.maxNorth },
      { east: focus.minEast, north: 0 },
      { east: focus.maxEast, north: 0 },
    ];
    const lowest = mids.reduce((a, b) =>
      surface.sample(b.east, b.north).height < surface.sample(a.east, a.north).height ? b : a,
    );
    const towardLowest = { x: lowest.east, z: -lowest.north };
    const offset = { x: position.x - target.x, z: position.z - target.z };
    expect(offset.x * towardLowest.x + offset.z * towardLowest.z).toBeGreaterThan(0);
  });

  it('keeps a shallow elevation angle, a bounded distance and clearance over the terrain', () => {
    const { position, target } = resort(focus);
    const horizontal = Math.hypot(position.x - target.x, position.z - target.z);
    expect(horizontal).toBeGreaterThanOrEqual(RESORT_VIEW_MIN_DISTANCE_M - 1e-6);
    expect(horizontal).toBeLessThanOrEqual(RESORT_VIEW_MAX_DISTANCE_M + 1e-6);
    const angle = deg(Math.asin((position.y - target.y) / position.distanceTo(target)));
    expect(angle).toBeGreaterThan(-15);
    expect(angle).toBeLessThan(20);
    expect(position.y).toBeGreaterThanOrEqual(minCameraY(surface, position.x, position.z) - 1e-9);
  });

  it('is deterministic for the same inputs', () => {
    expect(resort(focus).position.toArray()).toEqual(resort(focus).position.toArray());
  });

  it('without a focus, targets within the fallback half-size of the summit', () => {
    const summit = findSummit(field);
    const { target } = resort();
    const local = fromScene(target.x, target.y, target.z);
    expect(Math.abs(local.east - summit.east)).toBeLessThanOrEqual(RESORT_FALLBACK_HALF_SIZE_M);
    expect(Math.abs(local.north - summit.north)).toBeLessThanOrEqual(RESORT_FALLBACK_HALF_SIZE_M);
  });
});

describe('focusBoxOf', () => {
  const entry = (kind: string, coordinates: number[][]) =>
    ({ area: { kind, geometry: { type: 'LineString', coordinates } } }) as never;

  it('bounds only downhill runs and lifts', () => {
    const box = focusBoxOf([
      entry('lift', [
        [10, 20, 5],
        [30, -40, 9],
      ]),
      entry('nordic-trail', [
        [-999, -999, 0],
        [999, 999, 0],
      ]),
    ]);
    expect(box).toEqual({ minEast: 10, maxEast: 30, minNorth: -40, maxNorth: 20 });
  });

  it('reads polygon rings and returns null when nothing qualifies', () => {
    const polygon = {
      area: {
        kind: 'downhill-run',
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [0, 0],
              [4, 0],
              [4, 3],
              [0, 0],
            ],
          ],
        },
      },
    } as never;
    expect(focusBoxOf([polygon])).toEqual({ minEast: 0, maxEast: 4, minNorth: 0, maxNorth: 3 });
    expect(focusBoxOf([entry('mtb-trail', [[1, 1]])])).toBeNull();
  });
});

describe('field of view', () => {
  it('derives the vertical fov from a 120 degree horizontal fov', async () => {
    const { verticalFovDeg, HORIZONTAL_FOV_DEG } = await import('../../src/scene/views');
    expect(HORIZONTAL_FOV_DEG).toBe(120);
    expect(verticalFovDeg(16 / 9)).toBeCloseTo(88.55, 1);
    expect(verticalFovDeg(0.46)).toBe(95);
    expect(verticalFovDeg(3)).toBeCloseTo(60, 0);
    expect(verticalFovDeg(100)).toBeGreaterThanOrEqual(50);
  });
});

describe('resort view from landmarks', () => {
  const landmarks: Landmarks = {
    liftBase: { east: 100, north: -150 },
    liftTop: { east: -250, north: 100 },
    upperChalet: { east: 0, north: 250, roofM: 10 },
  };
  const focus: FocusBox = { minEast: -100, maxEast: 100, minNorth: -100, maxNorth: 100 };
  const resortAt = (aspect: number, l: Landmarks | undefined = landmarks) =>
    computeViews(surface, aspect, undefined, l).views.resort;

  it('stands on the sight line beyond the lift base, away from the lift top, 2 m above the terrain', () => {
    const p = fromScene(...(resortAt(16 / 9).position.toArray() as [number, number, number]));
    const away = { east: 350, north: -250 };
    const norm = Math.hypot(away.east, away.north);
    const rel = { east: p.east - 100, north: p.north + 150 };
    const along = (rel.east * away.east + rel.north * away.north) / norm;
    const cross = (rel.east * -away.north + rel.north * away.east) / norm;
    expect(along).toBeGreaterThanOrEqual(60 - 1e-6);
    expect(Math.abs(cross)).toBeLessThan(1e-6);
    expect(p.elevation).toBeCloseTo(surface.sample(p.east, p.north).height + 2, 6);
  });

  it('is exactly 60 m from the base when the frame already holds both landmarks', () => {
    const set = computeViews(surface, 16 / 9, undefined, landmarks);
    const p = fromScene(...(set.views.resort.position.toArray() as [number, number, number]));
    if ((set.views.resort.distance as number) > 0) {
      expect(Math.hypot(p.east - 100, p.north + 150)).toBeGreaterThanOrEqual(60 - 1e-6);
    }
  });

  it('targets the chalet centroid at terrain plus half the roof height, looking up', () => {
    const v = resortAt(16 / 9);
    const t = fromScene(v.target.x, v.target.y, v.target.z);
    expect(t.east).toBeCloseTo(0, 9);
    expect(t.north).toBeCloseTo(250, 9);
    expect(t.elevation).toBeCloseTo(surface.sample(0, 250).height + 5, 6);
    expect(v.up.toArray()).toEqual([0, 1, 0]);
    expect(v.target.y).toBeGreaterThan(v.position.y);
  });

  it('without landmarks equals the focus-box construction', () => {
    const a = computeViews(surface, 16 / 9, focus).views.resort;
    const b = computeViews(surface, 16 / 9, focus, undefined).views.resort;
    expect(a.position.toArray()).toEqual(b.position.toArray());
    expect(a.target.toArray()).toEqual(b.target.toArray());
    expect(a.distance).toBeUndefined();
  });

  it('falls back to the focus-box target when the chalet is absent', () => {
    const plain = computeViews(surface, 16 / 9, focus).views.resort;
    const v = computeViews(surface, 16 / 9, focus, {
      liftBase: landmarks.liftBase,
      liftTop: landmarks.liftTop,
    }).views.resort;
    expect(v.target.toArray()).toEqual(plain.target.toArray());
  });

  it('backs off further in portrait, and keeps the chalet and lift top inside the frustum', () => {
    const wide = resortAt(16 / 9);
    const portrait = resortAt(0.46);
    expect(portrait.distance as number).toBeGreaterThan(wide.distance as number);
    for (const [aspect, view] of [
      [16 / 9, wide],
      [0.46, portrait],
    ] as const) {
      const set = computeViews(surface, aspect, undefined, landmarks);
      const camera = new PerspectiveCamera(set.fov, aspect, 1, 1e6);
      camera.up.copy(view.up);
      camera.position.copy(view.position);
      camera.lookAt(view.target);
      camera.updateMatrixWorld(true);
      const frustum = new Frustum().setFromProjectionMatrix(
        new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
      );
      const top = toScene(-250, 100, surface.sample(-250, 100).height);
      expect(frustum.containsPoint(view.target)).toBe(true);
      expect(frustum.containsPoint(new Vector3(top.x, top.y, top.z))).toBe(true);
    }
  });

  it('never backs off beyond 2.5 times the base-lot distance', () => {
    const v = resortAt(0.2, { ...landmarks, liftTop: { east: -310, north: -270 } });
    const t = fromScene(v.target.x, v.target.y, v.target.z);
    const p = fromScene(v.position.x, v.position.y, v.position.z);
    const horizontal = Math.hypot(p.east - t.east, p.north - t.north);
    const start = Math.hypot(100 - t.east, -150 - t.north) + 60;
    expect(horizontal).toBeLessThanOrEqual(2.5 * start + 1e-6);
  });
});

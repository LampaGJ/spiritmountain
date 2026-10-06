import { Frustum, Matrix4, PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { toScene } from '../../src/scene/frame';
import { createMeshSurface } from '../../src/scene/heightfield';
import {
  CAMERA_CLEARANCE_M,
  CAMERA_FOV_DEG,
  NAMED_VIEWS,
  computeViews,
  findSummit,
  minCameraY,
  type ViewName,
} from '../../src/scene/views';
import { makeFixtureField } from '../fixtures/make-field';

const field = makeFixtureField();
const surface = createMeshSurface(field);

function cameraFor(name: ViewName, aspect: number) {
  const set = computeViews(surface, aspect);
  const view = set.views[name];
  const camera = new PerspectiveCamera(CAMERA_FOV_DEG, aspect, set.near, set.far);
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
  it('lists overview, topdown and summit-south', () => {
    expect([...NAMED_VIEWS]).toEqual(['overview', 'topdown', 'summit-south']);
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

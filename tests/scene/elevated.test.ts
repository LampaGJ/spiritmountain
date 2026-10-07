// @vitest-environment jsdom
import { Object3D, PerspectiveCamera, Vector3 } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { describe, expect, it } from 'vitest';
import { ElevatedGroup, mapY, remapCamera, MIN_SCALE_Y } from '../../src/scene/elevated';

const BASE = 183.1;

describe('mapY', () => {
  it.each([0, 1, 2.5, 10])('maps y to base + k * (y - base) at k = %s', (k) => {
    for (const y of [150, BASE, 400, 640.7]) {
      expect(mapY(y, k, BASE)).toBeCloseTo(BASE + k * (y - BASE), 9);
    }
  });
  it('leaves the base line fixed for every k', () => {
    for (const k of [0, 0.3, 1, 7, 10]) expect(mapY(BASE, k, BASE)).toBeCloseTo(BASE, 9);
  });
  it('is the identity at k = 1', () => {
    expect(mapY(412.5, 1, BASE)).toBe(412.5);
  });
});

describe('ElevatedGroup', () => {
  it('is named elevated and starts unscaled', () => {
    const group = new ElevatedGroup();
    expect(group.name).toBe('elevated');
    expect(group.scale.y).toBe(1);
    expect(group.position.y).toBe(0);
  });

  it.each([0, 1, 2.5, 10])('puts a probe at world y = mapY(y) at k = %s', (k) => {
    const group = new ElevatedGroup();
    const probe = new Object3D();
    probe.position.set(12, 320.4, -7);
    group.add(probe);
    group.setExaggeration(k, BASE);
    group.updateMatrixWorld(true);
    const world = probe.getWorldPosition(new Vector3());
    expect(world.x).toBeCloseTo(12, 9);
    expect(world.z).toBeCloseTo(-7, 9);
    // k below MIN_SCALE_Y is drawn at the clamped scale, so compare against the effective scale.
    expect(world.y).toBeCloseTo(mapY(320.4, Math.max(k, MIN_SCALE_Y), BASE), 6);
  });

  it('clamps k = 0 to MIN_SCALE_Y so matrices stay invertible', () => {
    const group = new ElevatedGroup();
    group.setExaggeration(0, BASE);
    expect(group.scale.y).toBe(MIN_SCALE_Y);
    expect(MIN_SCALE_Y).toBe(0.1);
  });
});

function rig(y: number, targetY: number) {
  const camera = new PerspectiveCamera();
  camera.position.set(100, y, 50);
  const element = document.createElement('canvas');
  const controls = new OrbitControls(camera, element);
  controls.target.set(0, targetY, 0);
  return { camera, controls };
}

describe('remapCamera', () => {
  // The camera must be over the terrain point under it by the same relative amount before and after.
  it('preserves the height ratio above a mapped terrain point', () => {
    const terrainY = 300;
    const { camera, controls } = rig(500, 320);
    const before = (camera.position.y - BASE) / (terrainY - BASE);
    remapCamera(camera, controls, 1, 3, BASE);
    const after = (camera.position.y - BASE) / (mapY(terrainY, 3, BASE) - BASE);
    expect(after).toBeCloseTo(before, 9);
    expect(camera.position.y - mapY(terrainY, 3, BASE)).toBeGreaterThan(0);
  });

  it('maps both camera and target through the same affine transform', () => {
    const { camera, controls } = rig(500, 320);
    remapCamera(camera, controls, 1, 2.5, BASE);
    expect(camera.position.y).toBeCloseTo(mapY(500, 2.5, BASE), 9);
    expect(controls.target.y).toBeCloseTo(mapY(320, 2.5, BASE), 9);
  });

  it('is exact when k0 = k1', () => {
    const { camera, controls } = rig(512.25, 301.5);
    remapCamera(camera, controls, 2.5, 2.5, BASE);
    expect(camera.position.y).toBe(512.25);
    expect(controls.target.y).toBe(301.5);
  });

  it('round-trips k0 -> k1 -> k0', () => {
    const { camera, controls } = rig(500, 320);
    remapCamera(camera, controls, 1, 4, BASE);
    remapCamera(camera, controls, 4, 1, BASE);
    expect(camera.position.y).toBeCloseTo(500, 9);
    expect(controls.target.y).toBeCloseTo(320, 9);
  });

  it('leaves x and z alone', () => {
    const { camera, controls } = rig(500, 320);
    remapCamera(camera, controls, 1, 6, BASE);
    expect(camera.position.x).toBeCloseTo(100, 9);
    expect(camera.position.z).toBeCloseTo(50, 9);
    expect(controls.target.x).toBe(0);
  });
});

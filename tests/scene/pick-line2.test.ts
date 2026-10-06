import { PerspectiveCamera, Vector2 } from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { describe, expect, it } from 'vitest';
import {
  LINE2_PICK_THRESHOLD_PX,
  createLineRaycaster,
  pickArea,
  pointerToNdc,
} from '../../src/scene/pick';

const WIDTH = 800;
const HEIGHT = 600;
const RECT = { left: 0, top: 0, width: WIDTH, height: HEIGHT };

/** A horizontal line through the screen centre, 10 units in front of the camera. */
function setup() {
  const camera = new PerspectiveCamera(60, WIDTH / HEIGHT, 0.1, 100);
  camera.position.set(0, 0, 0);
  camera.updateMatrixWorld(true);
  const geometry = new LineGeometry();
  geometry.setPositions([-5, 0, -10, 5, 0, -10]);
  const material = new LineMaterial({ linewidth: 3 });
  material.resolution.set(WIDTH, HEIGHT);
  const line = new Line2(geometry, material);
  line.userData['areaId'] = 'way/1';
  line.updateMatrixWorld(true);
  return { camera, line, material };
}

const at = (dy: number) => pointerToNdc(WIDTH / 2, HEIGHT / 2 + dy, RECT);

describe('real Raycaster against a Line2 (headless)', () => {
  it('uses the params.Line2 key three reads', () => {
    expect(createLineRaycaster().params.Line2).toEqual({ threshold: LINE2_PICK_THRESHOLD_PX });
  });

  it('hits a few px from the line and misses 30 px away', () => {
    const { camera, line } = setup();
    const raycaster = createLineRaycaster();
    expect(pickArea(raycaster, at(3), camera, [line])?.areaId).toBe('way/1');
    expect(pickArea(raycaster, at(30), camera, [line])).toBeNull();
  });

  it('misses before the line has a resolution (never rendered), documenting the early-out', () => {
    const { camera, line, material } = setup();
    material.resolution.set(0, 0);
    expect(pickArea(createLineRaycaster(), at(0), camera, [line])).toBeNull();
  });

  it('three ignores `visible`; pickArea filters it', () => {
    const { camera, line } = setup();
    line.visible = false;
    const raycaster = createLineRaycaster();
    raycaster.setFromCamera(new Vector2(0, 0), camera);
    expect(raycaster.intersectObjects([line], false)).toHaveLength(1);
    expect(pickArea(raycaster, new Vector2(0, 0), camera, [line])).toBeNull();
  });
});

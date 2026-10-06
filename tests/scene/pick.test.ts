import { Object3D, PerspectiveCamera, Vector2 } from 'three';
import { describe, expect, it } from 'vitest';
import {
  CLICK_MAX_DISTANCE_PX,
  CLICK_MAX_DURATION_MS,
  isClick,
  pickArea,
  pointerToNdc,
  type RayPicker,
} from '../../src/scene/pick';

function lineLike(areaId: string | undefined, visible = true): Object3D {
  const object = new Object3D();
  if (areaId !== undefined) object.userData['areaId'] = areaId;
  object.visible = visible;
  return object;
}

/** A fake Raycaster that "hits" every object it is given, in the order given, and records the call. */
function fakePicker() {
  const calls: { objects: Object3D[]; recursive: boolean | undefined }[] = [];
  const picker: RayPicker = {
    setFromCamera() {},
    intersectObjects(objects, recursive) {
      calls.push({ objects, recursive });
      return objects.map((object) => ({ object }));
    },
  };
  return { picker, calls };
}

const camera = new PerspectiveCamera();
const ndc = new Vector2(0, 0);

describe('pickArea', () => {
  it('returns the nearest (first) hit areaId', () => {
    const { picker } = fakePicker();
    const hit = pickArea(picker, ndc, camera, [lineLike('way/1'), lineLike('way/2')]);
    expect(hit?.areaId).toBe('way/1');
  });

  it('passes only visible candidates and casts non-recursively', () => {
    const { picker, calls } = fakePicker();
    const hit = pickArea(picker, ndc, camera, [lineLike('way/1', false), lineLike('way/2')]);
    expect(hit?.areaId).toBe('way/2');
    expect(calls[0]?.objects.map((o) => o.userData['areaId'])).toEqual(['way/2']);
    expect(calls[0]?.recursive).toBe(false);
  });

  it('returns null when every candidate is hidden, without casting', () => {
    const { picker, calls } = fakePicker();
    expect(pickArea(picker, ndc, camera, [lineLike('way/1', false)])).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('returns null on no hit', () => {
    const picker: RayPicker = { setFromCamera() {}, intersectObjects: () => [] };
    expect(pickArea(picker, ndc, camera, [lineLike('way/1')])).toBeNull();
  });

  it('throws when a hit object has no string areaId', () => {
    const { picker } = fakePicker();
    expect(() => pickArea(picker, ndc, camera, [lineLike(undefined)])).toThrow(/areaId/);
  });
});

describe('pointerToNdc', () => {
  it('uses the canvas rect, not the window', () => {
    const rect = { left: 100, top: 50, width: 400, height: 200 };
    expect(pointerToNdc(300, 150, rect).toArray()).toEqual([0, 0]);
    expect(pointerToNdc(100, 50, rect).toArray()).toEqual([-1, 1]);
    expect(pointerToNdc(500, 250, rect).toArray()).toEqual([1, -1]);
  });
});

describe('isClick (5 px, 400 ms, strict)', () => {
  const down = { x: 100, y: 100, t: 0 };
  it('is a click just under both limits', () => {
    expect(isClick(down, { x: 104, y: 100, t: 399 })).toBe(true);
  });
  it('is not a click at exactly 5 px', () => {
    expect(CLICK_MAX_DISTANCE_PX).toBe(5);
    expect(isClick(down, { x: 105, y: 100, t: 10 })).toBe(false);
  });
  it('is not a click at exactly 400 ms', () => {
    expect(CLICK_MAX_DURATION_MS).toBe(400);
    expect(isClick(down, { x: 100, y: 100, t: 400 })).toBe(false);
  });
  it('measures straight-line distance, not per axis', () => {
    expect(isClick(down, { x: 103, y: 104, t: 10 })).toBe(false);
  });
});

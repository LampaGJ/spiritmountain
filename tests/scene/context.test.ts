import { Mesh, MeshStandardMaterial, Scene, ShaderLib, Texture } from 'three';
import { describe, expect, it } from 'vitest';
import {
  CENTRE_BOX,
  FADE_INNER_M,
  FADE_OUTER_M,
  TILE_HEIGHT_M,
  TILE_WIDTH_M,
  tileKey,
} from '../../scripts/ingest/context-tiles';
import { ORIGIN } from '../../scripts/ingest/local-frame';
import type { ContextTile } from '../../src/data/load-context';
import { buildContextGeometry, installContext } from '../../src/scene/context';
import { applyRadialFade } from '../../src/scene/fade';
import { toScene } from '../../src/scene/frame';
import { synHeader } from '../data/synthetic-terrain';

const COLS = 4;
const ROWS = 4;

/** A tiny heightfield covering tile (i, j) exactly: header origin is the tile's north-west corner in local metres. */
function fakeTile(i: number, j: number): ContextTile {
  const cellX = TILE_WIDTH_M / COLS;
  const cellY = TILE_HEIGHT_M / ROWS;
  const originX = CENTRE_BOX.xmin - ORIGIN.easting + i * TILE_WIDTH_M;
  const originY = CENTRE_BOX.ymax - ORIGIN.northing + j * TILE_HEIGHT_M;
  const data = new Float32Array(COLS * ROWS);
  for (let k = 0; k < data.length; k += 1) data[k] = 200 + k;
  return {
    i,
    j,
    key: tileKey(i, j),
    header: {
      ...synHeader(),
      width: COLS,
      height: ROWS,
      originX,
      originY,
      cellSizeX: cellX,
      cellSizeY: cellY,
    },
    heightfield: {
      cols: COLS,
      rows: ROWS,
      originEast: originX + 0.5 * cellX,
      originNorth: originY - 0.5 * cellY,
      cellSizeEast: cellX,
      cellSizeNorth: cellY,
      data,
    },
    imageryUrl: null,
  };
}

const fadeCentre = { east: 0, north: 0 };

describe('installContext placement', () => {
  it('puts tile (1,1) one tile width east and one tile height north of the centre tile', () => {
    const scene = new Scene();
    const handle = installContext(scene, [fakeTile(1, 1)], { fadeCentre, imageryOn: false });
    const mesh = handle.meshes.get('1_1') as Mesh;
    const centreE = CENTRE_BOX.xmin - ORIGIN.easting + TILE_WIDTH_M / 2;
    const centreN = CENTRE_BOX.ymin - ORIGIN.northing + TILE_HEIGHT_M / 2;
    const expected = toScene(centreE + TILE_WIDTH_M, centreN + TILE_HEIGHT_M, 0);
    expect(mesh.position.x).toBeCloseTo(expected.x, 6);
    expect(mesh.position.z).toBeCloseTo(expected.z, 6);
    // North-east corner of the mesh in scene metres equals the centre tile's NE corner plus one tile each way.
    const box = mesh.geometry.boundingBox as NonNullable<typeof mesh.geometry.boundingBox>;
    const neEast = mesh.position.x + box.max.x;
    const neNorth = -(mesh.position.z + box.min.z);
    expect(neEast).toBeCloseTo(CENTRE_BOX.xmax - ORIGIN.easting + TILE_WIDTH_M, 6);
    expect(neNorth).toBeCloseTo(CENTRE_BOX.ymax - ORIGIN.northing + TILE_HEIGHT_M, 6);
    expect(scene.children).toContain(handle.group);
  });

  it('spans the whole tile box, so neighbours meet with no gap', () => {
    const geometry = buildContextGeometry(fakeTile(0, 1).heightfield);
    const box = geometry.boundingBox as NonNullable<typeof geometry.boundingBox>;
    expect(box.max.x - box.min.x).toBeCloseTo(TILE_WIDTH_M, 6);
    expect(box.max.z - box.min.z).toBeCloseTo(TILE_HEIGHT_M, 6);
  });

  it('draws elevations from the field: edge vertices clamp to the edge samples', () => {
    const geometry = buildContextGeometry(fakeTile(0, 1).heightfield);
    const pos = geometry.getAttribute('position');
    // Vertex row 0, column 0 is the north-west corner: the (0, 0) sample, 200.
    expect(pos.getY(0)).toBeCloseTo(200, 4);
    // Last vertex is the south-east corner: the last sample, 215.
    expect(pos.getY(pos.count - 1)).toBeCloseTo(215, 4);
  });
});

describe('installContext imagery', () => {
  it('toggles every tile between slope shading and the photo, and disposes', () => {
    const scene = new Scene();
    const handle = installContext(scene, [fakeTile(1, 0), fakeTile(0, 1)], {
      fadeCentre,
      imageryOn: true,
    });
    const photo = new Texture();
    handle.setTexture('1_0', photo);
    const material = (key: string) =>
      (handle.meshes.get(key) as Mesh).material as MeshStandardMaterial;
    expect(material('1_0').map).toBe(photo);
    expect(material('1_0').vertexColors).toBe(false);
    expect(material('0_1').map).toBeNull();
    expect(material('0_1').vertexColors).toBe(true);
    handle.setImagery(false);
    expect(material('1_0').map).toBeNull();
    expect(material('1_0').vertexColors).toBe(true);
    handle.setImagery(true);
    expect(material('1_0').map).toBe(photo);
    handle.dispose();
    expect(scene.children).toHaveLength(0);
  });
});

describe('applyRadialFade', () => {
  it('makes the material transparent with depth writes and injects the fade into both shaders', () => {
    const material = new MeshStandardMaterial();
    const uniforms = applyRadialFade(material, { centre: { east: 100, north: 200 } });
    expect(material.transparent).toBe(true);
    expect(material.depthWrite).toBe(true);
    // Scene ground plane: x east, z = -north.
    expect(uniforms.fadeCentre.value).toEqual([100, -200]);
    expect(uniforms.fadeInner.value).toBe(FADE_INNER_M);
    expect(uniforms.fadeOuter.value).toBe(FADE_OUTER_M);
    const shader = {
      uniforms: {} as Record<string, unknown>,
      vertexShader: ShaderLib['standard'].vertexShader,
      fragmentShader: ShaderLib['standard'].fragmentShader,
    };
    material.onBeforeCompile(shader as never, null as never);
    expect(shader.vertexShader).toContain('vFadeXZ = (modelMatrix * vec4(transformed, 1.0)).xz;');
    expect(shader.fragmentShader).toContain(
      'gl_FragColor.a *= 1.0 - smoothstep(fadeInner, fadeOuter',
    );
    expect(Object.keys(shader.uniforms).sort()).toEqual(['fadeCentre', 'fadeInner', 'fadeOuter']);
  });
});

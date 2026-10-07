import frameUrl from '../data/frame.json?url';
import terrainBinUrl from '../data/terrain.f32?url';
import terrainHeaderUrl from '../data/terrain.json?url';
import { loadTerrain } from './data/load-terrain';
import { toScene } from './scene/frame';
import { createScene } from './scene/scene';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) {
  throw new Error('index.html is missing the #app element');
}

const { header, heightfield } = await loadTerrain({
  headerUrl: terrainHeaderUrl,
  binUrl: terrainBinUrl,
  frameUrl,
}).catch((error: unknown) => {
  app.textContent = `Terrain failed to load: ${String(error)}`;
  throw error;
});

const handle = createScene(app, heightfield);

import imageryManifestJson from '../data/raw/imagery-manifest.json';
import naipUrl from '../data/raw/naip.jpg?url';
import { FADE_OUTER_M } from '../scripts/ingest/context-tiles';
import { ImageryManifestSchema } from '../scripts/ingest/imagery-manifest-schema';
import { loadContext, loadContextTextures } from './data/load-context';
import { installContext, type ContextHandle } from './scene/context';
import { groundSlopeColor } from './scene/ground';
import { loadImagery } from './data/load-imagery';
import { decodeHash } from './ui/filter-hash';
import { Color, type Texture } from 'three';
import { loadImageryStats } from './data/load-imagery-stats';
import { loadSky } from './data/load-sky';

/** Failure channel for the imagery layer: one line in its own element, and the terrain keeps its slope shading. */
function reportImageryFailure(message: string): void {
  console.error(`imagery: ${message}`);
  const status = document.createElement('div');
  status.id = 'imagery-status';
  status.setAttribute('role', 'alert');
  status.textContent = `imagery unavailable: ${message}`;
  document.body.append(status);
}

let imageryTexture: Texture | null = null;
/** Mean linear colour of the photo, once data/imagery-stats.json has loaded; the ground uses it when imagery is on. */
let groundMean: Color | null = null;
/** The context ring, once it has loaded; null until then and when every tile failed. */
let contextHandle: ContextHandle | null = null;
let imageryWanted = decodeHash(location.hash).filter.imagery !== false;
const applyImagery = (): void => {
  handle.setImagery(imageryWanted ? imageryTexture : null);
  handle.setGroundColor(imageryWanted ? groundMean : null);
  contextHandle?.setImagery(imageryWanted);
};
/** The filter strip calls this on mount and on every toggle; it also fires before the photo has loaded. */
export const setImageryWanted = (on: boolean): void => {
  imageryWanted = on;
  applyImagery();
};

// Not awaited: the terrain is already on screen with slope shading, and a failed load only adds the status line.
const imageryManifest = ImageryManifestSchema.safeParse(imageryManifestJson);
if (!imageryManifest.success) {
  reportImageryFailure(imageryManifest.error.issues.map((i) => i.message).join('; '));
} else {
  void loadImagery({
    url: naipUrl,
    capabilities: handle.renderer.capabilities,
    expectedWidth: imageryManifest.data.width,
  }).then((result) => {
    if (result.texture === null) return reportImageryFailure(result.reason);
    imageryTexture = result.texture;
    applyImagery();
  });
}

import areasUrl from '../data/areas.geojson?url';
import { loadAreas } from './data/load-areas';
import { installAreas, type AreaLayer } from './scene/areas';
import { createMeshSurface } from './scene/heightfield';
import { focusBoxOf } from './scene/views';

/**
 * Failure channel for the areas layer. Writes the message to its own element with textContent and
 * never touches #app, so a failed load leaves the rendered terrain on screen.
 */
function reportAreasFailure(message: string): { error: string } {
  console.error(`areas: ${message}`);
  const status = document.createElement('div');
  status.id = 'areas-status';
  status.setAttribute('role', 'alert');
  status.textContent = `areas unavailable: ${message}`;
  document.body.append(status);
  return { error: message };
}

const meshSurface = createMeshSurface(heightfield);
let areaLayerResult: AreaLayer | { error: string };
try {
  const areas = await loadAreas(areasUrl);
  areaLayerResult = installAreas(handle.scene, areas, meshSurface, (east, north, elevation) => {
    const p = toScene(east, north, elevation);
    return [p.x, p.y, p.z];
  });
} catch (error) {
  areaLayerResult = reportAreasFailure(error instanceof Error ? error.message : String(error));
}
// The fade is centred on the resort focus box (downhill runs and lifts), or on the centre tile when there is none.
let fadeCentre = {
  east: heightfield.originEast + ((heightfield.cols - 1) * heightfield.cellSizeEast) / 2,
  north: heightfield.originNorth - ((heightfield.rows - 1) * heightfield.cellSizeNorth) / 2,
};
if (!('error' in areaLayerResult)) {
  const focus = focusBoxOf(areaLayerResult.registry.values());
  if (focus) {
    handle.setView('resort', focus);
    fadeCentre = {
      east: (focus.minEast + focus.maxEast) / 2,
      north: (focus.minNorth + focus.maxNorth) / 2,
    };
  }
}
handle.setFadeCentre(fadeCentre);

/** One line in the shared imagery status element for the ground or sky; the scene keeps its fallback look. */
function reportSceneFailure(what: string, message: string): void {
  console.error(`${what}: ${message}`);
  let status = document.getElementById('imagery-status');
  if (!status) {
    status = document.createElement('div');
    status.id = 'imagery-status';
    status.setAttribute('role', 'alert');
    document.body.append(status);
  }
  status.textContent = `${what} unavailable: ${message.split('\n')[0] ?? message}`;
}

// Not awaited: ground and sky arrive after the terrain is already on screen. Failures keep the flat sky and slope-coloured ground.
void loadImageryStats().then((stats) => {
  if ('error' in stats) {
    reportSceneFailure('ground colour', stats.error);
    handle.setGround(groundSlopeColor(), header.minElev);
    return;
  }
  groundMean = new Color(stats.meanLinear.r, stats.meanLinear.g, stats.meanLinear.b);
  handle.setGround(groundMean, header.minElev);
  handle.setGroundColor(imageryWanted ? groundMean : null);
});
void loadSky().then((sky) => {
  if ('error' in sky) {
    handle.setSkyFallback();
    return reportSceneFailure('sky', sky.error);
  }
  handle.setSky(sky);
  console.info('sky: panorama applied');
});

import buildingsUrl from '../data/buildings.geojson?url';
import { loadBuildings } from './data/load-buildings';
import { buildBuildingsLayer, type BuildingsLayer } from './scene/buildings';

/** One line in the imagery status element for the buildings layer; the terrain and areas are never touched. */
function reportBuildingsFailure(message: string): void {
  console.error(`buildings: ${message}`);
  let status = document.getElementById('imagery-status');
  if (!status) {
    status = document.createElement('div');
    status.id = 'imagery-status';
    status.setAttribute('role', 'alert');
    document.body.append(status);
  }
  status.textContent = `buildings unavailable: ${message.split('\n')[0] ?? message}`;
}

let buildingsLayer: BuildingsLayer | null = null;
let buildingsWanted = decodeHash(location.hash).filter.buildings !== false;
/** The filter strip calls this on mount and on every toggle; it can fire before the buildings have loaded. */
export const setBuildingsWanted = (on: boolean): void => {
  buildingsWanted = on;
  buildingsLayer?.setVisible(on);
};

// Not awaited: the terrain and areas are already usable, and a failure here only adds a status line.
void loadBuildings(buildingsUrl)
  .then((result) => {
    if ('error' in result) return reportBuildingsFailure(result.error);
    const layer = buildBuildingsLayer(result.features, meshSurface, { centre: fadeCentre });
    layer.setVisible(buildingsWanted);
    handle.scene.add(layer.mesh);
    buildingsLayer = layer;
    if (layer.dropped.length > 0) {
      console.warn(
        `buildings: ${layer.dropped.length} footprints dropped (${layer.dropped[0]?.id}: ${layer.dropped[0]?.reason})`,
      );
    }
  })
  .catch((error: unknown) => {
    reportBuildingsFailure(error instanceof Error ? error.message : String(error));
  });

/** One line in the imagery status element for the context ring; a failure here never touches the centre terrain. */
function reportContextFailure(message: string): void {
  console.error(`context: ${message}`);
  let status = document.getElementById('imagery-status');
  if (!status) {
    status = document.createElement('div');
    status.id = 'imagery-status';
    status.setAttribute('role', 'alert');
    document.body.append(status);
  }
  status.textContent = `context unavailable: ${message}`;
}

// Not awaited: the centre terrain, areas and panel are already usable; tiles that fail just stay out of the ring.
void loadContext({ frameUrl })
  .then((context) => {
    if (context.missing.length > 0) {
      reportContextFailure(
        `${context.missing.length} of ${context.tiles.length + context.missing.length} tiles missing (${context.missing[0]?.key}: ${context.missing[0]?.reason})`,
      );
    }
    if (context.tiles.length === 0) return;
    contextHandle = installContext(handle.scene, context.tiles, {
      fadeCentre,
      imageryOn: imageryWanted,
    });
    handle.setContextExtent(FADE_OUTER_M);
    const failures: string[] = [];
    return loadContextTextures(context.tiles, {
      capabilities: handle.renderer.capabilities,
      onTexture: (key, texture) => contextHandle?.setTexture(key, texture),
      onFailure: (key, reason) => failures.push(`${key}: ${reason}`),
    }).then(() => {
      if (failures.length > 0) {
        reportContextFailure(`${failures.length} tile photos failed (${failures[0]})`);
      }
    });
  })
  .catch((error: unknown) => {
    reportContextFailure(error instanceof Error ? error.message : String(error));
  });
export const areaLayer: AreaLayer | { error: string } = areaLayerResult;

import annotationsUrl from '../data/annotations.json?url';
import {
  failedAnnotationsHandle,
  wireAnnotations,
  type AnnotationsHandle,
} from './wire-annotations';

const panelRoot = document.getElementById('annotation-panel');
const tooltipRoot = document.getElementById('pick-tooltip');
if (!panelRoot || !tooltipRoot)
  throw new Error('index.html is missing #annotation-panel or #pick-tooltip');

/**
 * Resolves to the annotations handle and never rejects: a failed areas layer or any wiring error becomes a failed handle,
 * which #14 shows as "filters unavailable". An AnnotationsLoadError is already handled inside wireAnnotations (red panel state).
 */
export const annotationsReady: Promise<AnnotationsHandle> =
  'error' in areaLayer
    ? Promise.resolve(failedAnnotationsHandle(`areas unavailable: ${areaLayer.error}`))
    : wireAnnotations({
        scene: handle,
        registry: areaLayer.registry,
        annotationsUrl,
        panelRoot,
        tooltipRoot,
      }).catch((error: unknown) => {
        console.error(error);
        return failedAnnotationsHandle(error instanceof Error ? error.message : String(error));
      });

import type { AreaEntry } from './scene/areas';
import { mountFilters } from './ui/mount-filters';
import { mountViews } from './ui/views-strip';

mountViews({
  setView: (name) => handle.setView(name),
  initial: 'error' in areaLayer ? 'overview' : 'resort',
  onUserMove: (listener) => {
    handle.controls.addEventListener('start', listener);
    return () => handle.controls.removeEventListener('start', listener);
  },
});

// annotationsReady never rejects, so this needs no catch, and the .then keeps a slow annotations load from blocking the module.
void annotationsReady.then((handle) => {
  const registry: ReadonlyMap<string, AreaEntry> =
    'error' in areaLayer ? new Map() : areaLayer.registry;
  mountFilters({
    registry,
    handle,
    setImagery: setImageryWanted,
    setBuildings: setBuildingsWanted,
  });
});

export { handle, heightfield, toScene };

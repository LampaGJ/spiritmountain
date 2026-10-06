// Summit elevation probe: the maximum of the USGS 3DEP 1 m DEM (Minnesota DNR LiDAR,
// acquired 2021) over a 1 km window on the upper mountain, with an independent
// point-service cross-check. Replay: `node scripts/probes/summit-max.mjs` writes
// data/probes/summit-max.json; the GeoTIFF itself (10 MB) is not committed, its
// sha256 is. Requires geotiff and proj4 from package.json (#5).
import { fromArrayBuffer } from 'geotiff';
import proj4 from 'proj4';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const URL = 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage'
  + '?bbox=-92.228,46.712,-92.208,46.727&bboxSR=4326&imageSR=26915&size=1500,1650'
  + '&format=tiff&pixelType=F32&noData=-9999&interpolation=RSP_NearestNeighbor&f=image';
proj4.defs('EPSG:26915', '+proj=utm +zone=15 +datum=NAD83 +units=m +no_defs');

const res = await fetch(URL, { headers: { 'User-Agent': 'spiritmountain-poc/0.1' } });
if (res.status !== 200 || !/image\/tiff/.test(res.headers.get('content-type') ?? '')) throw new Error(`3DEP export failed: ${res.status}`);
const ab = await res.arrayBuffer();
const sha256 = createHash('sha256').update(new Uint8Array(ab)).digest('hex');
const img = await (await fromArrayBuffer(ab)).getImage();
const w = img.getWidth(); const [ox, oy] = img.getOrigin(); const [rx, ry] = img.getResolution();
const r = (await img.readRasters())[0];
let max = -Infinity; let mi = -1; let valid = 0;
for (let i = 0; i < r.length; i++) { const v = r[i]; if (Number.isFinite(v) && v > -1000) { valid++; if (v > max) { max = v; mi = i; } } }
const px = mi % w; const py = Math.floor(mi / w);
const e = ox + (px + 0.5) * rx; const n = oy + (py + 0.5) * ry;
const [lon, lat] = proj4('EPSG:26915', 'EPSG:4326', [e, n]);
const epqs = await (await fetch(`https://epqs.nationalmap.gov/v1/json?x=${lon}&y=${lat}&units=Meters&wkid=4326&includeDate=true`)).json();
const out = {
  source: 'USGS 3DEP 1 m DEM (Minnesota DNR LiDAR); exportImage over a 1 km window, EPSG:26915',
  inputUrl: URL, inputSha256: sha256, validCells: valid,
  summit: { elevM: max, easting26915: e, northing26915: n, lon, lat },
  crossCheck: { service: 'epqs.nationalmap.gov', elevM: Number(epqs.value), acquisitionDate: epqs.attributes?.AcquisitionDate ?? null },
};
writeFileSync('data/probes/summit-max.json', JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out));

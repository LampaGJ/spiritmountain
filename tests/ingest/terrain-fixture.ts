import { writeArrayBuffer } from 'geotiff';

export interface FixtureOptions {
  width: number;
  height: number;
  values: number[];
  /** Raw GDAL_NODATA text; the writer appends a trailing NUL. */
  nodata?: string;
  epsg?: number;
  /** 1 = PixelIsArea, 2 = PixelIsPoint. */
  rasterType?: number;
  minX?: number;
  maxY?: number;
  resolution?: number;
}

/** Builds a tiny single-band Float32 GeoTIFF with geotiff.js's own writer (big-endian), so no binary fixture is committed. */
export function buildFixtureTiff(options: FixtureOptions): Uint8Array {
  const resolution = options.resolution ?? 5;
  const metadata: Parameters<typeof writeArrayBuffer>[1] = {
    width: options.width,
    height: options.height,
    ModelPixelScale: [resolution, resolution, 0],
    ModelTiepoint: [0, 0, 0, options.minX ?? 558000, options.maxY ?? 5175000, 0],
    GTModelTypeGeoKey: 1,
    GTRasterTypeGeoKey: options.rasterType ?? 1,
    ProjectedCSTypeGeoKey: options.epsg ?? 26915,
  };
  if (options.nodata !== undefined) metadata.GDAL_NODATA = options.nodata;
  return new Uint8Array(writeArrayBuffer(Float32Array.from(options.values), metadata));
}

/** A 5 x 5 grid, value 200 + 10 * row + col, with three cells set to the sentinel: (0,0), (2,2), (4,2). */
export function grid5x5WithNodata(sentinel: number): number[] {
  const values: number[] = [];
  for (let row = 0; row < 5; row += 1) {
    for (let col = 0; col < 5; col += 1) values.push(200 + 10 * row + col);
  }
  for (const index of [0, 12, 22]) values[index] = sentinel;
  return values;
}

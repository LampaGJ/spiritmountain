import { FrameSchema } from '../schema/frame';
import { TerrainHeaderSchema, type TerrainHeader } from '../schema/terrain';
import type { Heightfield } from '../scene/heightfield';

export type TerrainLoadErrorCode =
  | 'HTTP_STATUS'
  | 'HEADER_PARSE'
  | 'FRAME_PARSE'
  | 'FRAME_HASH'
  | 'EMPTY_BODY'
  | 'BYTE_LENGTH'
  | 'NON_FINITE'
  | 'OUT_OF_RANGE'
  | 'NO_CRYPTO';

/** A load failure with a machine-readable code. The loader never returns an empty or partial heightfield. */
export class TerrainLoadError extends Error {
  readonly code: TerrainLoadErrorCode;
  constructor(code: TerrainLoadErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'TerrainLoadError';
    this.code = code;
  }
}

export interface LoadTerrainOptions {
  readonly headerUrl: string;
  readonly binUrl: string;
  readonly frameUrl: string;
  /** Injected so tests run in node with stubbed Responses. Defaults to the global fetch. */
  readonly fetchImpl?: typeof fetch;
}

export interface LoadedTerrain {
  readonly header: TerrainHeader;
  readonly heightfield: Heightfield;
}

/** Elevation tolerance (metres) when checking values against the header's rounded minElev and maxElev. */
const RANGE_TOLERANCE_M = 1e-3;

async function getOk(fetchImpl: typeof fetch, url: string): Promise<Response> {
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new TerrainLoadError('HTTP_STATUS', `${url} returned HTTP ${response.status}`);
  }
  return response;
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new TerrainLoadError('NO_CRYPTO', 'crypto.subtle is unavailable (needs https or localhost)');
  }
  const digest = new Uint8Array(await subtle.digest('SHA-256', bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * @displayName Terrain loader
 * @strategicPurpose Consumer gate for the terrain seam: the browser never interprets data/terrain.f32 from a guessed layout, and an upstream rename or truncation fails here instead of rendering a flat or spiked mesh.
 * @tacticalObjective Fetches terrain.json, frame.json and terrain.f32; parses the header with TerrainHeaderSchema and the frame with FrameSchema; checks the frame sha256 recorded in the header, the byte length (width * height * 4), finiteness and range; reads little-endian Float32 with DataView; returns a Heightfield whose origin is the first cell centre.
 *
 * The emitter gate for these artifacts lives in #9. This module takes the consumer gate only (asymmetric by decision).
 */
export async function loadTerrain(options: LoadTerrainOptions): Promise<LoadedTerrain> {
  const fetchImpl = options.fetchImpl ?? fetch;

  const headerResponse = await getOk(fetchImpl, options.headerUrl);
  let headerJson: unknown;
  try {
    headerJson = await headerResponse.json();
  } catch (error) {
    throw new TerrainLoadError('HEADER_PARSE', `${options.headerUrl} is not JSON (${String(error)})`);
  }
  const parsedHeader = TerrainHeaderSchema.safeParse(headerJson);
  if (!parsedHeader.success) {
    const issues = parsedHeader.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new TerrainLoadError('HEADER_PARSE', issues.join('; '));
  }
  const header = parsedHeader.data;

  const frameBytes = await (await getOk(fetchImpl, options.frameUrl)).arrayBuffer();
  let frameJson: unknown;
  try {
    frameJson = JSON.parse(new TextDecoder().decode(frameBytes));
  } catch (error) {
    throw new TerrainLoadError('FRAME_PARSE', `${options.frameUrl} is not JSON (${String(error)})`);
  }
  const parsedFrame = FrameSchema.safeParse(frameJson);
  if (!parsedFrame.success) {
    const issues = parsedFrame.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new TerrainLoadError('FRAME_PARSE', issues.join('; '));
  }
  const frameSha = await sha256Hex(frameBytes);
  if (frameSha !== header.frame.sha256) {
    throw new TerrainLoadError(
      'FRAME_HASH',
      `frame.json sha256 ${frameSha} does not match the header's ${header.frame.sha256}`,
    );
  }

  const bin = await (await getOk(fetchImpl, options.binUrl)).arrayBuffer();
  if (bin.byteLength === 0) {
    throw new TerrainLoadError('EMPTY_BODY', `${options.binUrl} is zero bytes`);
  }
  const expected = header.width * header.height * 4;
  if (bin.byteLength !== expected) {
    throw new TerrainLoadError(
      'BYTE_LENGTH',
      `${options.binUrl} is ${bin.byteLength} bytes, header says ${header.width} x ${header.height} x 4 = ${expected}`,
    );
  }

  const view = new DataView(bin);
  const data = new Float32Array(header.width * header.height);
  let nonFinite = 0;
  let outOfRange = 0;
  for (let i = 0; i < data.length; i += 1) {
    const value = view.getFloat32(i * 4, true);
    data[i] = value;
    if (!Number.isFinite(value)) nonFinite += 1;
    else if (value < header.minElev - RANGE_TOLERANCE_M || value > header.maxElev + RANGE_TOLERANCE_M) {
      outOfRange += 1;
    }
  }
  if (nonFinite > 0) {
    throw new TerrainLoadError('NON_FINITE', `${nonFinite} of ${data.length} values are NaN or infinite`);
  }
  if (outOfRange > 0) {
    throw new TerrainLoadError(
      'OUT_OF_RANGE',
      `${outOfRange} values fall outside the header range ${header.minElev}..${header.maxElev}`,
    );
  }

  // The header origin is the top-left CORNER of the top-left pixel; samples sit at pixel centres.
  const heightfield: Heightfield = {
    cols: header.width,
    rows: header.height,
    originEast: header.originX + 0.5 * header.cellSizeX,
    originNorth: header.originY - 0.5 * header.cellSizeY,
    cellSizeEast: header.cellSizeX,
    cellSizeNorth: header.cellSizeY,
    data,
  };
  return { header, heightfield };
}

import { z } from 'zod';
import { FrameSchema } from '../../src/schema/frame';
import { ManifestSchema } from './manifest-schema';

export { LOCKFILE_URL, lockSubtreeSha256, resolveCodeCommit, sha256Hex } from './replay';

/**
 * @displayName Terrain transform dependencies on #7
 * @strategicPurpose The only transform file that names symbols owned by the fetch issue (#7), so a rename there is a one-file edit and tsc reports it.
 * @tacticalObjective Reads data/frame.json and data/raw/manifest.json through their schemas and returns only what the transform needs.
 */
export interface Frame {
  originE: number;
  originN: number;
}

export interface GridBbox {
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
}

export interface ThreeDepPin {
  sha256: string;
  width: number;
  height: number;
  byteOrder: 'little' | 'big';
  bbox: GridBbox;
  stats: { min: number; max: number };
}

const JsonTextSchema = z.string().min(1);

/** Parses data/frame.json bytes with FrameSchema (src/schema/frame.ts). */
export function readFrame(bytes: Uint8Array): Frame {
  const text = JsonTextSchema.parse(Buffer.from(bytes).toString('utf8'));
  const parsed = FrameSchema.parse(JSON.parse(text));
  return { originE: parsed.origin.easting, originN: parsed.origin.northing };
}

/** Parses data/raw/manifest.json bytes with #7's ManifestSchema and returns the 3DEP pin. */
export function readThreeDepPin(bytes: Uint8Array): ThreeDepPin {
  const text = JsonTextSchema.parse(Buffer.from(bytes).toString('utf8'));
  const entry = ManifestSchema.parse(JSON.parse(text)).threeDep;
  return {
    sha256: entry.sha256,
    width: entry.width,
    height: entry.height,
    byteOrder: entry.byteOrder,
    bbox: entry.decodedBbox26915,
    stats: { min: entry.stats.min, max: entry.stats.max },
  };
}

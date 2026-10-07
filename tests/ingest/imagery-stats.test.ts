import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import ts from 'typescript';
import { encode } from 'jpeg-js';
import { describe, expect, it } from 'vitest';
import {
  TRANSFORM_SOURCES,
  computeImageryStats,
  runImageryStats,
  srgbToLinear,
} from '../../scripts/ingest/imagery-stats';
import { sha256Hex } from '../../scripts/ingest/replay';
import { ImageryStatsSchema } from '../../src/schema/imagery-stats';

/** Two black and two white pixels, row-major RGBA, encoded at maximum quality. */
function blackWhiteJpeg(): Uint8Array {
  const data = Buffer.from([0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 255]);
  return encode({ width: 2, height: 2, data }, 100).data;
}

describe('imagery-stats transform sources', () => {
  it('TRANSFORM_SOURCES is exactly the transitive repo-import closure of imagery-stats.ts', () => {
    const seen = new Set<string>();
    const visit = (file: string): void => {
      if (seen.has(file)) return;
      seen.add(file);
      for (const { fileName } of ts.preProcessFile(readFileSync(file, 'utf8'), true, true)
        .importedFiles) {
        if (!fileName.startsWith('.') || fileName.endsWith('.json')) continue;
        const base = join(dirname(file), fileName);
        const found = [`${base}.ts`, join(base, 'index.ts')].find((c) => existsSync(c));
        if (found === undefined) throw new Error(`cannot resolve ${fileName} from ${file}`);
        visit(relative('.', found));
      }
    };
    visit('scripts/ingest/imagery-stats.ts');
    expect([...TRANSFORM_SOURCES].sort()).toEqual([...seen].sort());
  });
});

describe('computeImageryStats on a synthetic 2x2 JPEG', () => {
  const source = { path: 'data/raw/naip.jpg', sha256: 'a'.repeat(64) };

  it('averages two black and two white pixels to about 127.5 per channel in sRGB', () => {
    const stats = computeImageryStats(blackWhiteJpeg(), source);
    expect(stats.pixelCount).toBe(4);
    for (const c of ['r', 'g', 'b'] as const) {
      expect(Math.abs(stats.meanSrgb255[c] - 127.5)).toBeLessThan(2);
      // Linear light of black and white averages to 0.5, far from the sRGB mid-grey 0.2140.
      expect(Math.abs(stats.meanLinear[c] - 0.5)).toBeLessThan(0.02);
    }
  });

  it('is byte-stable across runs', () => {
    const a = JSON.stringify(computeImageryStats(blackWhiteJpeg(), source));
    const b = JSON.stringify(computeImageryStats(blackWhiteJpeg(), source));
    expect(a).toBe(b);
  });

  it('srgbToLinear hits the known anchors', () => {
    expect(srgbToLinear(0)).toBe(0);
    expect(srgbToLinear(1)).toBeCloseTo(1, 12);
    expect(srgbToLinear(0.5)).toBeCloseTo(0.214041, 5);
  });
});

describe('runImageryStats', () => {
  const sandbox = () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'imagery-stats-'));
    mkdirSync(join(dataDir, 'raw'));
    const jpeg = blackWhiteJpeg();
    writeFileSync(join(dataDir, 'raw/naip.jpg'), jpeg);
    const manifest = JSON.parse(readFileSync('data/raw/imagery-manifest.json', 'utf8')) as Record<
      string,
      unknown
    >;
    manifest['sha256'] = sha256Hex(jpeg);
    manifest['width'] = 2;
    manifest['height'] = 2;
    manifest['bbox'] = { xmin: 0, ymin: 0, xmax: 2, ymax: 2 };
    manifest['metresPerPixel'] = 1;
    return { dataDir, manifest };
  };
  const options = (dataDir: string) => ({
    dataDir,
    lockSubtree: 'b'.repeat(64),
    resolveCommit: () => 'c'.repeat(40),
  });

  it('refuses a JPEG whose sha256 differs from the manifest pin', () => {
    const { dataDir, manifest } = sandbox();
    manifest['sha256'] = '0'.repeat(64);
    writeFileSync(join(dataDir, 'raw/imagery-manifest.json'), JSON.stringify(manifest));
    expect(() => runImageryStats(options(dataDir))).toThrow(/PinnedInputHashMismatch/);
  });

  it('refuses a JPEG whose size differs from the manifest', () => {
    // The real manifest keeps its 4000x3879 aspect, so a 2x2 file mismatches on size.
    const dataDir = mkdtempSync(join(tmpdir(), 'imagery-stats-'));
    mkdirSync(join(dataDir, 'raw'));
    const jpeg = blackWhiteJpeg();
    writeFileSync(join(dataDir, 'raw/naip.jpg'), jpeg);
    const manifest = JSON.parse(readFileSync('data/raw/imagery-manifest.json', 'utf8')) as Record<
      string,
      unknown
    >;
    manifest['sha256'] = sha256Hex(jpeg);
    writeFileSync(join(dataDir, 'raw/imagery-manifest.json'), JSON.stringify(manifest));
    expect(() => runImageryStats(options(dataDir))).toThrow(/ManifestDimensionMismatch/);
  });

  it('writes stats and a reduces replay whose outputHash matches the stats bytes', () => {
    const { dataDir, manifest } = sandbox();
    writeFileSync(join(dataDir, 'raw/imagery-manifest.json'), JSON.stringify(manifest));
    const { stats, replay } = runImageryStats(options(dataDir));
    const text = readFileSync(join(dataDir, 'imagery-stats.json'), 'utf8');
    expect(ImageryStatsSchema.parse(JSON.parse(text))).toEqual(stats);
    expect(replay.effect).toBe('reduces');
    expect(replay.inputHash).toBe(stats.source.sha256);
    expect(replay.outputHash).toBe(sha256Hex(text));
    expect(existsSync(join(dataDir, 'imagery-stats.replay.json'))).toBe(true);
  });
});

describe('the committed imagery stats', () => {
  it('match the pinned imagery manifest and the expected pixel count', () => {
    const stats = ImageryStatsSchema.parse(
      JSON.parse(readFileSync('data/imagery-stats.json', 'utf8')),
    );
    const manifest = JSON.parse(readFileSync('data/raw/imagery-manifest.json', 'utf8')) as {
      sha256: string;
    };
    expect(stats.source.sha256).toBe(manifest.sha256);
    expect(stats.pixelCount).toBe(4000 * 3879);
  });
});

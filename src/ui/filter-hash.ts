import { z } from 'zod';
import { ActivitySchema, SeasonSchema } from '../schema/annotation';
import type { Filter } from './filter-predicate';

/**
 * @displayName Filter hash state
 * @strategicPurpose Makes a filtered view shareable as a URL fragment and parses pasted links at the boundary.
 * @tacticalObjective Validates the activity and season lists and the imagery switch decoded from location.hash against the annotation enums and the on/off token.
 */
export const HashFilterSchema = z.strictObject({
  activity: z.array(ActivitySchema),
  season: z.array(SeasonSchema),
  /** Absent means the default (imagery on); only false is ever encoded, as `imagery=off`. */
  imagery: z.boolean().optional(),
});

/** The imagery hash token: `off` or `on`, parsed to a boolean. Anything else is dropped and reported. */
export const ImageryTokenSchema = z.enum(['on', 'off']).transform((token) => token === 'on');
export type HashFilter = z.infer<typeof HashFilterSchema>;

export interface DecodedHash {
  filter: HashFilter;
  ignored: string[];
}

const inOrder = <T extends string>(options: readonly T[], values: Iterable<string>): T[] => {
  const seen = new Set(values);
  return options.filter((o) => seen.has(o));
};

/** Parses a hash at the boundary: per-token safeParse, bad tokens and unknown keys dropped and reported in `ignored`. */
export function decodeHash(hash: string): DecodedHash {
  const got = { activity: new Set<string>(), season: new Set<string>() };
  const ignored: string[] = [];
  let imagery = true;
  for (const pair of hash.replace(/^#/, '').split('&').filter(Boolean)) {
    const eq = pair.indexOf('=');
    const key = eq < 0 ? pair : pair.slice(0, eq);
    const value = eq < 0 ? '' : pair.slice(eq + 1);
    if (key === 'imagery') {
      const token = ImageryTokenSchema.safeParse(value);
      if (!token.success) ignored.push(pair);
      else imagery = token.data;
      continue;
    }
    if (key !== 'activity' && key !== 'season') {
      ignored.push(pair);
      continue;
    }
    const schema = key === 'activity' ? ActivitySchema : SeasonSchema;
    for (const token of value.replace(/%2c/gi, ',').split(',')) {
      if (schema.safeParse(token).success) got[key].add(token);
      else ignored.push(token);
    }
  }
  const filter = HashFilterSchema.parse({
    activity: inOrder(ActivitySchema.options, got.activity),
    season: inOrder(SeasonSchema.options, got.season),
    ...(imagery ? {} : { imagery: false }),
  });
  return { filter, ignored };
}

// Emitter gate skipped by decision (CLAUDE.md:29 "the out"): encodeHash emits only the owned keys activity and season, derived from an already-parsed HashFilter, and hands off in-process to decodeHash, which parses. It never assembles from raw input: unknown keys are dropped, not re-emitted.
/** Canonical string: activity, season in schema option order, then `imagery=off` when imagery is off; "" when empty. */
export function encodeHash(filter: HashFilter): string {
  const owned: [string, string][] = [];
  const activity = inOrder(ActivitySchema.options, filter.activity);
  const season = inOrder(SeasonSchema.options, filter.season);
  if (activity.length > 0) owned.push(['activity', activity.join(',')]);
  if (season.length > 0) owned.push(['season', season.join(',')]);
  if (filter.imagery === false) owned.push(['imagery', 'off']);
  const pairs = owned.map(([k, v]) => `${k}=${v}`).join('&');
  return pairs === '' ? '' : `#${pairs}`;
}

/** The single array-to-Set conversion point. */
export const toFilter = (h: HashFilter): Filter => ({
  activities: new Set(h.activity),
  seasons: new Set(h.season),
});

export const toHashFilter = (f: Filter): HashFilter => ({
  activity: [...f.activities],
  season: [...f.seasons],
});

/** Visible notice for dropped tokens, or null when nothing was dropped. */
export function ignoredNotice(ignored: readonly string[]): string | null {
  if (ignored.length === 0) return null;
  return `ignored: ${ignored.map((t) => (t === '' ? '(empty)' : t)).join(', ')}`;
}

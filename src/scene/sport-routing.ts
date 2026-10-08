/**
 * Which sport colours a trail line (#40). Pure (no three import), so it tests in node.
 *
 * An area carries activities in its annotation, the Activity filter selects some, and sportForArea picks one activity
 * per area from those two inputs. SPORT_COLOR (src/scene/palette.ts) maps that activity to the line colour.
 */
import type { z } from 'zod';
import type { Area, AreaKind } from '../schema/area';
import type { ActivitySchema, Annotation } from '../schema/annotation';

export type Activity = z.infer<typeof ActivitySchema>;

/**
 * The activity an area is assumed to carry when its annotation names none (or there is no annotation). Total over
 * AreaKind, so sportForArea always returns an activity. snow-park falls back to alpine-ski.
 */
export const KIND_DEFAULT_ACTIVITY: Record<AreaKind, Activity> = {
  'downhill-run': 'alpine-ski',
  'nordic-trail': 'nordic-classic',
  'mtb-trail': 'mountain-bike',
  'mtb-route': 'mountain-bike',
  'snow-park': 'alpine-ski',
  lift: 'lift-ride',
  'hiking-trail': 'hike',
};

/**
 * The sport one area is drawn as: the first annotated activity that is in `selected`, else the first annotated
 * activity, else the kind default. No single-selection gate, because matchesFilter already ORs over the set
 * (src/ui/filter-predicate.ts).
 */
export function sportForArea(
  area: Pick<Area, 'kind'>,
  annotation: Annotation | undefined,
  selected: ReadonlySet<Activity>,
): Activity {
  const carried: Activity[] = annotation
    ? annotation.activities.map((entry) => entry.activity)
    : [];
  for (const activity of carried) {
    if (selected.has(activity)) return activity;
  }
  return carried[0] ?? KIND_DEFAULT_ACTIVITY[area.kind];
}

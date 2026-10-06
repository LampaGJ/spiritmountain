import { AreaSchema, type Area } from '../../src/schema/area';
import { AnnotationSchema, type Annotation } from '../../src/schema/annotation';

export function makeArea(id: string, kind: Area['kind']): Area {
  return AreaSchema.parse({
    id,
    kind,
    name: null,
    difficulty: null,
    geometry: {
      type: 'LineString',
      coordinates: [
        [0, 0, 0],
        [1, 1, 0],
      ],
    },
    osmTags: {},
  });
}

export function entry(
  activity: Annotation['activities'][number]['activity'],
  seasons: Annotation['activities'][number]['seasons'],
): Annotation['activities'][number] {
  return { activity, seasons, notes: '' };
}

export function makeAnnotation(areaId: string, activities: Annotation['activities']): Annotation {
  return AnnotationSchema.parse({ areaId, activities, stakeholders: [], notes: '' });
}

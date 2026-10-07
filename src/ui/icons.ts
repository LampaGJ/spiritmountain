import { z } from 'zod';
import iconData from './icons.json';

/**
 * @displayName Control icon map
 * @strategicPurpose One reviewed table that says which Material Symbols Outlined glyph and which title-case label every control carries, so no caller invents a glyph name or shows a kebab-case id.
 * @tacticalObjective Parses icons.json once at import time (fails loudly on a bad shape) and exposes iconFor(id) for the key builders and group headers.
 */
const IconEntrySchema = z.object({
  /** The Material Symbols Outlined ligature name, rendered as text inside an aria-hidden `.ms` span. */
  symbol: z.string().regex(/^[a-z0-9_]+$/),
  /** The visible title-case label. */
  label: z.string().min(1),
  /** Why this glyph; kept for review, never rendered. */
  rationale: z.string(),
});
export type IconEntry = z.infer<typeof IconEntrySchema>;

export const ICONS: Readonly<Record<string, IconEntry>> = z
  .record(z.string(), IconEntrySchema)
  .parse(iconData);

/** Looks up a control by its internal (kebab-case) id. Throws on an unknown id so a typo cannot ship a blank key. */
export function iconFor(id: string): IconEntry {
  const entry = ICONS[id];
  if (entry === undefined) throw new Error(`no icon entry for control "${id}"`);
  return entry;
}

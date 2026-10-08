import './hero-sign.css';
import { ActivitySchema } from '../schema/annotation';
import { HERO_PLACE_ID, labelColorFor, type PlacePlan, type ScreenRect } from '../scene/billboards';
import { SPORT_COLOR } from '../scene/palette';
import { signGlyph } from './icons';

const cssHex = (hex: number): string => `#${hex.toString(16).padStart(6, '0')}`;

export interface HeroSign {
  readonly element: HTMLElement;
  /** Re-renders from the planned place signs; hides when the hero place is absent (no member trail after the filter). */
  render(plans: readonly PlacePlan[]): void;
  /** The sign's current screen rect in CSS pixels (read live, so it follows resize and re-render); null when hidden (#66). */
  rect(): ScreenRect | null;
  dispose(): void;
}

/**
 * @displayName Hero sign
 * @strategicPurpose Makes the Spirit Mountain Adventure Park sign the MAIN sign of the map: always on screen, centred
 *   under the season bar, larger than any sprite sign (#63).
 * @tacticalObjective Renders the hero place's PlacePlan (name in bold, trail count beneath, one centred sport chip per
 *   activity in ActivitySchema order) as a DOM element built with createElement only, and hides it when the place has
 *   no member trail.
 */
export function createHeroSign(parent: HTMLElement, placeId: string = HERO_PLACE_ID): HeroSign {
  const element = document.createElement('div');
  element.id = 'hero-sign';
  element.hidden = true;
  element.setAttribute('role', 'status');
  const name = document.createElement('div');
  name.className = 'hero-name';
  const count = document.createElement('div');
  count.className = 'hero-count';
  const chips = document.createElement('div');
  chips.className = 'hero-chips';
  element.append(name, count, chips);
  parent.append(element);

  return {
    element,
    render(plans) {
      const plan = plans.find((p) => p.id === placeId);
      if (plan === undefined || plan.trailCount === 0) {
        element.hidden = true;
        return;
      }
      name.textContent = plan.name;
      count.textContent = `${plan.trailCount} ${plan.trailCount === 1 ? 'trail' : 'trails'}`;
      chips.replaceChildren(
        ...ActivitySchema.options
          .filter((a) => plan.activities.includes(a))
          .map((activity) => {
            const chip = document.createElement('span');
            chip.className = 'hero-chip';
            chip.dataset['activity'] = activity;
            chip.style.background = cssHex(SPORT_COLOR[activity]);
            chip.style.color = cssHex(labelColorFor(SPORT_COLOR[activity]));
            const glyph = document.createElement('span');
            glyph.className = 'ms';
            glyph.textContent = signGlyph(activity).symbol;
            glyph.setAttribute('aria-hidden', 'true');
            chip.title = signGlyph(activity).label;
            chip.append(glyph);
            return chip;
          }),
      );
      element.hidden = false;
    },
    rect() {
      if (element.hidden) return null;
      const r = element.getBoundingClientRect();
      return r.width > 0 && r.height > 0
        ? { x: r.left, y: r.top, w: r.width, h: r.height, distance: 0, priority: -1 }
        : null;
    },
    dispose() {
      element.remove();
    },
  };
}

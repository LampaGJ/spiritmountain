// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { HERO_PLACE_ID, type PlacePlan } from '../../src/scene/billboards';
import { ActivitySchema } from '../../src/schema/annotation';
import { createHeroSign } from '../../src/ui/hero-sign';
import { signGlyph } from '../../src/ui/icons';

const plan = (over: Partial<PlacePlan> = {}): PlacePlan => ({
  id: HERO_PLACE_ID,
  name: 'Spirit Mountain Adventure Park',
  trailCount: 7,
  // Deliberately reversed: the chips must follow ActivitySchema order.
  activities: [...ActivitySchema.options].reverse().slice(0, 3),
  ...over,
});

describe('createHeroSign', () => {
  it('renders the name, the trail count and one chip per activity in schema order', () => {
    const hero = createHeroSign(document.body);
    hero.render([plan()]);
    expect(hero.element.hidden).toBe(false);
    expect(hero.element.querySelector('.hero-name')?.textContent).toBe(
      'Spirit Mountain Adventure Park',
    );
    expect(hero.element.querySelector('.hero-count')?.textContent).toBe('7 trails');
    const chips = [...hero.element.querySelectorAll<HTMLElement>('.hero-chip')];
    const expected = ActivitySchema.options.filter((a) => plan().activities.includes(a));
    expect(chips.map((c) => c.dataset['activity'])).toEqual(expected);
    expect(chips.map((c) => c.textContent)).toEqual(expected.map((a) => signGlyph(a).symbol));
    hero.dispose();
  });

  it('says "1 trail" for one', () => {
    const hero = createHeroSign(document.body);
    hero.render([plan({ trailCount: 1 })]);
    expect(hero.element.querySelector('.hero-count')?.textContent).toBe('1 trail');
    hero.dispose();
  });

  it('hides when the hero place is absent or has zero trails, and shows again', () => {
    const hero = createHeroSign(document.body);
    hero.render([plan()]);
    hero.render([]);
    expect(hero.element.hidden).toBe(true);
    hero.render([plan({ trailCount: 0 })]);
    expect(hero.element.hidden).toBe(true);
    hero.render([plan({ id: 'other-place' })]);
    expect(hero.element.hidden).toBe(true);
    hero.render([plan()]);
    expect(hero.element.hidden).toBe(false);
    hero.dispose();
    expect(document.getElementById('hero-sign')).toBeNull();
  });
});

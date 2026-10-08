---
type: reference
status: draft
review_by: 2027-04-01
related: [scripts/ingest/annotations-core.ts, scripts/ingest/areas.ts, src/scene/sport-routing.ts]
---
# Activity audit: the twelve activities and their sources

TL;DR: every one of the twelve activities now has a seed rule that puts it on the map. Each rule that adds an activity OSM does not state cites an original page, and that page's URL is written into the annotation notes. Four rules rest on pages that do not name the trails or the months; those gaps are listed below and written into the notes. Page text was read through WebFetch summaries, so each line is a paraphrase, not a quote.

Question: which seed rules in `scripts/ingest/annotations-core.ts` does an original source corroborate? Issue: https://github.com/LampaGJ/spiritmountain/issues/69

## Rules that came from OSM kinds (no added source)

- alpine-ski and snowboard: downhill-run and snow-park, winter and spring.
- nordic-classic and nordic-skate: nordic-trail, winter.
- mountain-bike: mtb-trail and mtb-route, spring summer fall.
- hike and trail-run: hiking-trail (the Superior Hiking Trail), spring summer fall.
- lift-ride: every lift, winter. Each of these is a structural default, noted "derived from OSM kind".

## Rules that carry a source

- tubing, winter, on the tubing-run and on a lift whose name matches /tubing/i. Source: https://spiritmt.com/winter/tubing/ (Tubing Hill served by a tubing lift; season ends mid March). The page does not say "Handle Tow", so the OSM name is not confirmed by it.
- snowshoe, winter, on nordic-trail. Source: https://spiritmt.com/winter/nordic/ (rental snowshoes at the Upper Nordic Building on weekends; trails not specified on the page).
- fat-bike, winter, on mtb-trail and mtb-route. Source: https://spiritmt.com/winter/downhill/ (fat bikes acknowledged with a rider-responsibility statement; trails not specified on the page).
- adaptive, winter and spring, on downhill-run and snow-park. Source: https://spiritmt.com/?p=34 (lessons page lists Northland Adaptive). The page gives no season and names no runs.
- hike and trail-run, spring summer fall, on mtb-trail and mtb-route. Source: https://coggs.com/ (all COGGS trails open to human-powered, non-motorized use).
- lift-ride in summer, on the lift named Spirit Express II only. Source: https://spiritmt.com/summer/adventure-park/ (scenic chairlift; months not stated). Other lifts stay winter only.

## Derived tubing run

The areas transform emits one `tubing-run` line beside each tubing tow: id `derived/tubing-run/<lift id>`, name "Tubing Hill", the tow's vertices shifted 12 m to the right of its first-to-last direction. The run exists so the hill has a trail to colour and label. The 12 m offset is a drawing choice, not a surveyed fact.

## Gaps

- Fat-bike trails and groomer: unverified. The downhill page names no trails and no groomer. Only secondary, undated snippets (singletracks.com, gearjunkie.com) mention lift-served winter fat biking, and they were never fetched.
- Hike rule beyond COGGS: unverified. No page read states that hiking or trail running is allowed on the Duluth Traverse sections at Spirit Mountain or on the bike park trails. The COGGS home page states the general rule only.
- Lift months: unverified. The Adventure Park page names Spirit Express II as the scenic ride but the summary gives no months.
- Snowshoe trail permissions: unverified. The Nordic page states rentals only.
- Northland Adaptive season and run names: not found.
- The Fox21 fetch failed with HTTP 429 (https://www.fox21online.com/?p=5275). It was the local-news lead on fat biking at Spirit Mountain and was not retried.
- The tubing page's "last day March 14" has no year in the summary.

## Outside the twelve activities

These appear on https://spiritmt.com/summer/adventure-park/ and are not in the closed activity list, so no rule covers them: the Timber Flyer zip line, the Alpine Coaster, the Jumping Pillow, and nine-hole Putt-Putt golf. The campground (https://spiritmt.com/summer/camping/) is open May 20 to October 25, 2026, also outside the twelve.

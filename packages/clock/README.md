# @birtalanrobert/clock

Wall-clock and interval arithmetic across time zones. No dependencies, no
framework, no database.

```bash
pnpm add @birtalanrobert/clock
```

## Why it exists

Two sentences, forgotten, account for most scheduling bugs:

**A date is not an instant.** "Tuesday the fourteenth" at a salon in Bucharest
and one in Budapest are different spans of real time, and anything that
conflates them is wrong for one of them. So a `LocalDate` is a `YYYY-MM-DD`
string in some location's own reckoning, never a `Date`.

**A duration is not a difference of wall clocks.** A 22:00–06:00 shift is eight
hours on almost every night of the year, **seven** on the spring-forward night
and **nine** on the autumn one. The elapsed time between two instants is the
honest answer; it is the _boundaries_ that need the zone.

```ts
import { toInstant, localMinuteOfDay, durationMinutes } from '@birtalanrobert/clock';

// 02:30 does not exist on the spring-forward night. Say so, rather than
// silently landing an hour away.
const { instant, resolution } = toInstant('Europe/Bucharest', '2027-03-28', 150);
resolution; // 'gap'
```

## What it gives you

|                                                     |                                                                                                                                       |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `offsetMinutesAt`                                   | The offset a zone is on at an instant, read from `Intl` rather than a table — so the tz database is the runtime's and updates with it |
| `toInstant`                                         | A local wall clock to an instant, reporting `gap` and `ambiguous` rather than hiding them                                             |
| `localDateOf` · `localMinuteOfDay`                  | The reverse, in a location's own reckoning                                                                                            |
| `transitionMinutesOn`                               | How many minutes a local date actually had — 1380 or 1500, twice a year                                                               |
| `overlaps` · `intersect` · `subtract` · `normalise` | Interval arithmetic on instants                                                                                                       |

`MinuteOfDay` **may exceed 1440** on purpose: a bar open until 02:00 closes at
minute 1560 of the day it opened, not at minute 120 of the next one. That is
what makes an overnight span one interval rather than two rows something has to
remember to stitch together.

## Where it came from

Project 02's slot engine, extracted at its second consumer — project 07's rota —
under the rule that a capability two or more specifications call for belongs
here from the start. Six of the seventeen schedule against somebody's local
wall clock.

What stays in each project is the engine built _on_ this: the slot engine, the
scheduling rules engine, the costing engine. They share this substrate and no
logic.

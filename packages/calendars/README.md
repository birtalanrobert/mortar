# @birtalanrobert/calendars

Two-way calendar sync: our appointments pushed out, their busy time pulled in.

Two specifications call for it — project 02's Phase 13 and project 08's Phase 2
— and it is built for both.

## The rules come first

A one-way iCal feed cannot corrupt the diary it exports. **A two-way sync can**,
which is why `sync.ts` exists before any provider code: _what wins when both
sides change_ has to be a stated rule rather than whichever write arrived last.

1. **The diary owns appointments.** The external calendar holds a copy. If
   somebody edits or deletes that copy, the copy is wrong — not the appointment
   — and the next sync puts it back. A customer was told a time; a stylist
   dragging an event in Google has not told them anything.
2. **The external calendar owns everything else.** A dentist appointment in
   somebody's personal calendar is busy time we respect and never touch.
3. **Disconnecting changes nothing about the diary.** It removes our copies and
   forgets their busy time. Every appointment stays exactly where it was.

The asymmetry is the design. "Last write wins" between two systems that both
believe they are authoritative is how an appointment quietly moves an hour and a
customer arrives to an empty chair.

## Counting without a database

```ts
import { busyFrom, driftOf, shouldPush } from '@birtalanrobert/calendars';

// Four overlapping meetings are one stretch of unavailable time.
busyFrom(theirEvents, ourExternalIds);

// Somebody moved our copy. Put it back.
driftOf(whatWeWrote, whatIsThereNow); // { kind: 'edited', theirs }
```

The root entry point is framework-free and browser-safe. Entities, the service
and the migration are behind `/nestjs`; the adapters are behind `/google` and
`/microsoft` so a product using one does not install the other's SDK.

## Wiring it

```ts
import {
  CalendarsService,
  CALENDAR_PROVIDERS,
  CALENDAR_SEALING_KEY,
} from '@birtalanrobert/calendars/nestjs';
import { GoogleCalendar } from '@birtalanrobert/calendars/google';
import { sealingKey } from '@birtalanrobert/database';

providers: [
  CalendarsService,
  {
    provide: CALENDAR_PROVIDERS,
    useValue: new Map([['google', new GoogleCalendar({ clientId, clientSecret })]]),
  },
  { provide: CALENDAR_SEALING_KEY, useValue: sealingKey(process.env.CALENDAR_SEALING_KEY!) },
];
```

## What it deliberately does not do

- **Store their calendar.** Their events are read in a window, turned into busy
  periods, and forgotten. Keeping a copy of somebody's personal calendar would
  be holding a great deal of data about them for no benefit — a data-protection
  argument before a storage one.
- **Write into your diary.** `pull` _returns_ busy periods; the product decides
  what they mean. A shared package that wrote into a product's own tables would
  be a shared package with a foreign key into them.
- **Invite anybody.** The copy carries no attendees and no reminders. It is a
  diary for the person who owns the calendar, not a meeting request for a
  customer who already booked.

## Two traps, both paid for

**A refresh token arrives once.** Both providers issue one on first consent and
then stop sending it. A caller that overwrites the stored token with `undefined`
on every refresh disconnects every calendar within the hour. `connect` refuses a
grant with no refresh token for the same reason, rather than accepting one that
dies at lunchtime.

**Graph returns local time plus a zone name.** Not an instant. Parsed without
applying the zone it is however many hours out the server happens to be, and it
looks entirely plausible on screen.

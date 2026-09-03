# @birtalanrobert/messaging

SMS segment counting, quiet hours, pumping detection and a message credit
ledger.

Four things every product that sends text messages gets wrong in the same
order: it prices a message the way a person counts characters rather than the
way a provider counts segments; it sends at three in the morning; it pays for
traffic somebody manufactured; and it keeps a balance as a number nobody can
explain. None of that is specific to a domain, which is why it is here rather
than written a second time.

## The pure half

```ts
import { countSegments, isQuiet, nextAllowed, assessSmsRisk } from '@birtalanrobert/messaging';
```

No database, no framework, no Node built-ins — a console counts segments on
every keystroke, and that has to work in a browser.

### Segments, not characters

```ts
countSegments('Comanda dumneavoastră este gata');
// { encoding: 'unicode', segments: 1, remaining: 39, offenders: ['ă'] }
```

A provider charges per segment, and a single character outside the GSM 03.38
alphabet changes the encoding for the **whole** message: 160 characters per
segment becomes 70. One `ș` in a Romanian sentence more than doubles what it
costs to send, which is why `offenders` names the characters responsible rather
than only reporting the encoding. "Your ș and ț are doubling the cost" is
something a person can act on; "this message is unicode" is not.

### Quiet hours

```ts
isQuiet(new Date(), { from: 19, to: 9, timezone: 'Europe/Bucharest' });
nextAllowed(new Date(), quietHours); // when it may go instead
```

The zone is the **business's**, not the recipient's. A phone number says
nothing about where somebody is sitting, and the business's zone is the one
they would have been telephoned from anyway — a client abroad gets a message at
nine local rather than eight, which is a far smaller wrong than 03:00.

### Pumping

```ts
assessSmsRisk({ phone, sentToCountryInLastHour, ... });
```

SMS pumping is fraud that costs money rather than data: a script requests
verification messages to premium-rate ranges the attacker earns a share of. It
is not detectable per message, only in the shape of recent traffic.

## The ledger

```ts
import {
  MessageCreditsService,
  messagingEntities,
  messagingMigrations,
} from '@birtalanrobert/messaging/nestjs';
```

Register the entities and migrations with the database module.

```ts
await credits.debit(tenantId, countSegments(body).segments, ticketId, 'Uncollected notice');
await credits.balance(tenantId); // { balance, entries }
```

A ledger rather than a counter: "why has my balance gone down by four hundred"
is unanswerable against a number and obvious against a list of entries that each
name what they were spent on. The balance is a sum over the entries rather than
a column, because a column and a list that disagree is a support conversation
nobody can win. Entries are append-only in the database; a correction is a new
entry with the opposite sign.

`canAfford` asks a question rather than enforcing an answer. What to do when
there is not enough — hold, refuse, send anyway and invoice — is the owning
product's decision, and this package should not make it on their behalf.

There is no foreign key from an entry to what it paid for: one product debits
against a repair ticket and another against a document request, and a key to
either is exactly what would stop the table being shared.

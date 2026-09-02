# @birtalanrobert/workflow

Lifecycle state machines, due-date arithmetic and signed public links.

## Using it in a NestJS application

```ts
import { WorkflowModule } from '@birtalanrobert/workflow/nestjs';

@Module({
  imports: [
    // …config, logger, database…
    WorkflowModule.forRootAsync({
      inject: [ConfigModule.token()],
      useFactory: (config: AppConfig) => ({
        secret: config.LINK_SECRET,
        defaultTtlMs: config.LINK_TTL,
      }),
    }),
  ],
})
export class AppModule {}
```

`@Global()`, and it provides `LinkService`. Register `workflowEntities` and
`workflowMigrations` with the database module — the revocation table is what
lets one link be killed without rotating the secret and invalidating every link
in the system.

The secret is refused at construction if it is under 32 characters. Finding
that out when the first client opens a link is too late.

## Issuing and verifying

```ts
constructor(private readonly links: LinkService) {}

const { token, claims } = await this.links.issue({
  subject: `request:${request.id}`,
  tenantId,
  party: party.key,   // where a subject has several participants
});

const result = await this.links.verify(token);
if (!result.ok) throw new UnauthenticatedError('That link is not valid.');
```

`reissue` revokes the link it replaces in the same call, and `revoke` kills one
without touching the rest.

**Check `permits` at the point of use as well**, not only at verification: a
token valid for one request must not be accepted by a handler holding another
id.

```ts
if (!permits(claims, { subject: `request:${request.id}`, party: party.key })) {
  throw new UnauthenticatedError('That link is not valid.');
}
```

## Verifying without NestJS

The **root entry point is framework-free and pulls in no database driver**, so a
Next.js server component or an edge function verifies a token without installing
an ORM:

```ts
import { verifyLink } from '@birtalanrobert/workflow';

const result = await verifyLink(token, process.env.LINK_SECRET!);
```

Verification without a revocation check is the trade: it tells an expired link
from an invalid one for free, and the API checks revocation on the request that
follows.

## The lifecycle

A lifecycle is a **value** — states, an initial state, terminal states, and a
table saying who may make which move. Nothing here defines states, because a
shared vocabulary of states is the thing that would make a shared state machine
useless.

```ts
import { defineMachine } from '@birtalanrobert/workflow';

const tickets = defineMachine({
  states: ['received', 'diagnosed', 'repaired', 'collected', 'returned'],
  initial: 'received',
  terminal: ['collected', 'returned'],
  transitions: [
    { from: 'received', to: 'diagnosed', trigger: 'diagnose', by: ['staff'] },
    { from: 'diagnosed', to: 'repaired', trigger: 'repair', by: ['staff'] },
    { from: 'repaired', to: 'collected', trigger: 'collect', by: ['staff', 'customer'] },
  ],
});

tickets.available('repaired', 'customer'); // what to render as buttons
tickets.can('received', 'collect', 'staff'); // false
```

Taking a value rather than a type is the decision the module rests on. One
consumer holds its lifecycle in code, where the states are a literal union the
compiler checks exhaustively; another holds it in a database row, because a
bicycle workshop and a watchmaker do not share a workflow and neither should
have to wait for a deployment to change theirs.

### It refuses a lifecycle nobody could get out of

`defineMachine` validates and throws `InvalidMachine` listing **every** problem,
not the first — a table edited in a form is fixed one save at a time, and being
told about the next problem after each save is how somebody gives up.

It refuses a non-terminal state with no way out, a state nothing can reach, a
transition out of a terminal state, two moves that would race on table order, an
initial state that is also terminal, a move nobody may make, and a due date on a
finished subject.

That validation is why the configurable case is safe. A table assembled from
rows is user input, and the alternative to refusing a broken one is a device
stuck in a state with no exit, found on a Saturday with a customer waiting.

### Due dates count working days

```ts
import { addWorkingDays, heldSinceCutoff } from '@birtalanrobert/workflow';

const calendar = { weekend: [0, 6], holidays: ['2026-12-01'], timeZone: 'Europe/Bucharest' };

addWorkingDays(bookedInAt, 3, calendar); // "ready Wednesday", from a Friday counter
heldSinceCutoff(now, 5, calendar); // for `WHERE state_changed_at < $1`
```

The weekend is configurable because a shop that opens on Saturday and closes on
Monday is ordinary. Holidays are `YYYY-MM-DD` strings because a holiday is a
_date_, not an instant, and storing it as one shifts it by a day whenever the
server's zone differs from the shop's.

`heldSinceCutoff` returns an instant rather than a predicate so "held too long"
reaches an index. The predicate version works until the first shop with a real
backlog.

`isPastDue` answers late _and still meaningful_: a subject past its date in a
state that does not bear one is paused, not late, and reporting it as late is
how people stop believing the number. Set `dueBearing` for a lifecycle with a
state that suspends the clock — on hold, awaiting parts, waiting on a customer.

## The transition log

From `@birtalanrobert/workflow/nestjs`, because this half needs a database.

The table is the product's, not the package's — so it can foreign-key to its
subject and carry its own row-level security policy:

```ts
@Entity('ticket_transitions')
@Index('ix_ticket_transitions_subject', ['subjectId', 'occurredAt'])
export class TicketTransition extends TransitionLogEntity {}

// in the migration
for (const statement of appendOnlySql('ticket_transitions')) await runner.query(statement);
```

`TransitionLog` checks the move against the machine and records it, refusing an
illegal one with `TransitionRefused` rather than returning a result nobody
remembers to check:

```ts
const log = new TransitionLog(tickets, TicketTransition);

await dataSource.transaction(async (manager) => {
  const { to } = await log.record(manager, {
    subjectId: ticket.id,
    tenantId,
    from: ticket.state,
    trigger: 'repair',
    actor: user.id,
    actorType: 'staff',
  });
  await manager.update(Ticket, ticket.id, { state: to });
});
```

**It takes the caller's `EntityManager` and never opens a transaction of its
own.** The move and its record commit together or not at all: a subject whose
state advanced without a log entry has a hole in its history, and an entry for a
move that rolled back is worse, because it vouches for something that did not
happen.

It does not write the subject. The product knows what else changes when a ticket
is collected.

### Reversal

The only way out of a terminal state, and deliberately narrow: back to the state
immediately before the current one, never anywhere else, and never without a
reason.

```ts
await log.reverse(manager, {
  subjectId,
  tenantId,
  actor: owner.id,
  actorType: 'staff',
  reason: 'handed to the wrong customer',
});
```

Recorded as a new row naming the one it undoes — the mistake stays in the
history, because a log that can be tidied is not evidence of anything. Reversing
a reversal is refused: going forward again is an ordinary move and should read
as one.

Authorisation is the caller's. The lifecycle knows nothing about permissions,
and "an owner may reverse" is a decision products make differently.

`appendOnlySql` blocks **updates only**. Deletes stay allowed because this table
cascades from its subject, and blocking them would mean a customer's right to
erasure could not be honoured without dropping the trigger on production, under
pressure, sometimes without putting it back. What must not happen is history
being _rewritten_.

## Signed public links

How someone outside the system enters a workflow without an account: a client
uploading documents, a customer approving a quote, a supplier confirming a
delivery. Account creation is consistently the largest cause of people not
completing what they were asked to do, and a signed link removes it.

```
import { signLink, verifyLink, permits } from '@birtalanrobert/workflow';
```

The root entry point is **framework-free and pulls in no database driver**, so a
Next.js server component or an edge function can verify a token without
installing an ORM. Web Crypto throughout, so the same code runs in Node, in a
Nest handler and at the edge.

Three properties the implementation is careful about:

- **Constant-time signature comparison.** A comparison that returns as soon as
  two bytes differ leaks, through timing, how much of a guessed signature was
  correct — enough to recover one a byte at a time.
- **The signature is checked before expiry.** Reporting a forged token as merely
  "expired" tells whoever made it that their signature was accepted.
- **Base64url over UTF-8 bytes, never `btoa` over a string.** `btoa` accepts
  only code points up to U+00FF and throws on the first `ő` or `ș` — which is to
  say, on ordinary Hungarian and Romanian.

`permits(claims, { subject, party })` is called **at the point of use**, not
only at verification. A token that is perfectly valid for one request must not
be accepted by a handler that was handed a different id in its path.

### Party scoping

A subject with several participants — two spouses on a mortgage application,
an employee and their family on a relocation file — issues one link per party.
A party-scoped token may act only as that party; an unscoped one covers the
whole subject.

### Revocation

```
import { WorkflowModule, LinkService } from '@birtalanrobert/workflow/nestjs';
```

The `./nestjs` subpath adds a revocation table and `LinkService`. Revocation is
a row rather than a flag on the subject, because a subject usually has several
live links and they are revoked individually.

`reissue()` mints a replacement **and revokes the one it replaces**, together —
a re-issue that leaves the old link working means a link forwarded to the wrong
person stays valid after the client asks for a new one, which is the situation
re-issue exists to fix.

`sweepExpired()` removes revocations for tokens that have expired anyway. Safe,
because an expired token is rejected on expiry regardless, and the table is
otherwise unbounded.

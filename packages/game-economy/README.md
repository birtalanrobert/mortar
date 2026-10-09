# @birtalanrobert/game-economy

A game's premium currency — Silver, Bloodstones, Prisms, Sovereigns — as an
append-only ledger: every purchase, grant, spend and refund, reconcilable to the
last unit.

Four of the seventeen specifications sell a currency of their own (projects 14,
15, 16 and 17), and each asks for the same thing in nearly the same words: a
complete audit trail, because **retrofitting an auditable ledger into a live
economy is not realistically possible**. This is that ledger, written once.

## Why a ledger, and why lots

A balance stored as a number cannot say where it came from, and a game is asked
that constantly: by a player disputing a spend, by an accountant, by a
chargeback. So every movement is an entry with the balance it left, and the
balance is their sum. The `balance` column is a cache written in the same
transaction, behind `CHECK (balance >= 0)`: the constraint is the guarantee,
the ledger the explanation.

Each credit is also a **lot**, and each debit records which lots it drew on.
That is what makes a refund decidable. "A purchase whose currency is entirely
unspent may be refunded" is a rule about _that purchase_, and a balance alone
cannot answer it — a player who bought 100, was given 30 and spent 40 has 90
either way, and only the draws say whether the purchase is whole.

```ts
import { allocate, isRefundable } from '@birtalanrobert/game-economy';

// Granted currency first, oldest first within a kind.
allocate(lots, 40, ['grant', 'purchase']); // [{ lotId: 'granted', amount: 30 }, { lotId: 'bought', amount: 10 }]

isRefundable({ kind: 'purchase', amount: 100, remaining: 90 }); // false — 10 of it is spent
```

The root entry point is **framework-free**: a page can show what a spend would
draw on before anything is spent. The service, the entities and the migration
are behind `@birtalanrobert/game-economy/nestjs`.

## The spend order is the game's, and it is required

Which credit a debit takes first decides how long a purchase stays refundable.
Spending what was granted first keeps what was bought untouched for longer;
spending what was bought first does the opposite. That is a policy, and it
differs by game and by jurisdiction, so the package assumes none: `spendOrder`
must name every kind of credit once, and a service built without one refuses to
start rather than stranding a kind of currency nobody can spend.

## Using it in a NestJS application

```ts
import {
  GameEconomyModule,
  GameEconomyService,
  gameEconomyEntities,
  gameEconomyMigrations,
} from '@birtalanrobert/game-economy/nestjs';

@Module({
  imports: [
    DatabaseModule.forRootAsync({
      /* entities: [...gameEconomyEntities], migrations: [...gameEconomyMigrations] */
    }),
    GameEconomyModule.forRoot({ spendOrder: ['grant', 'purchase'] }),
  ],
})
export class AppModule {}

// A chapter's reward, credited with the claim that earned it.
await economy.grant(accountId, {
  currency: 'silver',
  amount: 10,
  reason: 'quest.chapter',
  reference: `world:${worldId}:chapter:1`,
  idempotencyKey: `quest-chapter:${worldId}:${playerId}:1`,
});
```

Every write — `grant`, `purchase`, `spend`, `refund` — **joins the caller's
transaction** through `@birtalanrobert/database`, so a currency credited for a
claim that then rolls back was never credited. Every write takes the holder's
balance row for that currency first, so one holder's writes take turns: of two
spends reaching for the last of a balance, one succeeds and the other is refused
with `insufficient_balance`, never a balance of minus something.

## Idempotent by key, and refused when the key means something else

Every write carries an `idempotencyKey`, unique per holder across every kind. The
same key again answers with the entry it wrote — a webhook delivered twice, a
request retried, a bonus asked for again — and the same key for a _different_
entry is refused with `ledger_key_reused`, because answering it with the first
entry would quietly lose the second.

## Refunds

`refund` takes a whole purchase back, once: refused with `not_refundable` when
any of it is spent or it was refunded already, and `not_found` for one that is
not the holder's purchase. Whether it is still within a refund window, and the
money's own return, are the game's and its payment provider's.

`reverse` is for money that went back another way — a refund made at the
payment provider, a chargeback. It takes whatever of the purchase is left,
which may be less than all of it, or nothing, and answers with what it took
and what the holder had spent already:

```ts
const { entry, taken, spent, earlier } = await economy.reverse(holderId, {
  purchaseId,
  reason: 'stripe.dispute',
  idempotencyKey: `dispute:${eventId}`,
});
// spent > 0: currency the holder used that nothing took back — the game decides what that costs them.
```

A purchase is given back once, by a refund or a reversal, whichever comes
first: a reversal of one given back already takes nothing and names the entry
that did (`earlier`), and two at once leave one of them standing.

## Two things it deliberately does not do

- **Move currency between holders.** A gift between players is a transfer
  vector for every kind of abuse these games watch for, and whether a game
  allows one at all is its own decision. A game that does writes a spend and a
  grant, each with its reason.
- **Take a foreign key to your accounts.** `holderId` is an id in the game's own
  terms, so the package can be shared — and an erasure leaves the ledger, which
  names nobody, standing and reconcilable. That is also why its entries refuse
  deletes as well as updates, unlike a transition log that cascades from its
  subject.

## Checking it

`reconcile(holderId, currency)` compares the cached balance, the sum of the
entries and what is left of the credits, and says whether they agree. It is
exposed for operators rather than kept for tests: a cached number can drift,
and somebody who suspects one should be able to have it checked.

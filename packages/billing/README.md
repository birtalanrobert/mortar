# @birtalanrobert/billing

What a customer pays **us**: a business for its plan, or a player for a pack.

Not to be confused with [`@birtalanrobert/commerce`](../commerce), which is the
other direction: a business taking money from its own customers through Stripe
Connect, with the funds never touching us. They share a vendor and almost
nothing else — different account, different liability, different answer when one
fails. Conflating them is the mistake that makes both hard to reason about.

## Pricing a plan, without a database

```ts
import { priceFor, withinLimit, isEntitled } from '@birtalanrobert/billing';

// Five staff included, then graduated bands.
priceFor(plan, 7); // 14_900 + 2 × 2_000

withinLimit(plan, 'locations', 1); // false — one is the ceiling
isEntitled('past_due'); // true, and deliberately so
```

`past_due` entitles, because a card expires on a Sunday and nobody reads the
email until Tuesday. A salon whose diary stopped in between has lost bookings it
cannot recover, over an amount it fully intended to pay. How long that is
tolerated is `dunningStage`, and `suspend` withholds the service without
deleting anything.

## Putting a business on a plan without a payment page

```ts
await billing.assign(tenantId, { planCode: 'chain', quantity: 9 });
```

A chain is sold to rather than checked out, a pilot runs for three months on
somebody's word, and a business migrating from a competitor is put on the plan
it agreed to before a card is ever entered. It is also the only way a deployment
with no provider configured can have a subscription at all — which is every
deployment before the Stripe account exists.

It refuses to touch a subscription the provider owns: once a card is being
charged on a schedule, a plan code written beside it makes our screen and their
invoice disagree. Changing _how many_ is `setQuantity`, which tells the
provider. Who assigned it and why is the caller's to record — this package knows
nothing about operators.

## Selling a pack, rather than a plan

A premium currency in packs, a ticket, a wedding: one payment, through the same
hosted checkout, priced by its amount rather than by a price kept in the
provider's dashboard.

```ts
await provider.checkout({
  mode: 'payment',
  customer: 'cus_…',
  price: {
    amount: 999, // €9.99, the tax inside it
    currency: 'EUR',
    name: 'A purse: 260 Silver',
    taxBehavior: 'inclusive',
    taxCode: 'txcd_…',
  },
  subject: 'account:…',
  metadata: { purchase: '…' },
  locale: 'ro',
  reference: '…', // the provider's idempotency key
  successUrl: '…',
  cancelUrl: '…',
});

await provider.refund({ payment: 'pi_…', reference: 'refund-…' });
```

- **The amount is the one the product shows.** A pack whose price an operator
  edits in the product's settings is charged as written; a price id in the
  dashboard would be a second copy of the figure, and the two drift the first
  time somebody edits one of them.
- **Metadata rides on the payment as well as the session**, because a refund
  or a dispute names the payment and never the session.
- **A completed checkout is not always a paid one.** A bank debit completes
  the session days before the money arrives; `paid` says which, and its own
  event says when it did.
- **Every refund is heard, ours or not.** `charge.refunded` arrives for one made
  in the provider's dashboard too, with how much has gone back altogether, and
  a dispute is read by the money it moves — withdrawn, or reinstated when it is
  won.
- **`eventId` is the same on every delivery**, which is what a product keys on
  to act on a webhook delivered twice once.

## Using it in a NestJS application

```ts
import { NoBilling } from '@birtalanrobert/billing';
import { StripeBilling } from '@birtalanrobert/billing/stripe';
import {
  BILLING_PROVIDER,
  BillingService,
  billingEntities,
  billingMigrations,
} from '@birtalanrobert/billing/nestjs';

@Module({
  providers: [
    {
      provide: BILLING_PROVIDER,
      inject: [ConfigModule.token()],
      // A deployment with no key still has to start. Constructing the vendor's
      // client with an empty string throws inside its own constructor.
      useFactory: (config: AppConfig) =>
        config.BILLING_SECRET_KEY
          ? new StripeBilling({ secretKey: config.BILLING_SECRET_KEY })
          : new NoBilling(),
    },
    BillingService,
  ],
})
export class SubscriptionModule {}
```

Register `billingEntities` and `billingMigrations` with the data source, as with
every other package here.

**Three entry points, and the split is deliberate.** The root is pure — what a
plan costs, what it permits, what to do about an unpaid invoice — because a
console decides all three while somebody is still choosing. `/nestjs` holds the
service, the entities and the migrations. `/stripe` holds the vendor's client on
its own, because importing it pulls in the whole SDK.

## The parts worth knowing before using it

- **A plan is a row, and a price change is a new row.** A business that bought
  "Salon, 149 lei, five staff included" in March keeps those terms in April. A
  subscription stores the plan's `code`, never a key into something editable.
- **Tiers are graduated, not volume.** "Five included, then twenty each" charges
  twenty for the sixth, not twenty for all six. Past the last band, the last
  band's rate keeps applying — the alternative is an invoice that has been wrong
  in the customer's favour for a year.
- **Absence is the gate.** No deny list: a feature nobody added to a plan is one
  nobody can use, which is noticed at once.
- **Usage is counted here and reported in a batch.** A provider call on the path
  of every text message sent is a provider outage that stops the product.
- **Two ways to count, and the product picks by what it is counting.** `record`
  adds, for an event as it happens — a message sent, a pack bought. `recount`
  sets, for a table read on a schedule — tickets issued yesterday — where adding
  would double the day on a second run and could never take a refunded ticket
  off again. `usageBetween` reads a period back, because the table has a policy
  on it and a product summing it for itself would read nothing and report
  success.
- **The subscription row is written when the provider says money moved**, not on
  the way to the payment page — that is a subscription for somebody who closed
  the tab.
- **A webhook about a subscription we have no record of is ignored**, never
  inserted: it belongs to another environment sharing the provider account.

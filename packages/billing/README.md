# @birtalanrobert/billing

What a business pays **us**.

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
- **The subscription row is written when the provider says money moved**, not on
  the way to the payment page — that is a subscription for somebody who closed
  the tab.
- **A webhook about a subscription we have no record of is ignored**, never
  inserted: it belongs to another environment sharing the provider account.

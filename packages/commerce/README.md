# @birtalanrobert/commerce

Taking money **on a business's behalf**: payout onboarding, card payments,
manually recorded takings, refunds, and the record of all of it.

**We never hold anybody's funds.** The customer pays the business directly and
our cut is taken on top as an application fee. This is an architectural rule
rather than a preference — holding third-party money turns a software company
into a regulated payments business — and everything here follows from it.

Not to be confused with `@birtalanrobert/billing`, which is the other direction:
the business paying _us_ for a subscription. They differ in who pays whom, in
which provider account, and in what happens when one fails.

## What is decided without a provider

The root entry point is pure, because a console shows these numbers while
somebody drags a slider:

```ts
import { depositFor, canTakeMoney } from '@birtalanrobert/commerce';

depositFor(15_000, { kind: 'percentage', value: 30 }); // 4_500
canTakeMoney('pending'); // false — the provider has not verified them yet
```

## Using it in a NestJS application

```ts
import { StripeConnect } from '@birtalanrobert/commerce';
import {
  COMMERCE_PROVIDER,
  CommerceService,
  commerceEntities,
  commerceMigrations,
} from '@birtalanrobert/commerce/nestjs';

@Module({
  providers: [
    {
      provide: COMMERCE_PROVIDER,
      useFactory: (config: AppConfig) =>
        new StripeConnect({
          secretKey: config.STRIPE_SECRET_KEY,
          webhookSecret: config.STRIPE_WEBHOOK_SECRET,
        }),
      inject: [ConfigModule.token()],
    },
    CommerceService,
  ],
})
export class PaymentsModule {}
```

Register `commerceEntities` and `commerceMigrations` with the data source, as
with every other package here.

## The parts worth knowing before using it

- **A business cannot be charged for until the provider says it may be paid
  out.** `take` refuses before the provider is called. A charge that succeeded
  into an account with no destination would leave the customer debited and the
  money nowhere anybody can see it.
- **`authorized` is not `captured`.** A card held against a no-show fee is
  authorised and charged only if the fee is actually applied — and _that
  decision is a human one_. This package offers the mechanism and never the
  trigger, because charging a customer automatically is how a business loses
  them permanently.
- **Cash, terminal, voucher and transfer payments are recorded, not
  processed** — and recording them is not a lesser feature. A salon is mostly
  cash, a restaurant takes meal vouchers, a box office takes notes. A report
  counting only what a provider processed tells a business a fraction of its own
  takings while looking complete.
- **The record outlives the provider.** Amounts, dates, what it was for and who
  decided are stored in full rather than as identifiers to fetch, because a
  business must be able to produce its own takings after the account is closed.
- **There is no foreign key to whatever was paid for.** One product takes a
  deposit against an appointment, another against a seat, a third against a
  table's tab; a key to any one of them is what would stop this being shared.

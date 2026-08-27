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

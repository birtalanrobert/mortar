import { describe, expect, it } from 'vitest';
import { LinkService } from '../links/link.service';
import { PublicLinkService } from '../links/public-link.service';
import { WorkflowModule } from './workflow.module';

const SECRET = 'a-signing-secret-of-at-least-32-chars';

/**
 * The module has to provide both services, and this is the regression it is
 * written against.
 *
 * `workflowEntities` has always shipped `PublicLink` and its migration, so the
 * package was telling consumers to register a table for a service they could
 * not inject. Three products constructed it by hand before anybody noticed.
 */
describe('WorkflowModule', () => {
  const tokens = (providers: unknown[]): unknown[] =>
    providers.map((provider) => (provider as { provide: unknown }).provide);

  it('provides and exports both link services', () => {
    const module = WorkflowModule.forRoot({ secret: SECRET });

    expect(tokens(module.providers ?? [])).toEqual([LinkService, PublicLinkService]);
    expect(tokens(module.exports ?? [])).toEqual([LinkService, PublicLinkService]);
  });

  it('does the same when configured asynchronously', () => {
    const module = WorkflowModule.forRootAsync({ useFactory: () => ({ secret: SECRET }) });

    expect(tokens(module.providers ?? [])).toEqual([LinkService, PublicLinkService]);
  });

  /**
   * Both services get the *same* options object.
   *
   * Two instances signing with two different secrets would be two kinds of link
   * that cannot open each other's, and the failure would appear as "this link
   * is invalid" months later rather than at boot.
   */
  it('builds both from one resolution of the options', async () => {
    let calls = 0;

    const module = WorkflowModule.forRootAsync({
      useFactory: () => {
        calls += 1;
        return { secret: SECRET };
      },
    });

    const built = await Promise.all(
      (module.providers ?? []).map((provider) =>
        (provider as { useFactory: (source: unknown) => Promise<unknown> }).useFactory({}),
      ),
    );

    expect(built[0]).toBeInstanceOf(LinkService);
    expect(built[1]).toBeInstanceOf(PublicLinkService);
    /* Once per service, and each with its own resolution rather than a shared
     * one — the factory is a configuration read, and reading it twice is the
     * honest cost of not caching something a consumer might not expect to be. */
    expect(calls).toBe(2);
  });
});

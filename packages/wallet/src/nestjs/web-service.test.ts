import { beforeEach, describe, expect, it } from 'vitest';
import { passAuthenticationToken } from '../apple/token';
import type { PassRecord, PassSource, RegistrationStore } from '../apple/webservice';
import { WalletWebService, type WalletModuleOptions } from './web-service';

/**
 * The two hooks the Nest layer adds on top of the protocol.
 *
 * They are the only reason this layer exists beyond wiring: a product needs to
 * be *told* when a pass is installed and when it is removed, because neither
 * platform reports either anywhere else — and both facts are the difference
 * between an enrolment funnel that measures something and one that measures how
 * many files left a server.
 *
 * Constructed by hand rather than through a testing module: the class takes
 * three arguments and nothing here needs a container to decide what they are.
 */

const PASS_TYPE = 'pass.ro.stamped.loyalty';
const SECRET = 'a-secret-for-the-test-only-0123456789';

const PASS: PassRecord = {
  passTypeIdentifier: PASS_TYPE,
  serialNumber: 'card-1',
  tokenVersion: 1,
  updatedAt: new Date('2026-09-17T09:00:00Z'),
  voided: false,
};

class OneStore implements RegistrationStore {
  readonly devices = new Set<string>();

  add(input: { deviceLibraryIdentifier: string }): Promise<boolean> {
    const fresh = !this.devices.has(input.deviceLibraryIdentifier);
    this.devices.add(input.deviceLibraryIdentifier);
    return Promise.resolve(fresh);
  }

  remove(input: { deviceLibraryIdentifier: string }): Promise<boolean> {
    return Promise.resolve(this.devices.delete(input.deviceLibraryIdentifier));
  }

  serialsFor(): Promise<string[]> {
    return Promise.resolve([PASS.serialNumber]);
  }

  devicesFor(): Promise<Array<{ deviceLibraryIdentifier: string; pushToken: string }>> {
    return Promise.resolve([]);
  }
}

const source: PassSource = {
  find: (passTypeIdentifier, serialNumber) =>
    Promise.resolve(
      passTypeIdentifier === PASS_TYPE && serialNumber === PASS.serialNumber ? PASS : null,
    ),
  build: () => Promise.resolve(Buffer.from('a pass')),
  updatedSince: () => Promise.resolve({ serialNumbers: [], lastUpdated: '1' }),
};

const authorisation = `ApplePass ${passAuthenticationToken(SECRET, {
  passTypeIdentifier: PASS.passTypeIdentifier,
  serialNumber: PASS.serialNumber,
  version: PASS.tokenVersion,
})}`;

let told: Array<Record<string, unknown>>;
let store: OneStore;

function serviceWith(options: Partial<WalletModuleOptions>): WalletWebService {
  store = new OneStore();
  return new WalletWebService(source, store as unknown as never, {
    tokenSecret: SECRET,
    ...options,
  });
}

beforeEach(() => {
  told = [];
});

describe('being told a pass was installed', () => {
  const register = (service: WalletWebService, device: string) =>
    service.register({
      deviceLibraryIdentifier: device,
      passTypeIdentifier: PASS_TYPE,
      serialNumber: PASS.serialNumber,
      pushToken: 'push-1',
      authorization: authorisation,
    });

  it('says whether the device already had it', async () => {
    const service = serviceWith({
      onRegistered: (input) => {
        told.push(input);
        return Promise.resolve();
      },
    });

    expect(await register(service, 'device-1')).toMatchObject({ status: 201 });
    expect(await register(service, 'device-1')).toMatchObject({ status: 200 });

    /*
     * Both are reported, and `created` is what separates an installation from a
     * device retrying. A product counting installations wants the first; one
     * keeping a push token current wants both.
     */
    expect(told).toEqual([
      expect.objectContaining({ created: true, deviceLibraryIdentifier: 'device-1' }),
      expect.objectContaining({ created: false, deviceLibraryIdentifier: 'device-1' }),
    ]);
  });

  it('is silent when the device was not allowed to register', async () => {
    const service = serviceWith({
      onRegistered: (input) => {
        told.push(input);
        return Promise.resolve();
      },
    });

    const refused = await service.register({
      deviceLibraryIdentifier: 'device-1',
      passTypeIdentifier: PASS_TYPE,
      serialNumber: PASS.serialNumber,
      pushToken: 'push-1',
      authorization: 'ApplePass a-guess',
    });

    expect(refused).toMatchObject({ status: 401 });

    /*
     * A failed guess is not an installation. Counting one would put a
     * stranger's probe into a business's enrolment numbers, and hold a welcome
     * bonus open for a pass nobody holds.
     */
    expect(told).toEqual([]);
  });

  it('works with no hook at all', async () => {
    const service = serviceWith({});
    expect(await register(service, 'device-1')).toMatchObject({ status: 201 });
  });
});

describe('being told a pass was removed', () => {
  it('reports a removal, and nothing for a device that had nothing', async () => {
    const service = serviceWith({
      onDeregistered: (input) => {
        told.push(input);
        return Promise.resolve();
      },
    });

    await service.register({
      deviceLibraryIdentifier: 'device-1',
      passTypeIdentifier: PASS_TYPE,
      serialNumber: PASS.serialNumber,
      pushToken: 'push-1',
      authorization: authorisation,
    });

    const removed = await service.unregister({
      deviceLibraryIdentifier: 'device-1',
      passTypeIdentifier: PASS_TYPE,
      serialNumber: PASS.serialNumber,
      authorization: authorisation,
    });

    expect(removed).toMatchObject({ status: 200 });
    expect(told).toHaveLength(1);

    /* A removal that removed nothing is not a withdrawal of anything. */
    await service.unregister({
      deviceLibraryIdentifier: 'device-2',
      passTypeIdentifier: PASS_TYPE,
      serialNumber: PASS.serialNumber,
      authorization: authorisation,
    });

    expect(told).toHaveLength(1);
    expect(store.devices.size).toBe(0);
  });
});

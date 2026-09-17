import { Inject, Injectable } from '@nestjs/common';
import { readApplePassHeader, verifyPassAuthenticationToken } from '../apple/token';
import {
  deviceLog,
  fetchPass,
  passesUpdatedSince,
  registerDevice,
  unregisterDevice,
  type PassSource,
  type ProtocolOptions,
  type ProtocolResult,
} from '../apple/webservice';
import { WalletRegistrationsService } from './registrations.service';

export const WALLET_PASS_SOURCE = Symbol('WALLET_PASS_SOURCE');
export const WALLET_OPTIONS = Symbol('WALLET_OPTIONS');

export interface WalletModuleOptions {
  /**
   * The secret every pass authentication token is derived from.
   *
   * One value for the whole deployment. Changing it invalidates every
   * outstanding pass's ability to update — correct after a leak, catastrophic
   * by accident — so it belongs beside the signing certificate in configuration
   * and never in a repository. See `apple/token.ts`.
   */
  tokenSecret: string;

  /** Told when a holder removes a pass, which is a withdrawal of consent. */
  onDeregistered?: (input: {
    passTypeIdentifier: string;
    serialNumber: string;
    deviceLibraryIdentifier: string;
  }) => Promise<void>;

  /**
   * Told when a holder adds a pass.
   *
   * **The only signal either platform gives that a pass was actually
   * installed.** Issuing one is a file leaving a server; a registration is a
   * wallet on a device asking to be told when it changes, and nothing else
   * distinguishes the two. A product measuring an enrolment funnel, or holding
   * a welcome bonus back until there is a phone to show it on, has this and
   * nothing else to go on.
   *
   * `created` is false when the device already had it: a retry, not an install.
   * Whether a *re-*installation counts is the product's question — somebody who
   * removes a pass and adds it again is one person installing twice — so that
   * decision is left where the answer is known.
   */
  onRegistered?: (input: {
    passTypeIdentifier: string;
    serialNumber: string;
    deviceLibraryIdentifier: string;
    created: boolean;
  }) => Promise<void>;
}

/**
 * Apple's update web service, wired but not mounted.
 *
 * The five handlers, with the token check and the registration store attached —
 * and **no HTTP decorators**, deliberately. Where these routes live, whether
 * they sit under an API prefix, which guard marks them public and what rate
 * limit they carry are all the product's decisions, and a controller in this
 * package would have to take a dependency on the product's authentication to
 * express any of them. The product writes seventy lines of controller and keeps
 * the choices.
 */
@Injectable()
export class WalletWebService {
  private readonly protocol: ProtocolOptions;

  constructor(
    @Inject(WALLET_PASS_SOURCE) source: PassSource,
    private readonly registrations: WalletRegistrationsService,
    @Inject(WALLET_OPTIONS) private readonly options: WalletModuleOptions,
  ) {
    this.protocol = {
      source,
      registrations,
      authorise: (pass, presented) =>
        presented !== null &&
        verifyPassAuthenticationToken(
          this.options.tokenSecret,
          {
            passTypeIdentifier: pass.passTypeIdentifier,
            serialNumber: pass.serialNumber,
            version: pass.tokenVersion,
          },
          presented,
        ),
    };
  }

  async register(request: {
    deviceLibraryIdentifier: string;
    passTypeIdentifier: string;
    serialNumber: string;
    pushToken: string;
    authorization: string | undefined;
  }): Promise<ProtocolResult> {
    const result = await registerDevice(this.protocol, {
      ...request,
      token: readApplePassHeader(request.authorization),
    });

    /*
     * Only on a registration the device was allowed to make. A 401 is somebody
     * else's failed guess and a 404 is a serial nobody issued; neither is an
     * installation, and counting either would put a stranger's probe into a
     * business's enrolment numbers.
     */
    if (result.status === 200 || result.status === 201) {
      await this.options.onRegistered?.({
        passTypeIdentifier: request.passTypeIdentifier,
        serialNumber: request.serialNumber,
        deviceLibraryIdentifier: request.deviceLibraryIdentifier,
        created: result.changed === true,
      });
    }

    return result;
  }

  async unregister(request: {
    deviceLibraryIdentifier: string;
    passTypeIdentifier: string;
    serialNumber: string;
    authorization: string | undefined;
  }): Promise<ProtocolResult> {
    const result = await unregisterDevice(this.protocol, {
      ...request,
      token: readApplePassHeader(request.authorization),
    });

    /*
     * A pass removed from a wallet is a withdrawal of consent as well as a
     * deleted row — the specification is explicit about it — and the product is
     * *told* rather than expected to notice.
     *
     * Only when a row actually went. A 401 is somebody else's failed guess, and
     * a 200 for a device that had nothing registered is a retry — neither is a
     * holder withdrawing anything, and recording one either way would suppress
     * a customer's messages because a device asked twice.
     */
    if (result.changed) {
      await this.options.onDeregistered?.({
        passTypeIdentifier: request.passTypeIdentifier,
        serialNumber: request.serialNumber,
        deviceLibraryIdentifier: request.deviceLibraryIdentifier,
      });
    }

    return result;
  }

  updatedSince(request: {
    deviceLibraryIdentifier: string;
    passTypeIdentifier: string;
    since: string | undefined;
  }): Promise<ProtocolResult> {
    return passesUpdatedSince(this.protocol, request);
  }

  fetch(request: {
    passTypeIdentifier: string;
    serialNumber: string;
    authorization: string | undefined;
    ifModifiedSince: string | undefined;
  }): Promise<ProtocolResult> {
    return fetchPass(this.protocol, {
      ...request,
      token: readApplePassHeader(request.authorization),
    });
  }

  /**
   * What a device said went wrong.
   *
   * Always accepted, and written down. It is the only diagnostic Apple sends
   * anywhere, and a programme with no device of its own has more use for it
   * than one that can look at a phone.
   */
  async log(body: unknown): Promise<ProtocolResult> {
    const { messages } = deviceLog(body);
    await this.registrations.recordDeviceLog(messages);
    return { status: 200 };
  }
}

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

  register(request: {
    deviceLibraryIdentifier: string;
    passTypeIdentifier: string;
    serialNumber: string;
    pushToken: string;
    authorization: string | undefined;
  }): Promise<ProtocolResult> {
    return registerDevice(this.protocol, {
      ...request,
      token: readApplePassHeader(request.authorization),
    });
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
     * *told* rather than expected to notice. Only on a successful
     * deregistration: a 401 is somebody else's failed guess, not a holder.
     */
    if (result.status === 200) {
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

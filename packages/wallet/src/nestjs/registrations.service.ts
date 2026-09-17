import { Injectable } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import type { ApnsPort, ApnsPush, ApnsResult } from '../apple/apns/port';
import { coalesce } from '../apple/apns/port';
import type { RegistrationStore } from '../apple/webservice';
import { WalletDeviceLog, WalletPushDelivery, WalletRegistration } from './entities';

/**
 * Which device holds which pass, and what happened when we pushed to it.
 *
 * Every query here runs **unbound by tenant**, on purpose and only because the
 * three tables it touches carry no policy — see the migration for why. It is
 * the one service in this package that talks to a database, and the reason it
 * is here rather than in the product is that the answer is the same whatever a
 * pass means.
 */
@Injectable()
export class WalletRegistrationsService implements RegistrationStore {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Registers a device, or updates the push token of one already registered.
   *
   * The update matters more than it looks. A device that reinstalls the pass, or
   * whose APNs token is reissued by the operating system, calls this again with
   * the *same* identifiers and a **different** token — and an implementation
   * that treated the row as immutable would go on pushing to a token that has
   * been dead since the reinstall, and would record every one of them as
   * delivered.
   */
  async add(input: {
    deviceLibraryIdentifier: string;
    pushToken: string;
    passTypeIdentifier: string;
    serialNumber: string;
    tenantId?: string;
  }): Promise<boolean> {
    const repository = this.dataSource.getRepository(WalletRegistration);

    const existing = await repository.findOne({
      where: {
        deviceLibraryIdentifier: input.deviceLibraryIdentifier,
        passTypeIdentifier: input.passTypeIdentifier,
        serialNumber: input.serialNumber,
      },
    });

    if (existing) {
      if (existing.pushToken !== input.pushToken) {
        existing.pushToken = input.pushToken;
        await repository.save(existing);
      }
      return false;
    }

    await repository.save(
      repository.create({
        deviceLibraryIdentifier: input.deviceLibraryIdentifier,
        pushToken: input.pushToken,
        passTypeIdentifier: input.passTypeIdentifier,
        serialNumber: input.serialNumber,
        tenantId: input.tenantId ?? null,
      }),
    );

    return true;
  }

  async remove(input: {
    deviceLibraryIdentifier: string;
    passTypeIdentifier: string;
    serialNumber: string;
  }): Promise<boolean> {
    const result = await this.dataSource.getRepository(WalletRegistration).delete({
      deviceLibraryIdentifier: input.deviceLibraryIdentifier,
      passTypeIdentifier: input.passTypeIdentifier,
      serialNumber: input.serialNumber,
    });

    return (result.affected ?? 0) > 0;
  }

  async serialsFor(deviceLibraryIdentifier: string, passTypeIdentifier: string): Promise<string[]> {
    const rows = await this.dataSource
      .getRepository(WalletRegistration)
      .find({ where: { deviceLibraryIdentifier, passTypeIdentifier } });

    return rows.map((row) => row.serialNumber);
  }

  async devicesFor(
    passTypeIdentifier: string,
    serialNumber: string,
  ): Promise<Array<{ deviceLibraryIdentifier: string; pushToken: string }>> {
    const rows = await this.dataSource
      .getRepository(WalletRegistration)
      .find({ where: { passTypeIdentifier, serialNumber } });

    return rows.map((row) => ({
      deviceLibraryIdentifier: row.deviceLibraryIdentifier,
      pushToken: row.pushToken,
    }));
  }

  /**
   * Pushes to every device holding these passes, once per device.
   *
   * **Per device, not per pass**, which is Apple's design rather than an
   * optimisation: the push carries nothing — no serial, no payload — and the
   * device answers it by asking which of *its* passes changed. So a device
   * holding two cards that both changed needs one notification, and sending two
   * makes a phone buzz twice for one question it will ask once.
   *
   * A delivery is recorded per pass per device all the same, because the
   * question somebody asks later is "did this card's update reach anybody" and
   * not "how many HTTP requests did we make". Rows covering one push share its
   * status and its provider identifier, which is accurate: they succeeded or
   * failed together.
   *
   * `410 Unregistered` **removes the registration** rather than only being
   * logged. It is the single signal there is that a holder deleted their card
   * without the deregistration arriving, and a product that keeps pushing to it
   * is a product whose delivery numbers are quietly fiction.
   */
  async push(
    apns: ApnsPort,
    passes: ReadonlyArray<{ passTypeIdentifier: string; serialNumber: string; tenantId?: string }>,
  ): Promise<ApnsResult[]> {
    interface Target {
      push: ApnsPush;
      deviceLibraryIdentifier: string;
      covered: Array<{ passTypeIdentifier: string; serialNumber: string; tenantId?: string }>;
    }

    const targets = new Map<string, Target>();

    for (const pass of passes) {
      for (const device of await this.devicesFor(pass.passTypeIdentifier, pass.serialNumber)) {
        const key = `${pass.passTypeIdentifier} ${device.deviceLibraryIdentifier}`;
        const target = targets.get(key) ?? {
          push: {
            pushToken: device.pushToken,
            topic: pass.passTypeIdentifier,
            /*
             * Per device and pass type, so an undelivered "you have updates"
             * is replaced by the newer one rather than queued behind it. The
             * serial would be wrong here: one push can cover several.
             */
            collapseId: pass.passTypeIdentifier.slice(0, 64),
          },
          deviceLibraryIdentifier: device.deviceLibraryIdentifier,
          covered: [],
        };

        /* The newest token wins: a device that reinstalled has a new one. */
        target.push.pushToken = device.pushToken;
        target.covered.push(pass);
        targets.set(key, target);
      }
    }

    /*
     * Through `coalesce` even though the map above already groups, so the rule
     * lives in exactly one place. If the two ever disagree, this is the one
     * that is wrong.
     */
    const results = await apns.send(coalesce([...targets.values()].map((one) => one.push)));

    const byToken = new Map<string, Target>();
    for (const target of targets.values()) {
      byToken.set(`${target.push.topic} ${target.push.pushToken}`, target);
    }

    const deliveries = this.dataSource.getRepository(WalletPushDelivery);

    for (const result of results) {
      for (const target of byToken.values()) {
        if (target.push.pushToken !== result.pushToken) continue;

        for (const pass of target.covered) {
          await deliveries.save(
            deliveries.create({
              passTypeIdentifier: pass.passTypeIdentifier,
              serialNumber: pass.serialNumber,
              deviceLibraryIdentifier: target.deviceLibraryIdentifier,
              platform: 'apple',
              status: result.status,
              reason: result.reason ?? null,
              providerId: result.apnsId ?? null,
              tenantId: pass.tenantId ?? null,
            }),
          );

          if (result.status === 410) {
            await this.remove({
              deviceLibraryIdentifier: target.deviceLibraryIdentifier,
              passTypeIdentifier: pass.passTypeIdentifier,
              serialNumber: pass.serialNumber,
            });
          }
        }
      }
    }

    return results;
  }

  /** Records a Google write, so one screen answers for both platforms. */
  async recordGoogleWrite(input: {
    passTypeIdentifier: string;
    serialNumber: string;
    status: number;
    reason?: string;
    providerId?: string;
    tenantId?: string;
  }): Promise<void> {
    const repository = this.dataSource.getRepository(WalletPushDelivery);

    await repository.save(
      repository.create({
        passTypeIdentifier: input.passTypeIdentifier,
        serialNumber: input.serialNumber,
        deviceLibraryIdentifier: null,
        platform: 'google',
        status: input.status,
        reason: input.reason ?? null,
        providerId: input.providerId ?? null,
        tenantId: input.tenantId ?? null,
      }),
    );
  }

  /** What a device said went wrong, in its own words. */
  async recordDeviceLog(messages: readonly string[]): Promise<void> {
    if (messages.length === 0) return;

    const repository = this.dataSource.getRepository(WalletDeviceLog);
    await repository.save(messages.map((message) => repository.create({ message })));
  }
}

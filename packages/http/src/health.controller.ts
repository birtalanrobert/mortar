import { Controller, Get, Inject, Res } from '@nestjs/common';
import { HealthRegistry, type HealthReport } from './health';

export const HEALTH_REGISTRY = Symbol('MORTAR_HEALTH_REGISTRY');
export const HEALTH_OPTIONS = Symbol('MORTAR_HEALTH_OPTIONS');

export interface HealthControllerOptions {
  /**
   * Include per-check detail in the response body.
   *
   * A health endpoint is usually unauthenticated, and per-check detail leaks
   * infrastructure shape — which hosts exist, which dependencies are wired up,
   * what is currently broken. Off by default; enable behind a private route or
   * network boundary.
   */
  detailed?: boolean;
  timeoutMs?: number;
}

interface ResponseLike {
  status(code: number): ResponseLike;
  json(body: unknown): unknown;
}

/**
 * Liveness and readiness, kept deliberately distinct.
 *
 * `/health/live` answers "is this process running" and must not touch
 * dependencies — a liveness probe that checks the database restarts the
 * service every time the database hiccups, turning a brief blip into a
 * restart loop across every replica at once.
 *
 * `/health/ready` answers "can this process serve traffic" and does check
 * dependencies, so an instance with a dead pool is removed from the load
 * balancer without being killed.
 */
@Controller('health')
export class HealthController {
  constructor(
    @Inject(HEALTH_REGISTRY) private readonly registry: HealthRegistry,
    @Inject(HEALTH_OPTIONS) private readonly options: HealthControllerOptions,
  ) {}

  @Get('live')
  live(): { status: 'up' } {
    return { status: 'up' };
  }

  @Get('ready')
  async ready(@Res({ passthrough: true }) response: ResponseLike): Promise<unknown> {
    const report = await this.registry.check(this.options.timeoutMs);
    // 'degraded' still serves traffic: a non-critical dependency being down
    // is worth reporting, not worth removing the instance from rotation.
    response.status(report.status === 'down' ? 503 : 200);
    return this.present(report);
  }

  @Get()
  async root(@Res({ passthrough: true }) response: ResponseLike): Promise<unknown> {
    return this.ready(response);
  }

  private present(report: HealthReport): unknown {
    if (this.options.detailed) return report;
    return { status: report.status };
  }
}

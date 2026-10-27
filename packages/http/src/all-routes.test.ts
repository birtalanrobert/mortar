import { Logger, RequestMethod } from '@nestjs/common';
import { ApplicationConfig } from '@nestjs/core';
import { RouteInfoPathExtractor } from '@nestjs/core/middleware/route-info-path-extractor';
import { mapToExcludeRoute } from '@nestjs/core/middleware/utils';
import { LegacyRouteConverter } from '@nestjs/core/router/legacy-route-converter';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { allRoutes } from './all-routes';

/**
 * The paths a middleware given `path` is registered on, as Nest 11 works them
 * out for an application with a global prefix and probes kept out of it, and
 * as the Express adapter then hands each to its router.
 */
function registeredPaths(path: string, options?: { logs: boolean }): string[] {
  const config = new ApplicationConfig();
  config.setGlobalPrefix('api');
  config.setGlobalPrefixOptions({ exclude: mapToExcludeRoute(['health', 'health/ready']) });
  return new RouteInfoPathExtractor(config)
    .extractPathsFrom({ path, method: RequestMethod.ALL })
    .map((each) => LegacyRouteConverter.tryConvert(each, options));
}

describe('allRoutes', () => {
  afterEach(() => vi.restoreAllMocks());

  it('is written as the Nest installed here reads it', () => {
    expect(allRoutes()).toBe('/{*path}');
  });

  it('gives a middleware the routes `*` gave it, with no warning at start', () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    const paths = registeredPaths(allRoutes());

    expect(warn).not.toHaveBeenCalled();
    expect(paths).toEqual(registeredPaths('*', { logs: false }));
    expect(paths).toEqual(['/api$', '/api/{*path}', '/health', '/health/ready']);
  });

  it('is what `*` set off the warning for', () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    registeredPaths('*');

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Unsupported route path: "/api/*"'));
  });
});

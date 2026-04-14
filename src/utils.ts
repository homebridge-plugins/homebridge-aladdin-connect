import { PlatformConfig } from 'homebridge';

import { DEFAULT_ENABLE_MATTER, DEFAULT_PREFER_MATTER } from './settings';

/**
 * Factory that returns a proxy constructor which, at instantiation time,
 * decides whether to use the Matter platform or the HAP platform based on
 * the plugin config and the runtime capabilities of the Homebridge instance.
 *
 * @param HAPPlatform   The HAP-based platform class (always available).
 * @param MatterPlatform The Matter-based platform class (used when Matter is
 *                       available and enabled).
 * @returns A proxy constructor that Homebridge can register as a platform.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createPlatformProxy(HAPPlatform: any, MatterPlatform: any): any {
  return class GenieAladdinConnectPlatformProxy {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private impl: any;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(log: any, config: PlatformConfig, api: any) {
      const preferMatter: boolean = config.preferMatter ?? DEFAULT_PREFER_MATTER;
      const enableMatter: boolean = config.enableMatter ?? DEFAULT_ENABLE_MATTER;
      const matterSupported: boolean = !!api?.isMatterAvailable?.();
      const matterEnabled: boolean = !!api?.isMatterEnabled?.();
      const matterAvailable: boolean = matterSupported && matterEnabled;

      if (enableMatter && preferMatter && MatterPlatform && matterAvailable) {
        this.impl = new MatterPlatform(log, config, api);
        return this.impl;
      }

      // Log the reason(s) for falling back to HAP when Matter was desired.
      if (enableMatter || preferMatter) {
        const reasons: string[] = [];

        if (!enableMatter) {
          reasons.push('plugin config has enableMatter disabled');
        }

        if (!preferMatter) {
          reasons.push('plugin config has preferMatter disabled');
        }

        if (!MatterPlatform) {
          reasons.push('Matter platform implementation is unavailable');
        }

        if (!matterSupported) {
          reasons.push('Homebridge Matter support is unavailable (requires Homebridge v2.0+)');
        } else if (!matterEnabled) {
          reasons.push('Homebridge Matter support is not enabled');
        }

        const message =
          `Matter was requested but cannot be used; falling back to HAP (${reasons.join(', ')}).`;

        if (enableMatter && preferMatter) {
          log?.warn?.(message);
        } else {
          log?.info?.(message);
        }
      }

      // Fallback to HAP
      this.impl = new HAPPlatform(log, config, api);
      return this.impl;
    }
  };
}

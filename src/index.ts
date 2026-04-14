import { API } from 'homebridge';

import { PLATFORM_NAME } from './settings';
import { GenieAladdinConnectHomebridgePlatform } from './platform';
import { AladdinConnectMatterPlatform } from './AladdinConnectMatterPlatform';
import { createPlatformProxy } from './utils';

/**
 * This method registers the platform with Homebridge
 */
export = (api: API) => {
  const ProxyCtor = createPlatformProxy(
    GenieAladdinConnectHomebridgePlatform,
    AladdinConnectMatterPlatform,
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  api.registerPlatform(PLATFORM_NAME, ProxyCtor as any);
};

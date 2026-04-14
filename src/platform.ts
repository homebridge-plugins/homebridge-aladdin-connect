import {
  API,
  APIEvent,
  Characteristic,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME, DEFAULT_EXTERNAL_ACCESSORY } from './settings';
import {
  GenieAladdinConnectGarageDoorAccessory,
  GenieAladdinConnectPlatformAccessoryContext,
} from './platformAccessory';
import { AladdinConnect, AladdinConnectConfig, AladdinDoor } from './aladdinConnect';

/**
 * Shared interface implemented by both the HAP and Matter platform classes.
 * `GenieAladdinConnectGarageDoorAccessory` depends on this interface so it
 * can be reused by both platforms without unsafe type casts.
 */
export interface GenieAladdinConnectPlatform {
  readonly log: Logger;
  readonly api: API;
  readonly config: PlatformConfig;
  readonly Service: typeof Service;
  readonly Characteristic: typeof Characteristic;
  readonly aladdinConnect: AladdinConnect;
}

export class GenieAladdinConnectHomebridgePlatform
  implements DynamicPlatformPlugin, GenieAladdinConnectPlatform {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  public readonly accessories: PlatformAccessory[] = [];
  public readonly aladdinConnect: AladdinConnect;

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = this.api.hap.Service;
    this.Characteristic = this.api.hap.Characteristic;
    this.aladdinConnect = new AladdinConnect(log, <AladdinConnectConfig>(<unknown>config));
    this.api.on(APIEvent.DID_FINISH_LAUNCHING, async () => this.discoverDevices());
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.push(accessory);
  }

  async discoverDevices() {
    let doors: AladdinDoor[];
    try {
      doors = await this.aladdinConnect.getAllDoors();
    } catch (error: unknown) {
      this.log.error('Failed to load doors from account; retrying in 5 minutes');
      setTimeout(this.discoverDevices.bind(this), 5 * 60 * 1000);
      return;
    }
    const externalAccessory = this.config.externalAccessory ?? DEFAULT_EXTERNAL_ACCESSORY;

    // When switching to external mode, unregister any cached platform accessories
    // so they don't linger alongside independently-paired external accessories.
    if (externalAccessory && this.accessories.length > 0) {
      this.log.info(
        'External accessory mode enabled; removing %d cached platform accessory(s)',
        this.accessories.length,
      );
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, this.accessories);
      this.accessories.length = 0;
    }

    const discoveredUUIDs: Set<string> = new Set();

    for (const door of doors) {
      if (Array.isArray(this.config.ignoreDevices) && this.config.ignoreDevices.includes(door.id)) {
        this.log.info('Skipping ignored accessory: %s (id: %s)', door.name, door.id);
        continue;
      }
      if (door.ownership === 'owned' || this.config.showShared === true) {
        const uuid = this.api.hap.uuid.generate(`${door.deviceId}:${door.index}`);
        discoveredUUIDs.add(uuid);

        if (externalAccessory) {
          // External accessories are published independently each startup and do
          // not participate in the platform-accessory cache lifecycle.
          const accessory = new this.api.platformAccessory(door.name, uuid);
          accessory.context = <GenieAladdinConnectPlatformAccessoryContext>{ door };
          this.log.info('Publishing external accessory: %s (id: %s)', door.name, door.id);
          this.api.publishExternalAccessories(PLUGIN_NAME, [accessory]);
          new GenieAladdinConnectGarageDoorAccessory(this, accessory);
        } else {
          let accessory = this.accessories.find((a) => a.UUID === uuid);
          const existingAccessory = !!accessory;
          accessory = accessory ?? new this.api.platformAccessory(door.name, uuid);

          // Update the accessory context with the door.
          accessory.context = <GenieAladdinConnectPlatformAccessoryContext>{
            door,
          };

          if (existingAccessory) {
            this.log.info(
              'Restoring existing accessory from cache: %s (id: %s)',
              accessory.displayName,
              door.id,
            );
            this.api.updatePlatformAccessories([accessory]);
          } else {
            this.log.info('Adding new accessory: %s (id: %s)', door.name, door.id);
            this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
          }
          new GenieAladdinConnectGarageDoorAccessory(this, accessory);
        }
      } else {
        this.log.info('Not adding door:', door.name, ' because it is not owned by this account.');
      }
    }

    // Orphan cleanup only applies to bridged (non-external) mode.
    if (!externalAccessory) {
      const orphanedAccessories = this.accessories.filter(
        (accessory) => !discoveredUUIDs.has(accessory.UUID),
      );
      if (orphanedAccessories.length > 0) {
        this.log.debug(
          'Removing orphaned accessories from cache: ',
          orphanedAccessories.map(({ displayName }) => displayName).join(', '),
        );
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, orphanedAccessories);
      }
    }
  }
}

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
import {
  AladdinConnect,
  AladdinConnectConfig,
  AladdinDoor,
} from './aladdinConnect';
import { GenieAladdinConnectPlatform } from './platform';

// Matter API types are only available in Homebridge v2.0+. Use `any` to remain
// compatible with the v1.x type definitions installed as devDependencies.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MatterAccessory = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MatterAPI = any;

export class AladdinConnectMatterPlatform
  implements DynamicPlatformPlugin, GenieAladdinConnectPlatform {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  public readonly accessories: PlatformAccessory[] = [];
  public readonly matterAccessories: Map<string, MatterAccessory> = new Map();
  public readonly aladdinConnect: AladdinConnect;

  private get matterApi(): MatterAPI {
    return (this.api as MatterAPI).matter;
  }

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = this.api.hap.Service;
    this.Characteristic = this.api.hap.Characteristic;
    this.aladdinConnect = new AladdinConnect(log, <AladdinConnectConfig>(<unknown>config));

    this.log.debug('Matter platform initialized for Aladdin Connect');

    if (!(this.api as MatterAPI).isMatterAvailable?.()) {
      this.log.warn(
        'Matter is not available in this version of Homebridge. Please update to Homebridge v2.0 or later to use Matter features.',
      );
    }

    if (!(this.api as MatterAPI).isMatterEnabled?.()) {
      this.log.warn(
        'Matter is not enabled in Homebridge. Please enable Matter in the Homebridge settings to use Matter features.',
      );
    }

    this.api.on(APIEvent.DID_FINISH_LAUNCHING, async () => this.discoverDevices());
  }

  configureAccessory(accessory: PlatformAccessory) {
    // Homebridge may call this for HAP accessories cached from a previous run
    // (e.g., before the plugin switched to Matter). Unregister them immediately
    // so they don't persist alongside Matter accessories and cause duplicates.
    this.log.info(
      'Removing stale HAP accessory cached before Matter migration: %s',
      accessory.displayName,
    );
    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
  }

  /**
   * Called by the Homebridge Matter framework when restoring cached Matter
   * accessories from disk at startup.
   */
  configureMatterAccessory(accessory: MatterAccessory) {
    this.log.debug('Loading cached Matter accessory:', accessory.displayName);
    this.matterAccessories.set(accessory.UUID, accessory);
  }

  async discoverDevices() {
    if (!this.matterApi) {
      this.log.error('Matter API is not available; cannot discover devices.');
      return;
    }
    let doors: AladdinDoor[];
    try {
      doors = await this.aladdinConnect.getAllDoors();
    } catch (error: unknown) {
      this.log.error('Failed to load doors from account; retrying in 5 minutes');
      setTimeout(this.discoverDevices.bind(this), 5 * 60 * 1000);
      return;
    }
    const externalAccessory: boolean =
      this.config.externalAccessory ?? DEFAULT_EXTERNAL_ACCESSORY;

    // When switching to external mode, unregister any cached Matter accessories.
    if (externalAccessory && this.matterAccessories.size > 0) {
      this.log.info(
        'External accessory mode enabled; removing %d cached Matter accessory(s)',
        this.matterAccessories.size,
      );
      const allCached = [...this.matterAccessories.values()];
      await this.matterApi.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, allCached);
      this.matterAccessories.clear();
    }

    const discoveredUUIDs: Set<string> = new Set();

    for (const door of doors) {
      if (Array.isArray(this.config.ignoreDevices) && this.config.ignoreDevices.includes(door.id)) {
        this.log.info('Skipping ignored accessory: %s (id: %s)', door.name, door.id);
        continue;
      }
      if (door.ownership === 'owned' || this.config.showShared === true) {
        const uuid = this.matterApi.uuid.generate(`${door.deviceId}:${door.index}`);
        discoveredUUIDs.add(uuid);

        const matterAccessory: MatterAccessory =
          new (this.api as MatterAPI).platformMatterAccessory(door.name, uuid);

        // Update the accessory context with the door.
        matterAccessory.context = <GenieAladdinConnectPlatformAccessoryContext>{ door };

        if (externalAccessory) {
          // External accessories are published independently and do not participate
          // in the Matter platform-accessory cache lifecycle.
          this.log.info(
            'Publishing external Matter accessory: %s (id: %s)',
            door.name,
            door.id,
          );
          await this.matterApi.publishExternalAccessories(PLUGIN_NAME, [matterAccessory]);
        } else {
          const existingAccessory = this.matterAccessories.has(uuid);
          if (existingAccessory) {
            this.log.info(
              'Restoring existing Matter accessory from cache: %s (id: %s)',
              matterAccessory.displayName,
              door.id,
            );
            await this.matterApi.updatePlatformAccessories([matterAccessory]);
          } else {
            this.log.info('Adding new Matter accessory: %s (id: %s)', door.name, door.id);
            await this.matterApi.registerPlatformAccessories(
              PLUGIN_NAME,
              PLATFORM_NAME,
              [matterAccessory],
            );
          }
          this.matterAccessories.set(uuid, matterAccessory);
        }
        new GenieAladdinConnectGarageDoorAccessory(
          this,
          matterAccessory as unknown as PlatformAccessory,
        );
      } else {
        this.log.info('Not adding door:', door.name, ' because it is not owned by this account.');
      }
    }

    // Orphan cleanup only applies to bridged (non-external) mode.
    if (!externalAccessory) {
      const orphanedAccessories = [...this.matterAccessories.values()].filter(
        (accessory) => !discoveredUUIDs.has(accessory.UUID),
      );
      if (orphanedAccessories.length > 0) {
        this.log.debug(
          'Removing orphaned Matter accessories from cache: ',
          orphanedAccessories
            .map(({ displayName }: { displayName: string }) => displayName)
            .join(', '),
        );
        await this.matterApi.unregisterPlatformAccessories(
          PLUGIN_NAME,
          PLATFORM_NAME,
          orphanedAccessories,
        );
        for (const accessory of orphanedAccessories) {
          this.matterAccessories.delete(accessory.UUID);
        }
      }
    }
  }
}

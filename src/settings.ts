/**
 * This is the name of the platform that users will use to register the plugin in the Homebridge
 * config.json
 */
export const PLATFORM_NAME = 'GenieAladdinConnect';

/**
 * This must match the name of your plugin as defined the package.json
 */
export const PLUGIN_NAME = 'homebridge-aladdin-connect';

/**
 * Default status low battery threshold in percent.
 */
export const DEFAULT_STATUS_LOW_BATTERY_PERCENT = 15;

/**
 * Whether to prefer Matter over HAP when Matter is available and enabled.
 * Defaults to true.
 */
export const DEFAULT_PREFER_MATTER = true;

/**
 * Whether to enable Matter support.
 * Defaults to true.
 */
export const DEFAULT_ENABLE_MATTER = true;

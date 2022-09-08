import {API, Characteristic, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service} from 'homebridge';

import {PLATFORM_NAME, PLUGIN_NAME} from './settings';
import {TibberPriceSensor} from './priceSensor';
import {TibberQuery} from 'tibber-api';
import {CachedTibberClient} from './tibber';

/**
 * HomebridgePlatform
 * This class is the main constructor for your plugin, this is where you should
 * parse the user config and discover/register accessories with Homebridge.
 */

export class TibberPricePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;

  // this is used to track restored cached accessories
  public readonly accessories: PlatformAccessory[] = [];
  public readonly tibber: CachedTibberClient;

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.log.debug('Finished initializing platform:', this.config.name);

    const accessToken = this.config['accessToken'];
    if (!accessToken) {
      throw new Error('(homebridge-tibber-price) Invalid config! "accessToken" is required');
    }

    const theConf = this.config as unknown as Config;
    this.tibber = new CachedTibberClient(this, theConf);

    // When this event is fired it means Homebridge has restored all cached accessories from disk.
    // Dynamic Platform plugins should only register new accessories after this event was fired,
    // in order to ensure they weren't added to homebridge already. This event can also be used
    // to start discovery of new accessories.
    this.api.on('didFinishLaunching', () => {
      log.debug('Executed didFinishLaunching callback');
      // run the method to discover / register your devices as accessories
      this.discoverDevices();
    });
  }

  /**
   * This function is invoked when homebridge restores cached accessories from disk at startup.
   * It should be used to setup event handlers for characteristics and update respective values.
   */
  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Configuring accessory %s, with id %s', accessory.displayName, accessory.UUID);
    // add the restored accessory to the accessories cache so we can track if it has already been registered
    this.accessories.push(accessory);
  }

  /**
   * This is an example method showing how to register discovered accessories.
   * Accessories must only be registered once, previously created accessories
   * must not be registered again to prevent "duplicate UUID" errors.
   */
  discoverDevices() {
    this.log.info('Registering devices...');
    this.registerDeregisterPriceSensor();
  }

  private registerDeregisterPriceSensor() {
    const uuid = this.api.hap.uuid.generate('hb-tb-price-price-sensor');
    const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);

    if (this.config['activatePriceSensor']) {
      this.log.info('Registering price sensor with id %s', uuid);

      if (existingAccessory) {
        new TibberPriceSensor(this, existingAccessory);
      } else {
        const priceSensorAccessory = new this.api.platformAccessory('Electricity price', uuid);
        new TibberPriceSensor(this, priceSensorAccessory);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [priceSensorAccessory]);
      }
    } else if (existingAccessory) {
      this.log.info('Removing price sensor with id %s', uuid);
      this.api.unregisterPlatformAccessories(PLATFORM_NAME, PLATFORM_NAME, [existingAccessory]);
    }
  }
}

export interface Config {
  accessToken: string;
  homeId?: string;
  priceIncTax: boolean;
}

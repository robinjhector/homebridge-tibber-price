import {API, Characteristic, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service} from 'homebridge';

import {PLATFORM_NAME, PLUGIN_NAME} from './settings';
import {TibberPriceSensor} from './priceSensor';
import {CachedTibberClient} from './tibber';
import {TibberRelativePriceSensor} from './relativePriceSensor';
import {TibberGraphing} from './graphing';

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
  public readonly backgroundTasks: (() => void)[] = [];
  public readonly tibber?: CachedTibberClient;

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.log.debug('Finished initializing platform:', this.config.name);

    const accessToken = this.config['accessToken'];
    if (!accessToken) {
      this.log.error('(homebridge-tibber-price) Invalid config! "accessToken" is required. Plugin can not start');
      return;
    }

    this.tibber = new CachedTibberClient(this);

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
    this.registerDeregisterRelativePriceSensor();
    this.registerDeregisterGaugePriceSensor();
    this.registerDeregisterPriceGraphing();
    this.log.info('Starting background tasks...');

    setInterval(() => {
      for (const backgroundTask of this.backgroundTasks) {
        try {
          backgroundTask();
        } catch (e) {
          this.log.error('Failed to perform background task!');
        }
      }
    }, 1000 * 60);
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

  private registerDeregisterRelativePriceSensor() {
    const uuid = this.api.hap.uuid.generate('hb-tb-price-rel-price-sensor');
    const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);

    if (this.config['activateRelativePriceSensor']) {
      this.log.info('Registering relative price sensor with id %s', uuid);

      if (existingAccessory) {
        new TibberRelativePriceSensor(this, existingAccessory, false);
      } else {
        const priceSensorAccessory = new this.api.platformAccessory('Relative electricity price', uuid);
        new TibberRelativePriceSensor(this, priceSensorAccessory, false);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [priceSensorAccessory]);
      }
    } else if (existingAccessory) {
      this.log.info('Removing relative price sensor with id %s', uuid);
      this.api.unregisterPlatformAccessories(PLATFORM_NAME, PLATFORM_NAME, [existingAccessory]);
    }
  }

  private registerDeregisterGaugePriceSensor() {
    const uuid = this.api.hap.uuid.generate('hb-tb-price-gauge-price-sensor');
    const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);

    if (this.config['activateGaugePriceSensor']) {
      this.log.info('Registering gauge price sensor with id %s', uuid);

      if (existingAccessory) {
        new TibberRelativePriceSensor(this, existingAccessory, true);
      } else {
        const priceSensorAccessory = new this.api.platformAccessory('Electricity price gauge', uuid);
        new TibberRelativePriceSensor(this, priceSensorAccessory, true);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [priceSensorAccessory]);
      }
    } else if (existingAccessory) {
      this.log.info('Removing relative price sensor with id %s', uuid);
      this.api.unregisterPlatformAccessories(PLATFORM_NAME, PLATFORM_NAME, [existingAccessory]);
    }
  }

  private registerDeregisterPriceGraphing() {
    if (this.config['activatePriceGraphing']) {
      new TibberGraphing(this);
    }
  }
}

export interface TypedConfig {
  accessToken: string;
  homeId?: string;
  priceIncTax: boolean;
}


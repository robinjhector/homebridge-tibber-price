import type {
  API, Characteristic, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service,
} from 'homebridge' with {'resolution-mode': 'import'};

import {PLATFORM_NAME, PLUGIN_NAME} from './settings';
import {TibberPriceSensor} from './priceSensor';
import {CachedTibberClient} from './tibber';
import {TibberRelativePriceSensor} from './relativePriceSensor';
import {TibberGraphing} from './graphing';
import {TibberPriceLevelSensor} from './priceLevelSensor';

const PRICE_INTERVAL_MS = 15 * 60 * 1000;

/**
 * HomebridgePlatform
 * This class is the main constructor for your plugin, this is where you should
 * parse the user config and discover/register accessories with Homebridge.
 */

export class TibberPricePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  // this is used to track restored cached accessories
  public readonly accessories: PlatformAccessory[] = [];
  public readonly backgroundTasks: (() => void | Promise<void>)[] = [];
  public readonly tibber?: CachedTibberClient;

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = this.api.hap.Service;
    this.Characteristic = this.api.hap.Characteristic;
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
    this.registerDeregisterPriceLevelSensor();
    this.registerDeregisterPriceGraphing();
    this.log.info('Starting background tasks...');

    // Run once as soon as prices can be fetched, then whenever a new price interval starts
    this.tibber?.onReady(() => this.runBackgroundTasks());
    this.scheduleBackgroundTasks();
  }

  /**
   * Prices change every 15 minutes (on :00, :15, :30 and :45), so there's no point in updating more often than that.
   */
  private scheduleBackgroundTasks() {
    const now = Date.now();
    // A few seconds past the boundary, so the new interval has certainly started
    const next = Math.floor(now / PRICE_INTERVAL_MS) * PRICE_INTERVAL_MS + PRICE_INTERVAL_MS + 5000;
    setTimeout(() => {
      this.runBackgroundTasks();
      this.scheduleBackgroundTasks();
    }, next - now);
  }

  private runBackgroundTasks() {
    for (const backgroundTask of this.backgroundTasks) {
      // Tasks may be async, make sure a rejection never goes unhandled (that would crash Homebridge)
      Promise.resolve()
        .then(() => backgroundTask())
        .catch(err => this.log.error('Failed to perform background task!', err));
    }
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
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [existingAccessory]);
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
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [existingAccessory]);
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
      this.log.info('Removing gauge price sensor with id %s', uuid);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [existingAccessory]);
    }
  }

  private registerDeregisterPriceLevelSensor() {
    const uuid = this.api.hap.uuid.generate('hb-tb-price-level-sensor');
    const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);

    if (this.config['activatePriceLevelSensor']) {
      this.log.info('Registering price level sensor with id %s', uuid);

      if (existingAccessory) {
        new TibberPriceLevelSensor(this, existingAccessory);
      } else {
        const priceLevelAccessory = new this.api.platformAccessory('Electricity price level', uuid);
        new TibberPriceLevelSensor(this, priceLevelAccessory);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [priceLevelAccessory]);
      }
    } else if (existingAccessory) {
      this.log.info('Removing price level sensor with id %s', uuid);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [existingAccessory]);
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
  priceIncTax?: boolean;
}


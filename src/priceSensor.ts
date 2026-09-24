import type {PlatformAccessory, Service} from 'homebridge' with {'resolution-mode': 'import'};

import {TibberPricePlatform} from './platform';
import {CachedTibberClient} from './tibber';
import {clamp} from './utils';

// HomeKit's allowed range for CurrentAmbientLightLevel. Negative (or zero) spot prices can't be represented.
const MIN_LUX = 0.0001;
const MAX_LUX = 100000;

/**
 * Registers a price value accessory, that will manifest itself as a LightSensor.
 * Displaying the price in cents, as "Current ambiance level" (lux)
 *
 * 1KR = 100 lux
 */
export class TibberPriceSensor {
  private service: Service;
  private readonly tibber: CachedTibberClient;

  constructor(
    private readonly platform: TibberPricePlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    this.tibber = platform.tibber!;
    // set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'robinjhector@github')
      .setCharacteristic(this.platform.Characteristic.Model, 'Tibber-Price Sensor')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, '1.0.0');

    // set services
    this.service = this.accessory.getService(this.platform.Service.LightSensor)
      || this.accessory.addService(this.platform.Service.LightSensor);

    // set handlers
    this.service.getCharacteristic(this.platform.Characteristic.CurrentAmbientLightLevel)
      .onGet(() => this.getPrice().catch(err => {
        this.platform.log.error('[priceSensor] Failed to get price', err);
        throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      }));

    // register task handlers
    platform.backgroundTasks.push(() => this.updateValue());
  }

  private updateValue(): void {
    this.platform.log.debug('Updating price in the background...');
    this.getPrice()
      .then(price => this.service.updateCharacteristic(this.platform.Characteristic.CurrentAmbientLightLevel, price))
      .catch(err => {
        this.platform.log.error('[priceSensor] Failed to update price in background', err);
      });
  }

  private getPrice(): Promise<number> {
    return this.tibber.getCurrentPrice().then(price => clamp(price, MIN_LUX, MAX_LUX));
  }
}

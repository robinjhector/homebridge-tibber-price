import {HAPStatus, PlatformAccessory, Service} from 'homebridge';

import {TibberPricePlatform} from './platform';
import {CachedTibberClient} from './tibber';

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
      .onGet(() => this.tibber.getCurrentPrice().catch(err => {
        this.platform.log.error('[priceSensor] Failed to get price', err);
        throw new this.platform.api.hap.HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      }));

    // register task handlers
    platform.backgroundTasks.push(() => this.updateValue());
  }

  private updateValue(): void {
    this.platform.log.debug('Updating price in the background...');
    this.tibber.getCurrentPrice()
      .then(price => this.service.updateCharacteristic(this.platform.Characteristic.CurrentAmbientLightLevel, price))
      .catch(err => {
        this.platform.log.error('[relativePriceSensor] Failed to update price in background', err);
      });
  }
}

import {HAPStatus, PlatformAccessory, Service} from 'homebridge';

import {TibberPricePlatform} from './platform';
import {CachedTibberClient} from './tibber';

/**
 * Registers a relative price value accessory, that will manifest itself as a HumiditySensor.
 * Displaying the electricty price in percentage (based on min & max for the current day)
 */
export class TibberRelativePriceSensor {
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
    this.service = this.accessory.getService(this.platform.Service.HumiditySensor)
      || this.accessory.addService(this.platform.Service.HumiditySensor);

    // set handlers
    this.service.getCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity)
      .onGet(() => this.tibber.getCurrentPriceRelatively().catch(err => {
        this.platform.log.error('[relativePriceSensor] Failed to get price', err);
        throw new this.platform.api.hap.HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      }));

    // register task handlers
    platform.backgroundTasks.push(() => this.updateValue());
  }

  private updateValue(): void {
    this.platform.log.debug('Updating relative price in the background...');
    this.tibber.getCurrentPriceRelatively()
      .then(perc => this.service.updateCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity, perc))
      .catch(err => {
        this.platform.log.error('[relativePriceSensor] Failed to update price in background', err);
      });
  }
}

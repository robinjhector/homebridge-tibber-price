import type {PlatformAccessory, Service} from 'homebridge' with {'resolution-mode': 'import'};

import {TibberPricePlatform} from './platform';
import {CachedTibberClient} from './tibber';

/**
 * Registers a price level accessory, that will manifest itself as an AirQualitySensor.
 * Displaying Tibber's price level for the current price (relative to the recent average price) as air quality:
 * very cheap = excellent, cheap = good, normal = fair, expensive = inferior, very expensive = poor.
 */
export class TibberPriceLevelSensor {
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
    this.service = this.accessory.getService(this.platform.Service.AirQualitySensor)
      || this.accessory.addService(this.platform.Service.AirQualitySensor);

    // set handlers
    this.service.getCharacteristic(this.platform.Characteristic.AirQuality)
      .onGet(() => this.getAirQuality().catch(err => {
        this.platform.log.error('[priceLevelSensor] Failed to get price level', err);
        throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      }));

    // register task handlers
    platform.backgroundTasks.push(() => this.updateValue());
  }

  private updateValue(): void {
    this.platform.log.debug('Updating price level in the background...');
    this.getAirQuality()
      .then(quality => this.service.updateCharacteristic(this.platform.Characteristic.AirQuality, quality))
      .catch(err => {
        this.platform.log.error('[priceLevelSensor] Failed to update price level in background', err);
      });
  }

  private getAirQuality(): Promise<number> {
    const AirQuality = this.platform.Characteristic.AirQuality;
    return this.tibber.getCurrentPriceLevel().then(level => {
      switch (level) {
        case 'VERY_CHEAP':
          return AirQuality.EXCELLENT;
        case 'CHEAP':
          return AirQuality.GOOD;
        case 'NORMAL':
          return AirQuality.FAIR;
        case 'EXPENSIVE':
          return AirQuality.INFERIOR;
        case 'VERY_EXPENSIVE':
          return AirQuality.POOR;
        default:
          return AirQuality.UNKNOWN;
      }
    });
  }
}

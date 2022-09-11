import {TibberQuery} from 'tibber-api';
import {TibberPricePlatform, TypedConfig} from './platform';
import {IPrice} from 'tibber-api/lib/src/models/IPrice';
import fs from 'fs';
import {dateEq, dateHrEq, formatDate} from './utils';
import {HAPStatus} from 'homebridge';

export class CachedTibberClient {

  private readonly tibber: TibberQuery;
  private readonly path: string;
  private readonly cache: Map<string, IPrice[]>;
  private homeId?: string;
  private initiated = false;

  constructor(
    private readonly platform: TibberPricePlatform,
  ) {
    const config = platform.config as unknown as TypedConfig;
    this.path = platform.api.user.storagePath() + '/tibber-price';
    this.cache = new Map();
    this.homeId = config.homeId;
    this.tibber = new TibberQuery({
      active: true,
      apiEndpoint: {
        queryUrl: 'https://api.tibber.com/v1-beta/gql',
        feedUrl: 'wss://api.tibber.com/v1-beta/gql/subscriptions',
        apiKey: config.accessToken,
      },
    });

    if (!fs.existsSync(this.path)) {
      fs.mkdirSync(this.path);
    }

    if (!this.homeId) {
      this.getFirstHomeId()
        .then(homeId => {
          this.platform.log.info('No HomeId defined, so using:', homeId);
          this.homeId = homeId;
          this.initiated = true;
        });
    } else {
      this.initiated = true;
    }

    this.platform.log.info('Initialized Tibber client');
  }

  getCurrentPrice(): Promise<IPrice> {
    if (!this.initiated) {
      throw new this.platform.api.hap.HapStatusError(HAPStatus.RESOURCE_BUSY);
    }
    const now = new Date();
    return this.getPricesForHour(now);
  }

  private getPricesForHour(forDateAndHour: Date): Promise<IPrice> {
    return this.getPricesForDay(forDateAndHour)
      .then(prices => prices.find(price => dateHrEq(forDateAndHour, new Date(price.startsAt))) || this.throwServiceComFailure());
  }

  private getPricesForDay(forDate: Date): Promise<IPrice[]> {
    return this.getPricesFromCache(forDate)
      .catch(() => this.getPricesFromFile(forDate))
      .catch(() => this.getPricesFromApi(forDate));
  }

  private getFirstHomeId(): Promise<string> {
    return this.tibber.getHomes().then(homes => {
      if (!Array.isArray(homes) || homes.length > 0) {
        return homes[0].id;
      } else {
        this.platform.log.error('Could not get a HomeId from the Tibber API!');
        throw new this.platform.api.hap.HapStatusError(HAPStatus.INVALID_VALUE_IN_REQUEST);
      }
    });
  }

  private getPricesFromCache(forDate: Date): Promise<IPrice[]> {
    this.platform.log.debug('Getting prices from cache');
    return new Promise((res, rej) => {
      const key = formatDate(forDate);
      if (this.cache.has(key)) {
        return res(this.cache.get(key)!);
      }
      rej('No data found in-memory cache');
    });
  }

  private getPricesFromFile(forDate: Date): Promise<IPrice[]> {
    this.platform.log.debug('Getting prices from file');
    const key = formatDate(forDate);
    const file = this.path + '/' + key + '.json';
    if (fs.existsSync(file)) {
      this.platform.log.debug('Found existing file', file);
      return new Promise((res, rej) => {
        fs.readFile(file, (err, data) => {
          if (err) {
            this.platform.log.error('Failed to read cached price file', file);
            rej(err);
          }
          const prices = JSON.parse(data.toString()) as IPrice[];
          this.cache.set(key, prices);
          res(prices);
        });
      });
    }

    this.platform.log.debug('No file found');
    return Promise.reject('No such file: ' + file);
  }

  private getPricesFromApi(forDate: Date): Promise<IPrice[]> {
    this.platform.log.debug('Getting prices from API');
    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);

    const responseHandler = (prices: IPrice[]) => {
      this.platform.log.debug('Received API response', prices);
      return this.persistPrices(forDate, prices);
    };

    if (dateEq(today, forDate)) {
      return this.tibber.getTodaysEnergyPrices(this.homeId!).then(responseHandler);
    } else if (dateEq(tomorrow, forDate)) {
      return this.tibber.getTomorrowsEnergyPrices(this.homeId!).then(responseHandler);
    } else {
      return Promise.reject('Can only query for prices today, or tomorrow. Was: ' + forDate);
    }
  }

  private persistPrices(forDate: Date, newPrices: IPrice[]): Promise<IPrice[]> {
    if (!Array.isArray(newPrices) || newPrices.length < 1) {
      return Promise.reject('No prices returned from API!');
    }

    const key = formatDate(forDate);
    const file = this.path + '/' + key + '.json';
    if (!fs.existsSync(file)) {
      return new Promise((res, rej) => {
        fs.writeFile(file, JSON.stringify(newPrices), () => {
          this.cache.set(key, newPrices);
          this.platform.log.info('Stored price information for', key);
          res(newPrices);
        });
      });
    } else {
      return Promise.reject('File already exists: ' + file);
    }
  }

  private throwServiceComFailure(): any {
    throw new this.platform.api.hap.HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }
}


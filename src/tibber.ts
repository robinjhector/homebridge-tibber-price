import {TibberQuery} from 'tibber-api';
import {TibberPricePlatform, TypedConfig} from './platform';
import {IPrice} from 'tibber-api/lib/src/models/IPrice';
import fs from 'fs';
import {dateEq, dateHrEq, formatDate, fractionated} from './utils';

export class CachedTibberClient {

  private readonly tibber: TibberQuery;
  private readonly path: string;
  private readonly cache: Map<string, IPrice[]>;
  private priceIncTax = true;
  private homeId?: string;
  public initiated = false;
  public errorState = false;

  constructor(
    private readonly platform: TibberPricePlatform,
  ) {
    const config = platform.config as unknown as TypedConfig;
    this.path = platform.api.user.storagePath() + '/tibber-price';
    this.cache = new Map();
    this.homeId = config.homeId;
    this.priceIncTax = config.priceIncTax;
    this.tibber = new TibberQuery({
      active: true,
      apiEndpoint: {
        queryUrl: 'https://api.tibber.com/v1-beta/gql',
        apiKey: config.accessToken,
      },
    });

    if (!fs.existsSync(this.path)) {
      fs.mkdirSync(this.path);
    }

    if (!this.homeId) {
      // No HomeId specified in config, so let's try and resolve the first one from API.
      this.platform.log.info('No HomeId specified, reaching out to Tibber API to find the first one');
      this.getFirstHomeId()
        .then(homeId => {
          this.platform.log.info('Found Home, with ID:', homeId);
          this.homeId = homeId;
        }).catch(err => {
          this.platform.log.error('Failed to query HomeId from Tibber, none of the accessories will work! See error:', err);
          this.errorState = true;
        }).finally(() => this.initiated = true);
    } else {
      this.tibber.getHomes()
        .then(homes => {
          const homeIdsFromApi = homes.map(h => h.id);
          const homeIdValid = homeIdsFromApi.find(hid => hid === this.homeId);
          if (!homeIdValid) {
            this.platform.log.error(`Incorrect HomeId in config. Was: '${this.homeId}', but expected one of: ${homeIdsFromApi}`);
            this.errorState = true;
          }
        }).catch(err => {
          this.platform.log.error('Failed to validate HomeId from Tibber, none of the accessories will work! See error:', err);
          this.errorState = true;
        }).finally(() => this.initiated = true);
      this.initiated = true;
    }

    this.platform.log.info('Initialized Tibber client');
  }

  getCurrentPrice(): Promise<number> {
    const now = new Date();
    return this.assertValidState()
      .then(() => this.getPricesForHour(now));
  }

  getCurrentPriceRelatively(): Promise<number> {
    const forDateAndHour = new Date();
    return this.assertValidState()
      .then(() => this.getPricesForDay(forDateAndHour))
      .then(prices => {
        const allPricesForToday = prices.map(price => fractionated(price, this.priceIncTax));
        const currIPrice = prices.find(price => dateHrEq(forDateAndHour, new Date(price.startsAt)))!;
        const currPrice = fractionated(currIPrice, this.priceIncTax);
        const maxPrice = Math.max(...allPricesForToday);

        return (currPrice / maxPrice) * 100;
      });
  }

  getTodaysPrices(): Promise<number[]> {
    const today = new Date();
    return this.assertValidState()
      .then(() => this.getPricesForDay(today))
      .then(prices => prices.map(price => fractionated(price, this.priceIncTax)));
  }

  getTomorrowsPrices(): Promise<number[]> {
    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);

    return this.assertValidState()
      .then(() => this.getPricesForDay(tomorrow))
      .then(prices => prices.map(price => fractionated(price, this.priceIncTax)));
  }

  private getPricesForHour(forDateAndHour: Date): Promise<number> {
    return this.getPricesForDay(forDateAndHour)
      .then(prices => prices.find(price => dateHrEq(forDateAndHour, new Date(price.startsAt)))!)
      .then(price => fractionated(price, this.priceIncTax));
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
        return Promise.reject('Returned list of Homes via Tibber was empty');
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
          try {
            const prices = JSON.parse(data.toString()) as IPrice[];
            this.cache.set(key, prices);
            res(prices);
          } catch (err) {
            this.platform.log.debug('Failed to parse prices from file', file);
            rej('Failed to parse prices from file');
          }
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

    const responseHandler = (prices: IPrice[]): Promise<IPrice[]> => {
      this.platform.log.debug('Received API response', prices);
      if (!Array.isArray(prices) || prices.length < 1) {
        this.platform.log.error('No prices returned from API. Was:', prices);
        return Promise.reject('No prices returned from API!');
      }
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
    const key = formatDate(forDate);
    const file = this.path + '/' + key + '.json';
    return new Promise((res, rej) => {
      fs.writeFile(file, JSON.stringify(newPrices), err => {
        if (err) {
          this.platform.log.error('Failed to persist prices to disk', err);
          rej(err);
        } else {
          this.cache.set(key, newPrices);
          this.platform.log.info('Stored price information for', key);
          res(newPrices);
        }
      });
    });
  }

  private assertValidState(): Promise<unknown> {
    if (!this.initiated) {
      return Promise.reject('Tibber client not initialised yet');
    }
    if (this.errorState) {
      return Promise.reject('The Tibber Client is in an error state. Check logs.');
    }

    return Promise.resolve();
  }
}


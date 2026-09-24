import {TibberQuery} from 'tibber-api';
import {TibberPricePlatform, TypedConfig} from './platform';
import {IPrice} from 'tibber-api/lib/src/models/IPrice';
import fs from 'fs';
import {clamp, dateEq, formatDate, fractionated} from './utils';
import {PLUGIN_NAME} from './settings';

// Spot prices are set per 15 minutes (since the move to 15-minute market time units in October 2025)
const PRICE_RESOLUTION = 'QUARTER_HOURLY';
const PRICE_FILE = /^(prices-)?(\d{4}-\d{2}-\d{2})\.json$/;
const INIT_RETRY_MIN_MS = 30 * 1000;
const INIT_RETRY_MAX_MS = 15 * 60 * 1000;

export class CachedTibberClient {

  private readonly tibber: TibberQuery;
  private readonly path: string;
  private readonly cache: Map<string, IPrice[]>;
  private readonly inFlight: Map<string, Promise<IPrice[]>>;
  private priceIncTax = true;
  private homeId?: string;
  private initRetryMs = INIT_RETRY_MIN_MS;
  private readonly readyListeners: (() => void)[] = [];
  public initiated = false;
  public invalidConfig = false;

  constructor(
    private readonly platform: TibberPricePlatform,
  ) {
    const config = platform.config as unknown as TypedConfig;
    this.path = platform.api.user.storagePath() + '/tibber-price';
    this.cache = new Map();
    this.inFlight = new Map();
    this.homeId = config.homeId;
    this.priceIncTax = config.priceIncTax !== false;
    this.tibber = new TibberQuery({
      active: true,
      apiEndpoint: {
        queryUrl: 'https://api.tibber.com/v1-beta/gql',
        apiKey: config.accessToken,
        userAgent: `${PLUGIN_NAME} (https://github.com/robinjhector/homebridge-tibber-price)`,
      },
    });

    fs.mkdirSync(this.path, {recursive: true});

    this.initialise();
    this.platform.log.info('Initialized Tibber client');
  }

  /**
   * Resolves (or validates) the HomeId. Only a HomeId that Tibber doesn't know about is treated as an invalid config,
   * any other failure (network down at boot, Tibber API hiccup, etc.) is retried with a backoff.
   */
  private initialise(): void {
    const init = this.homeId ? this.validateHomeId(this.homeId) : this.resolveFirstHomeId();
    init
      .then(() => {
        this.initiated = true;
        this.readyListeners.forEach(listener => listener());
      })
      .catch(err => {
        this.platform.log.error(`Failed to reach Tibber, will retry in ${this.initRetryMs / 1000}s. See error:`, err);
        setTimeout(() => this.initialise(), this.initRetryMs);
        this.initRetryMs = Math.min(this.initRetryMs * 2, INIT_RETRY_MAX_MS);
      });
  }

  private resolveFirstHomeId(): Promise<void> {
    // No HomeId specified in config, so let's try and resolve the first one from API.
    this.platform.log.info('No HomeId specified, reaching out to Tibber API to find the first one');
    return this.tibber.getHomes().then(homes => {
      if (!Array.isArray(homes) || homes.length < 1) {
        this.platform.log.error('Returned list of Homes via Tibber was empty, none of the accessories will work!');
        this.invalidConfig = true;
        return;
      }
      this.homeId = homes[0].id;
      this.platform.log.info('Found Home, with ID:', this.homeId);
    });
  }

  private validateHomeId(homeId: string): Promise<void> {
    return this.tibber.getHomes().then(homes => {
      const homeIdsFromApi = (homes ?? []).map(h => h.id);
      if (!homeIdsFromApi.includes(homeId)) {
        this.platform.log.error(`Incorrect HomeId in config. Was: '${homeId}', but expected one of: ${homeIdsFromApi}`);
        this.invalidConfig = true;
      }
    });
  }

  /**
   * Calls the listener once the client is initiated (or immediately, if it already is).
   */
  onReady(listener: () => void): void {
    if (this.initiated) {
      listener();
    } else {
      this.readyListeners.push(listener);
    }
  }

  getCurrentPrice(): Promise<number> {
    const now = new Date();
    return this.assertValidState()
      .then(() => this.getPricesForDay(now))
      .then(prices => fractionated(findCurrentPrice(prices, now), this.priceIncTax));
  }

  getCurrentPriceRelatively(relativeFromLowestPoint = false): Promise<number> {
    const now = new Date();
    return this.assertValidState()
      .then(() => this.getPricesForDay(now))
      .then(prices => {
        const allPricesForToday = prices.map(price => fractionated(price, this.priceIncTax));
        const currPrice = fractionated(findCurrentPrice(prices, now), this.priceIncTax);
        const minPrice = Math.min(...allPricesForToday);
        const maxPrice = Math.max(...allPricesForToday);

        // Guard against division by zero / negative prices, HomeKit only accepts 0 - 100
        if (relativeFromLowestPoint) {
          if (maxPrice === minPrice) {
            return 0;
          }
          return clamp(((currPrice - minPrice) / (maxPrice - minPrice)) * 100, 0, 100);
        }
        if (maxPrice <= 0) {
          return 0;
        }
        return clamp((currPrice / maxPrice) * 100, 0, 100);
      });
  }

  getTodaysPrices(): Promise<PricePoint[]> {
    const today = new Date();
    return this.assertValidState()
      .then(() => this.getPricesForDay(today))
      .then(prices => this.toPricePoints(prices));
  }

  getTomorrowsPrices(): Promise<PricePoint[]> {
    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);

    return this.assertValidState()
      .then(() => this.getPricesForDay(tomorrow))
      .then(prices => this.toPricePoints(prices));
  }

  private toPricePoints(prices: IPrice[]): PricePoint[] {
    return prices
      .filter(price => price.startsAt)
      .map(price => ({
        startsAt: new Date(price.startsAt!),
        price: fractionated(price, this.priceIncTax),
        level: price.level,
      }));
  }

  private getPricesForDay(forDate: Date): Promise<IPrice[]> {
    const key = formatDate(forDate);
    const cached = this.cache.get(key);
    if (cached) {
      return Promise.resolve(cached);
    }

    // Several sensors ask for the same day at once, only hit the disk & API once.
    let pending = this.inFlight.get(key);
    if (!pending) {
      pending = this.getPricesFromFile(forDate)
        .catch(() => this.getPricesFromApi(forDate))
        .finally(() => this.inFlight.delete(key));
      this.inFlight.set(key, pending);
    }
    return pending;
  }

  private getPricesFromFile(forDate: Date): Promise<IPrice[]> {
    this.platform.log.debug('Getting prices from file');
    const key = formatDate(forDate);
    const file = this.priceFile(key);
    return fs.promises.readFile(file)
      .then(data => {
        const prices = JSON.parse(data.toString()) as IPrice[];
        if (!Array.isArray(prices) || prices.length < 1) {
          throw new Error('Cached price file is empty: ' + file);
        }
        this.platform.log.debug('Found existing file', file);
        this.cache.set(key, prices);
        return prices;
      })
      .catch(err => {
        this.platform.log.debug('No usable price file found', file, err?.message ?? err);
        throw err;
      });
  }

  private getPricesFromApi(forDate: Date): Promise<IPrice[]> {
    this.platform.log.debug('Getting prices from API');
    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);
    const isTomorrow = dateEq(tomorrow, forDate);

    const responseHandler = (prices: IPrice[]): Promise<IPrice[]> => {
      this.platform.log.debug('Received API response', prices);
      if (!Array.isArray(prices) || prices.length < 1) {
        if (isTomorrow) {
          // Expected, Tibber publishes tomorrow's prices in the afternoon
          this.platform.log.debug('Tomorrow\'s prices not yet available from API');
          return Promise.reject('Tomorrow\'s prices are not yet available');
        }
        this.platform.log.error('No prices returned from API. Was:', prices);
        return Promise.reject('No prices returned from API!');
      }
      return this.persistPrices(forDate, prices);
    };

    if (dateEq(today, forDate)) {
      return this.tibber.getTodaysEnergyPrices(this.homeId!, PRICE_RESOLUTION).then(responseHandler);
    } else if (isTomorrow) {
      return this.tibber.getTomorrowsEnergyPrices(this.homeId!, PRICE_RESOLUTION).then(responseHandler);
    } else {
      return Promise.reject('Can only query for prices today, or tomorrow. Was: ' + forDate);
    }
  }

  private persistPrices(forDate: Date, newPrices: IPrice[]): Promise<IPrice[]> {
    const key = formatDate(forDate);
    const file = this.priceFile(key);
    // Keep the prices in memory even if they can't be written to disk
    this.cache.set(key, newPrices);
    return fs.promises.writeFile(file, JSON.stringify(newPrices))
      .then(() => this.platform.log.info('Stored price information for', key))
      .catch(err => this.platform.log.error('Failed to persist prices to disk', err))
      .then(() => this.removeOldPrices())
      .then(() => newPrices);
  }

  private priceFile(key: string): string {
    // Named "prices-<date>.json" since 15-minute prices, so hourly files from older versions are never read
    return `${this.path}/prices-${key}.json`;
  }

  /**
   * Only today's & tomorrow's prices are ever used, drop everything older (on disk & in memory).
   */
  private removeOldPrices(): Promise<void> {
    const today = formatDate(new Date());
    const isOld = (key: string) => key < today;
    for (const key of this.cache.keys()) {
      if (isOld(key)) {
        this.cache.delete(key);
      }
    }
    return fs.promises.readdir(this.path)
      .then(files => Promise.all(files
        .filter(file => {
          const match = PRICE_FILE.exec(file);
          // Files without the "prices-" prefix are hourly prices from older versions of this plugin
          return match && (!match[1] || isOld(match[2]));
        })
        .map(file => fs.promises.unlink(`${this.path}/${file}`)
          .then(() => this.platform.log.debug('Removed old price file', file)))))
      .then(() => undefined)
      .catch(err => this.platform.log.warn('Failed to remove old price files', err));
  }

  private assertValidState(): Promise<unknown> {
    if (this.invalidConfig) {
      return Promise.reject('Invalid Tibber configuration. Check logs.');
    }
    if (!this.initiated) {
      return Promise.reject('Tibber client not initialised yet');
    }

    return Promise.resolve();
  }
}

export interface PricePoint {
  startsAt: Date;
  /** In the smallest currency unit (öre, cents etc) */
  price: number;
  /** Tibber's price level (VERY_CHEAP, CHEAP, NORMAL, EXPENSIVE or VERY_EXPENSIVE), relative to the recent average */
  level?: string;
}

/**
 * Finds the price for the interval (15 minutes, or an hour) that `now` falls within.
 */
function findCurrentPrice(prices: IPrice[], now: Date): IPrice {
  const starts = prices.map(price => (price.startsAt ? new Date(price.startsAt).getTime() : NaN));
  for (let i = starts.length - 1; i >= 0; i--) {
    if (starts[i] > now.getTime()) {
      continue;
    }
    // Each interval lasts until the next one starts. The last one lasts as long as the one before it.
    const length = i + 1 < starts.length ? starts[i + 1] - starts[i] : starts[i] - starts[i - 1];
    if (now.getTime() < starts[i] + (length || 15 * 60 * 1000)) {
      return prices[i];
    }
    break;
  }
  throw new Error('No price found for ' + now.toISOString());
}

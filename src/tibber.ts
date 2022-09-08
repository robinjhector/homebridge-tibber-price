import {TibberQuery} from 'tibber-api';
import {Config, TibberPricePlatform} from './platform';
import {IPrice} from 'tibber-api/lib/src/models/IPrice';

export class CachedTibberClient {

  private readonly tibber: TibberQuery;

  constructor(
    private readonly platform: TibberPricePlatform,
    private readonly config: Config,
  ) {
    this.tibber = new TibberQuery({
      active: true,
      apiEndpoint: {
        queryUrl: 'https://api.tibber.com/v1-beta/gql',
        feedUrl: 'wss://api.tibber.com/v1-beta/gql/subscriptions',
        apiKey: config.accessToken,
      },
    });

    this.tibber.getHomes().then(allHomes => {
      if (!Array.isArray(allHomes) || allHomes.length < 1) {
        throw new Error('No homes returned from Tibber API. Is the Access Token correct?');
      }
      this.platform.log.info('Received home response', allHomes);
      if (!config.homeId) {
        if (allHomes && allHomes.length > 0) {
          this.config.homeId = allHomes[0].id;
          this.platform.log.info('Using Tibber HomeId: ' + this.config.homeId);
        }
      } else {
        if (!allHomes.find(home => home.id === config.homeId)) {
          throw new Error('Unable to find specified home via ID: ' + config.homeId);
        }
        this.platform.log.info('Using Tibber HomeId: ' + this.config.homeId);
      }
    });
  }

  getTodayPrice(): Promise<IPrice[]> {
    return this.tibber.getTodaysEnergyPrices(this.config.homeId!);
  }
}

// interface Storage {
//
// }


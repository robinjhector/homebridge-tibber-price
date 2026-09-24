import type { API } from 'homebridge' with {'resolution-mode': 'import'};

import { PLATFORM_NAME } from './settings';
import { TibberPricePlatform } from './platform';

/**
 * This method registers the platform with Homebridge
 */
export = (api: API) => {
  api.registerPlatform(PLATFORM_NAME, TibberPricePlatform);
};

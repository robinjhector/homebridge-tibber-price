import {TibberPricePlatform} from './platform';
import fs from 'fs';
import {dateHrEq, padTo2Digits} from './utils';
import axios from 'axios';
import {CachedTibberClient} from './tibber';

export class TibberGraphing {

  private readonly path: string;
  private readonly tibber: CachedTibberClient;
  private readonly constants = {
    labels: [...Array(25).keys()].map(i => padTo2Digits(i)),
  };

  private lastRender: Date;

  constructor(
    private readonly platform: TibberPricePlatform,
  ) {
    this.path = platform.api.user.storagePath() + '/tibber-price/price-chart.png';
    this.lastRender = new Date(2022, 1, 1);
    this.tibber = platform.tibber!;

    // Tibber Client will probably not be initialised, so wait 5s before drawing the first chart
    setTimeout(() => this.graphIt(), 5000);
    this.platform.backgroundTasks.push(() => this.graphIt());

    this.platform.log.info('Will produce a chart PNG, stored at:', this.path);
  }

  private async graphIt() {
    const now = new Date();
    const nowHr = padTo2Digits(now.getHours());
    if (dateHrEq(now, this.lastRender)) {
      // Already graphed this date and hour, skip.
      return;
    }

    if (!this.tibber.initiated) {
      this.platform.log.debug('Tibber client not yet initialised. Will try again later');
      return;
    }
    if (this.tibber.errorState) {
      this.platform.log.error('Cannot graph prices, Tibber client in an error state. Check the logs for errors');
      return;
    }

    const dataSets = await Promise.all([
      this.tibber.getTodaysPrices(),
      this.tibber.getTomorrowsPrices().catch(() => Promise.resolve()),
    ]).then(promises => {
      const dataSets: object[] = [];
      const [today, tomorrow] = promises;
      dataSets.push({
        type: 'line',
        label: 'Today',
        data: today,
        fill: false,
        spanGaps: false,
        lineTension: 0.2,
        pointRadius: 1,
        pointStyle: 'circle',
        borderColor: '<GRADIENT_FOR_TODAY_LINE>',
        borderWidth: 3,
      });

      if (tomorrow) {
        dataSets.push({
          type: 'line',
          label: 'Tomorrow',
          data: tomorrow,
          fill: false,
          spanGaps: false,
          lineTension: 0.2,
          pointRadius: 1,
          pointStyle: 'circle',
          borderColor: '<GRADIENT_FOR_TOMORROW_LINE>',
          borderWidth: 1,
        });
      }

      return dataSets;
    }).catch(err => {
      this.platform.log.error('Cannot graph prices:', err);
    });

    if (!dataSets) {
      return;
    }

    const chartConf = {
      type: 'line',
      data: {
        labels: this.constants.labels,
        datasets: dataSets,
      },
      options: {
        scales: {
          xAxes: [{
            gridLines: {
              color: 'rgba(0, 0, 0, 0.03)',
            },
          }],
          yAxes: [{
            gridLines: {
              color: 'rgba(0, 0, 0, 0.03)',
            },
          }],
        },
        annotation: {
          annotations: [{
            type: 'line',
            mode: 'vertical',
            scaleID: 'x-axis-0',
            value: nowHr,
            borderColor: 'rgba(126, 126, 126, 0.5)',
            borderWidth: 1,
            label: {
              enabled: true,
              backgroundColor: 'rgba(0, 0, 0, 0.4)',
              content: 'Now: ' + Math.round((dataSets[0] as DataSet).data[now.getHours()]),
            },
          }],
        },
      },
    };

    const chartDataStr = JSON.stringify(chartConf)
      .replace(
        '"<GRADIENT_FOR_TODAY_LINE>"',
        'getGradientFillHelper("vertical", ["#e73827", "#8E0E00", "#1F1C18"])',
      )
      .replace(
        '"<GRADIENT_FOR_TOMORROW_LINE>"',
        'getGradientFillHelper("vertical", ["rgba(244, 121, 31, 0.5)", "rgba(101, 153, 153, 0.5)"])',
      );

    this.platform.log.debug('Generating chart, request: ', chartDataStr);
    const chartDataB64 = Buffer.from(chartDataStr).toString('base64');
    const request = {
      backgroundColor: 'white',
      width: 1280,
      height: 720,
      format: 'png',
      encoding: 'base64',
      chart: chartDataB64,
    };

    const response = await axios.post(
      'https://quickchart.io/chart',
      request,
      {headers: {'Content-Type': 'application/json'}, responseType: 'stream'},
    );

    response.data.pipe(fs.createWriteStream(this.path));
    this.platform.log.debug('Wrote chart to file');
    this.lastRender = new Date();
  }

}

interface DataSet {
  data: number[];
}

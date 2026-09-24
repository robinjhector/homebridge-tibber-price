import {TibberPricePlatform} from './platform';
import fs from 'fs';
import {dateHrEq} from './utils';
import {CachedTibberClient, PricePoint} from './tibber';

const HOUR_MS = 60 * 60 * 1000;

export class TibberGraphing {

  private readonly path: string;
  private readonly tibber: CachedTibberClient;

  // QuickChart's free tier allows 1,000 charts a month, so render at most once an hour (+ once when tomorrow's prices arrive)
  private lastAttempt?: Date;
  private lastAttemptHadTomorrow = false;

  constructor(
    private readonly platform: TibberPricePlatform,
  ) {
    this.path = platform.api.user.storagePath() + '/tibber-price/price-chart.png';
    this.tibber = platform.tibber!;

    this.platform.backgroundTasks.push(() => this.graphItSafely());

    this.platform.log.info('Will produce a chart PNG, stored at:', this.path);
  }

  private graphItSafely(): Promise<void> {
    return this.graphIt().catch(err => {
      this.platform.log.error('Failed to generate price chart:', err?.message ?? err);
    });
  }

  private async graphIt() {
    if (!this.tibber.initiated) {
      this.platform.log.debug('Tibber client not yet initialised. Will try again later');
      return;
    }
    if (this.tibber.invalidConfig) {
      this.platform.log.error('Cannot graph prices, Invalid Tibber configuration. Check the logs for errors');
      return;
    }

    const now = new Date();
    const today = await this.tibber.getTodaysPrices();
    // Tomorrow's prices are published in the afternoon, until then there's only today's line
    const tomorrow = await this.tibber.getTomorrowsPrices().catch(() => undefined);

    const renderedThisHour = this.lastAttempt && dateHrEq(now, this.lastAttempt);
    const tomorrowJustArrived = !!tomorrow && !this.lastAttemptHadTomorrow;
    if (renderedThisHour && !tomorrowJustArrived) {
      return;
    }
    // Recorded before rendering, so a failing render isn't retried until the next hour
    this.lastAttempt = now;
    this.lastAttemptHadTomorrow = !!tomorrow;

    const png = await renderChart(buildChartConfig(now, today, tomorrow));

    // Write to a temp file first, so consumers (e.g. camera-ffmpeg) never read a half written image
    const tmpPath = this.path + '.tmp';
    await fs.promises.writeFile(tmpPath, png);
    await fs.promises.rename(tmpPath, this.path);
    this.platform.log.debug('Wrote chart to file');
  }

}

/**
 * Builds a Chart.js v2 config (QuickChart's default version), as a JS string since it calls QuickChart's gradient helper.
 */
export function buildChartConfig(now: Date, today: PricePoint[], tomorrow?: PricePoint[]): string {
  const datasets: object[] = [{
    label: 'Today',
    data: toSteps(today),
    fill: false,
    steppedLine: 'after',
    pointRadius: 0,
    borderColor: '<GRADIENT_FOR_TODAY_LINE>',
    borderWidth: 3,
  }];
  if (tomorrow && tomorrow.length > 0) {
    datasets.push({
      label: 'Tomorrow',
      data: toSteps(tomorrow),
      fill: false,
      steppedLine: 'after',
      pointRadius: 0,
      borderColor: '<GRADIENT_FOR_TOMORROW_LINE>',
      borderWidth: 1.5,
    });
  }

  const current = [...today].reverse().find(point => point.startsAt <= now);
  const chartConf = {
    type: 'line',
    data: {datasets},
    options: {
      scales: {
        xAxes: [{
          type: 'linear',
          ticks: {min: 0, max: 24, stepSize: 1},
          gridLines: {color: 'rgba(0, 0, 0, 0.03)'},
        }],
        yAxes: [{
          gridLines: {color: 'rgba(0, 0, 0, 0.03)'},
        }],
      },
      annotation: {
        annotations: [{
          type: 'line',
          mode: 'vertical',
          scaleID: 'x-axis-0',
          value: hoursSinceMidnight(now),
          borderColor: 'rgba(126, 126, 126, 0.5)',
          borderWidth: 1,
          label: {
            enabled: current !== undefined,
            backgroundColor: 'rgba(0, 0, 0, 0.4)',
            content: 'Now: ' + (current ? Math.round(current.price) : ''),
          },
        }],
      },
    },
  };

  return JSON.stringify(chartConf)
    .replace(
      '"<GRADIENT_FOR_TODAY_LINE>"',
      'getGradientFillHelper("vertical", ["#e73827", "#8E0E00", "#1F1C18"])',
    )
    .replace(
      '"<GRADIENT_FOR_TOMORROW_LINE>"',
      'getGradientFillHelper("vertical", ["rgba(244, 121, 31, 0.5)", "rgba(101, 153, 153, 0.5)"])',
    );
}

async function renderChart(chart: string): Promise<Buffer> {
  const response = await fetch('https://quickchart.io/chart', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      backgroundColor: 'white',
      width: 1280,
      height: 720,
      format: 'png',
      encoding: 'base64',
      chart: Buffer.from(chart).toString('base64'),
    }),
    signal: AbortSignal.timeout(30 * 1000),
  });
  if (!response.ok) {
    throw new Error(`QuickChart responded with ${response.status} ${response.statusText}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

/**
 * Each price holds until the next one starts, so it's drawn as a step. The x-axis is hours since midnight (0 - 24).
 */
function toSteps(points: PricePoint[]): {x: number; y: number}[] {
  if (points.length === 0) {
    return [];
  }
  const midnight = startOfDay(points[0].startsAt);
  const steps = points.map(point => ({x: round2((point.startsAt.getTime() - midnight) / HOUR_MS), y: round2(point.price)}));
  // Extend the last price to the end of its interval, otherwise its step isn't drawn
  const last = steps[steps.length - 1];
  const interval = steps.length > 1 ? last.x - steps[steps.length - 2].x : 1;
  steps.push({x: round2(last.x + interval), y: last.y});
  return steps;
}

function hoursSinceMidnight(date: Date): number {
  return round2((date.getTime() - startOfDay(date)) / HOUR_MS);
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

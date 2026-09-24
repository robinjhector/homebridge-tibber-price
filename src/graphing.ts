import {TibberPricePlatform} from './platform';
import fs from 'fs';
import {clamp, dateHrEq, padTo2Digits} from './utils';
import {CachedTibberClient, PricePoint} from './tibber';

const HOUR_MS = 60 * 60 * 1000;
// Today's line is coloured by price, in bands from the day's lowest price (first colour) to its highest (last colour)
const PRICE_BANDS = ['#2e9e47', '#8db42c', '#f0a202', '#f07a1a', '#e73827', '#8E0E00'];

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
 * Builds a Chart.js v2 config (QuickChart's default version). It's a JS string rather than JSON, since it calls
 * QuickChart's gradient helper and contains a few callbacks.
 */
export function buildChartConfig(now: Date, today: PricePoint[], tomorrow?: PricePoint[]): string {
  const hasTomorrow = !!tomorrow && tomorrow.length > 0;
  const current = [...today].reverse().find(point => point.startsAt <= now);
  const lowest = today.reduce((min, point) => (point.price < min.price ? point : min), today[0]);
  const highest = today.reduce((max, point) => (point.price > max.price ? point : max), today[0]);
  const x = (point: PricePoint) => hoursSinceMidnight(point.startsAt);

  // Today's line is drawn as one dataset per price band, each in its own colour.
  // (QuickChart doesn't let plugins draw, so a real gradient along the line isn't possible there.)
  const datasets: object[] = priceBands(toSteps(today), lowest.price, highest.price).map((data, band) => ({
    label: '',
    data,
    steppedLine: 'after',
    spanGaps: false,
    pointRadius: 0,
    borderWidth: 3,
    borderColor: PRICE_BANDS[band],
    fill: false,
  }));
  // Only there for the legend
  datasets.push({
    label: 'Today',
    data: [],
    pointStyle: 'line',
    borderWidth: 3,
    borderColor: PRICE_BANDS[PRICE_BANDS.length - 2],
    fill: false,
  });
  if (hasTomorrow) {
    datasets.push({
      label: 'Tomorrow',
      data: toSteps(tomorrow!),
      steppedLine: 'after',
      pointRadius: 0,
      pointStyle: 'line',
      borderWidth: 2,
      borderDash: [8, 5],
      borderColor: 'rgba(110, 116, 125, 0.85)',
      fill: false,
    });
  }
  // A faint wash under today's line (drawn below everything else, as the last dataset)
  const wash = {
    label: '',
    data: toSteps(today),
    steppedLine: 'after',
    pointRadius: 0,
    borderWidth: 0,
    backgroundColor: 'rgba(231, 56, 39, 0.06)',
    fill: 'origin',
  };
  // Markers on today's line: the current price, and the day's lowest & highest price. Hidden from the legend.
  datasets.push({
    label: '',
    data: [
      ...(current ? [{x: hoursSinceMidnight(now), y: round2(current.price)}] : []),
      {x: x(lowest), y: round2(lowest.price)},
      {x: x(highest), y: round2(highest.price)},
    ],
    showLine: false,
    fill: false,
    pointRadius: 7,
    pointBorderWidth: 3,
    pointBorderColor: 'white',
    pointBackgroundColor: [...(current ? ['#333333'] : []), PRICE_BANDS[0], PRICE_BANDS[PRICE_BANDS.length - 1]],
  }, wash);

  // The label sits on the opposite side of the chart from its marker, and just outside the day's price range
  // (above the highest price, below the lowest), so it never covers today's line
  const referenceLine = (point: PricePoint, text: string, above: boolean) => ({
    type: 'line',
    mode: 'horizontal',
    scaleID: 'y-axis-0',
    value: round2(point.price),
    borderColor: 'rgba(0, 0, 0, 0.12)',
    borderWidth: 1,
    label: {
      enabled: true,
      position: x(point) < 12 ? 'right' : 'left',
      yAdjust: above ? -18 : 18,
      backgroundColor: 'rgba(255, 255, 255, 0.85)',
      fontColor: '#444444',
      fontSize: 18,
      fontStyle: 'normal',
      content: `${text} ${Math.round(point.price)} at ${formatTime(point.startsAt)}`,
    },
  });

  const chartConf = {
    type: 'line',
    data: {datasets},
    options: {
      layout: {padding: {left: 8, right: 24, top: 8, bottom: 8}},
      title: {
        display: true,
        text: 'Electricity price · ' + now.toLocaleDateString('en-GB', {weekday: 'long', day: 'numeric', month: 'long'}),
        fontSize: 28,
        fontColor: '#222222',
        padding: 16,
      },
      legend: {
        position: 'top',
        align: 'end',
        labels: {fontSize: 18, fontColor: '#444444', usePointStyle: true, filter: '<LEGEND_FILTER>'},
      },
      scales: {
        xAxes: [{
          type: 'linear',
          ticks: {min: 0, max: 24, stepSize: 1, fontSize: 18, fontColor: '#666666', callback: '<HOUR_TICK>'},
          gridLines: {drawOnChartArea: false, color: 'rgba(0, 0, 0, 0.15)'},
        }],
        yAxes: [{
          ticks: {fontSize: 18, fontColor: '#666666', maxTicksLimit: 6},
          gridLines: {color: 'rgba(0, 0, 0, 0.06)', zeroLineColor: 'rgba(0, 0, 0, 0.3)', drawBorder: false},
        }],
      },
      annotation: {
        drawTime: 'afterDatasetsDraw',
        annotations: [
          referenceLine(highest, 'Highest', true),
          referenceLine(lowest, 'Lowest', false),
          {
            type: 'line',
            mode: 'vertical',
            scaleID: 'x-axis-0',
            value: hoursSinceMidnight(now),
            borderColor: 'rgba(51, 51, 51, 0.6)',
            borderWidth: 2,
            label: {
              enabled: current !== undefined,
              position: 'top',
              backgroundColor: 'rgba(51, 51, 51, 0.85)',
              fontSize: 22,
              fontStyle: 'bold',
              yAdjust: 8,
              content: 'Now ' + (current ? Math.round(current.price) : ''),
            },
          },
        ],
      },
    },
  };

  return JSON.stringify(chartConf)
    .replace('"<LEGEND_FILTER>"', 'function (item) { return item.text !== ""; }')
    .replace('"<HOUR_TICK>"', 'function (value) { return value < 10 ? "0" + value : String(value); }');
}

/**
 * Splits the steps into one series per price band. Each step (and the jump to the next price) gets the colour of the
 * band its price falls in. Points of other bands are left out, with a gap (null) after each run.
 */
function priceBands(steps: {x: number; y: number}[], lowest: number, highest: number): {x: number; y: number | null}[][] {
  const bandOf = (price: number) => (highest > lowest
    ? clamp(Math.floor(((price - lowest) / (highest - lowest)) * PRICE_BANDS.length), 0, PRICE_BANDS.length - 1)
    : Math.floor(PRICE_BANDS.length / 2));
  const bands: {x: number; y: number | null}[][] = PRICE_BANDS.map(() => []);
  for (let i = 0; i < steps.length - 1; i++) {
    const band = bands[bandOf(steps[i].y)];
    const previous = band[band.length - 1];
    if (!previous || previous.x !== steps[i].x || previous.y === null) {
      band.push(steps[i]);
    }
    band.push(steps[i + 1]);
    // End the run unless the next step is in the same band
    if (i + 1 < steps.length - 1 && bandOf(steps[i + 1].y) !== bandOf(steps[i].y)) {
      band.push({x: steps[i + 1].x, y: null});
    }
  }
  return bands;
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

function formatTime(date: Date): string {
  return `${padTo2Digits(date.getHours())}:${padTo2Digits(date.getMinutes())}`;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

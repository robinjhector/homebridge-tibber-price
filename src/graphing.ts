import {TibberPricePlatform} from './platform';
import fs from 'fs';
import {dateHrEq, padTo2Digits} from './utils';
import {CachedTibberClient, PricePoint} from './tibber';

const HOUR_MS = 60 * 60 * 1000;
// Today's line is coloured by price: from the day's highest price (first colour) to its lowest (last colour)
const PRICE_COLORS = ['#8E0E00', '#e73827', '#f0a202', '#2e9e47'];
const PRICE_FILL_COLORS = ['rgba(142, 14, 0, 0.16)', 'rgba(231, 56, 39, 0.12)', 'rgba(240, 162, 2, 0.08)', 'rgba(46, 158, 71, 0.04)'];

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

  const datasets: object[] = [{
    label: 'Today',
    data: toSteps(today),
    steppedLine: 'after',
    pointRadius: 0,
    pointStyle: 'line',
    borderWidth: 3,
    // Line & fill colours are set by the price gradient plugin below. The fill is a faint wash in the same colours.
    borderColor: PRICE_COLORS[0],
    fill: 'origin',
  }];
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
    pointBackgroundColor: [...(current ? ['#333333'] : []), PRICE_COLORS[PRICE_COLORS.length - 1], PRICE_COLORS[0]],
  });

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
    plugins: ['<PRICE_GRADIENT_PLUGIN>'],
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
    .replace('"<PRICE_GRADIENT_PLUGIN>"', priceGradientPlugin(lowest.price, highest.price))
    .replace('"<LEGEND_FILTER>"', 'function (item) { return item.text !== ""; }')
    .replace('"<HOUR_TICK>"', 'function (value) { return value < 10 ? "0" + value : String(value); }');
}

/**
 * An inline Chart.js plugin that colours today's line (dataset 0) by price, spanning a gradient from the pixel of the
 * day's highest price to that of its lowest, so the colours follow the prices exactly.
 * QuickChart doesn't expose the scale's methods (e.g. getPixelForValue) to plugins, so the pixels are computed from the
 * scale's plain properties. Any failure leaves the line in its default colour rather than failing the whole chart.
 */
function priceGradientPlugin(lowest: number, highest: number): string {
  return `{
    afterLayout: function (chart) {
      try {
        var scale = chart.scales['y-axis-0'];
        var area = chart.chartArea;
        var top = scale && isFinite(scale.top) ? scale.top : area.top;
        var bottom = scale && isFinite(scale.bottom) ? scale.bottom : area.bottom;
        var min = scale.min, max = scale.max;
        if (!isFinite(top) || !isFinite(bottom) || !isFinite(min) || !isFinite(max) || max <= min) {
          return;
        }
        var pixel = function (value) { return bottom - ((value - min) / (max - min)) * (bottom - top); };
        var from = pixel(${round2(highest)});
        var to = Math.max(pixel(${round2(lowest)}), from + 1);
        var gradient = function (colors) {
          var g = chart.ctx.createLinearGradient(0, from, 0, to);
          colors.forEach(function (color, i) { g.addColorStop(i / (colors.length - 1), color); });
          return g;
        };
        chart.data.datasets[0].borderColor = gradient(${JSON.stringify(PRICE_COLORS)});
        chart.data.datasets[0].backgroundColor = gradient(${JSON.stringify(PRICE_FILL_COLORS)});
      } catch (e) {
        // Keep the default colours
      }
    }
  }`;
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

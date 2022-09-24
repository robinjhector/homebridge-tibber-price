import {IPrice} from 'tibber-api/lib/src/models/IPrice';

export function padTo2Digits(num: number): string {
  return num.toString().padStart(2, '0');
}

export function formatDate(date: Date): string {
  return (
    [
      date.getFullYear(),
      padTo2Digits(date.getMonth() + 1),
      padTo2Digits(date.getDate()),
    ].join('-')
  );
}

export function dateEq(d1: Date, d2: Date): boolean {
  return d1.getFullYear() === d2.getFullYear() &&
    d1.getMonth() === d2.getMonth() &&
    d1.getDate() === d2.getDate();
}

export function dateHrEq(d1: Date, d2: Date): boolean {
  return dateEq(d1, d2) && d1.getHours() === d2.getHours();
}

export function fractionated(price: IPrice, incTax: boolean): number {
  return (incTax ? price.total : price.total - price.tax) * 100;
}

/* Periodos hidráulicos compartidos por Estadísticos 1. */

function isLeapYear(year) {
  return year % 400 === 0 || (year % 4 === 0 && year % 100 !== 0);
}

export function daysInYear(year) {
  return isLeapYear(year) ? 366 : 365;
}

export function daysThroughMonth(year, month) {
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new RangeError("month debe estar entre 1 y 12");
  }

  return Math.round(
    (Date.UTC(year, month, 1) - Date.UTC(year, 0, 1)) / 86400000,
  );
}

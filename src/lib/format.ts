import { format, formatDistanceToNowStrict, isToday, isYesterday } from "date-fns";

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const usdPrecise = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 3,
  maximumFractionDigits: 3,
});
const integer = new Intl.NumberFormat("en-US");

export function formatUsd(amount: number): string {
  return usd.format(amount);
}

/** For unit costs that are fractions of a cent, e.g. $0.031. */
export function formatUsdPrecise(amount: number): string {
  return usdPrecise.format(amount);
}

export function formatNumber(value: number): string {
  return integer.format(value);
}

export function formatCredits(value: number, options: { signed?: boolean } = {}): string {
  const sign = options.signed && value > 0 ? "+" : "";
  const noun = Math.abs(value) === 1 ? "credit" : "credits";
  return `${sign}${integer.format(value)} ${noun}`;
}

export function formatPercent(fraction: number, digits = 0): string {
  return `${(fraction * 100).toFixed(digits)}%`;
}

export function formatDate(timestamp: number): string {
  return format(timestamp, "d MMM yyyy");
}

export function formatDateTime(timestamp: number): string {
  return format(timestamp, "d MMM yyyy, HH:mm");
}

export function formatRelative(timestamp: number): string {
  if (isToday(timestamp)) return `Today, ${format(timestamp, "HH:mm")}`;
  if (isYesterday(timestamp)) return `Yesterday, ${format(timestamp, "HH:mm")}`;
  return `${formatDistanceToNowStrict(timestamp, { addSuffix: true })}`;
}

export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

/** Remaining-time copy for a running job or render, e.g. "about 40s left". Callers hide it when there is no estimate. */
export function formatEta(ms: number): string {
  return `about ${formatDuration(Math.max(1000, ms))} left`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${integer.format(count)} ${count === 1 ? singular : plural}`;
}

export function titleCase(value: string): string {
  return value.replace(/(^|[\s-])([a-z])/g, (match) => match.toUpperCase()).replace(/-/g, " ");
}

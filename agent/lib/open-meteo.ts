/**
 * Step 7 Phase C4.1 — one trusted Open-Meteo client.
 *
 * Both the model-facing `get_weather` tool (`agent/tools/get_weather.ts`) and the deterministic
 * stylist port (`agent/lib/stylist-weather.ts`) read the same free, keyless Open-Meteo endpoints.
 * This module owns the geocode/forecast URLs, the response shapes, the fetch + error text and the
 * date/number helpers so there is exactly one implementation of the network contract; each caller
 * shapes the response for its own consumer.
 *
 * It performs I/O, so it is imported only by adapters (a tool executor and a port), never by the
 * pure C1/C2/C3 layers or their tests.
 */

export const GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search";
export const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";

export type GeocodeLocation = {
  name: string;
  latitude: number;
  longitude: number;
  country?: string;
  admin1?: string;
};

export type GeocodeResponse = { results?: GeocodeLocation[] };

export type ForecastResponse = {
  daily?: {
    time?: string[];
    temperature_2m_max?: (number | null)[];
    temperature_2m_min?: (number | null)[];
    precipitation_probability_max?: (number | null)[];
  };
  daily_units?: Record<string, string>;
  timezone?: string;
};

/** The local day (UTC) `offsetDays` from now, as `YYYY-MM-DD`. */
export function isoDate(offsetDays = 0): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

/** `date` (a `YYYY-MM-DD`) advanced by `days`, as `YYYY-MM-DD`. */
export function addDays(date: string, days: number): string {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

/** A numeric reading, or `undefined` for the `null`/missing values Open-Meteo returns. */
export function numberOrUndefined(value: number | null | undefined): number | undefined {
  return typeof value === "number" ? value : undefined;
}

/** Resolve a place name to its coordinates, or `null` when Open-Meteo knows no such place. */
export async function geocode(place: string): Promise<GeocodeLocation | null> {
  const response = await fetchJson<GeocodeResponse>(
    `${GEOCODE_URL}?name=${encodeURIComponent(place)}&count=1&language=en&format=json`,
    "Place",
  );
  return response.results?.[0] ?? null;
}

/** Fetch the daily forecast for a coordinate range. Throws when the lookup fails. */
export async function fetchDailyForecast(
  latitude: number,
  longitude: number,
  startDate: string,
  endDate: string,
): Promise<ForecastResponse> {
  return fetchJson<ForecastResponse>(
    `${FORECAST_URL}?latitude=${latitude}&longitude=${longitude}` +
      `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
      `&timezone=auto&start_date=${startDate}&end_date=${endDate}`,
    "Forecast",
  );
}

async function fetchJson<T>(url: string, what: string): Promise<T> {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`${what} lookup failed (${response.status}).`);
  return (await response.json()) as T;
}
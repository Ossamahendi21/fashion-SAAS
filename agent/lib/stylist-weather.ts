import type { WeatherFacts } from "./stylist-rank";
import { fetchDailyForecast, geocode, numberOrUndefined } from "./open-meteo";

/**
 * Step 7 Phase C4.1 — the deterministic weather port.
 *
 * The network contract lives once in `agent/lib/open-meteo.ts` (shared with the model-facing
 * `get_weather` tool). This module is the thin, failure-tolerant projection the orchestrator calls:
 * a lookup that cannot resolve or reach Open-Meteo yields `{}`, which C3 reads as "no forecast",
 * never as an error a turn must surface.
 */
export async function fetchWeatherFacts(place: string, date: string): Promise<WeatherFacts> {
  try {
    const location = await geocode(place);
    if (!location) return {};

    const forecast = await fetchDailyForecast(location.latitude, location.longitude, date, date);
    const daily = forecast.daily;
    const chance = numberOrUndefined(daily?.precipitation_probability_max?.[0]);
    return {
      minC: numberOrUndefined(daily?.temperature_2m_min?.[0]),
      maxC: numberOrUndefined(daily?.temperature_2m_max?.[0]),
      precipProb: chance === undefined ? undefined : chance / 100,
    };
  } catch {
    return {};
  }
}
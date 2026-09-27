import { defineTool } from "eve/tools";
import { z } from "zod";

const GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";

type GeocodeResponse = {
  results?: { name: string; latitude: number; longitude: number; country?: string; admin1?: string }[];
};

type ForecastResponse = {
  daily?: {
    time?: string[];
    temperature_2m_max?: (number | null)[];
    temperature_2m_min?: (number | null)[];
    precipitation_probability_max?: (number | null)[];
  };
  daily_units?: Record<string, string>;
  timezone?: string;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isoDate(offsetDays = 0): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

async function fetchJson<T>(url: string, what: string): Promise<T> {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`${what} lookup failed (${response.status}).`);
  return (await response.json()) as T;
}

export default defineTool({
  description:
    "Daily forecast (max/min temperature in °C and chance of rain) for a place and date range, via " +
    "Open-Meteo. Use it whenever layering or rain would change the answer. Ask the user for the " +
    "place first — never guess a city. Open-Meteo forecasts roughly 16 days ahead.",
  inputSchema: z.object({
    place: z.string().min(1).describe("City or town name, e.g. 'Brighton' or 'Lisbon, Portugal'."),
    date: z.string().regex(ISO_DATE).optional().describe("First day as YYYY-MM-DD. Defaults to today."),
    days: z.number().int().min(1).max(7).optional().describe("How many days from `date`. Defaults to 1."),
  }),
  label: { start: ({ place }) => `Checking the weather in ${place}` },
  async execute({ place, date, days }) {
    const geocode = await fetchJson<GeocodeResponse>(
      `${GEOCODE_URL}?name=${encodeURIComponent(place)}&count=1&language=en&format=json`,
      "Place",
    );
    const location = geocode.results?.[0];
    if (!location) {
      return {
        found: false as const,
        place,
        note: `No place called "${place}" was found. Ask the user to confirm it.`,
      };
    }

    const startDate = date ?? isoDate();
    const endDate = addDays(startDate, Math.max(1, days ?? 1) - 1);
    const forecast = await fetchJson<ForecastResponse>(
      `${FORECAST_URL}?latitude=${location.latitude}&longitude=${location.longitude}` +
        `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
        `&timezone=auto&start_date=${startDate}&end_date=${endDate}`,
      "Forecast",
    );

    const daily = forecast.daily;
    const dates = daily?.time ?? [];
    const outlook = dates.map((day, index) => ({
      date: day,
      maxC: daily?.temperature_2m_max?.[index] ?? null,
      minC: daily?.temperature_2m_min?.[index] ?? null,
      rainChancePercent: daily?.precipitation_probability_max?.[index] ?? null,
    }));

    return {
      found: true as const,
      place: [location.name, location.admin1, location.country].filter(Boolean).join(", "),
      timezone: forecast.timezone,
      units: { temperature: "°C", rainChance: "%" },
      outlook,
      note:
        outlook.length === 0
          ? "Open-Meteo returned no days for that range — it is probably too far ahead to forecast."
          : undefined,
    };
  },
});

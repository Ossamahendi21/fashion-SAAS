import { defineTool } from "eve/tools";
import { z } from "zod";
import { addDays, fetchDailyForecast, geocode, isoDate } from "../lib/open-meteo";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

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
    const location = await geocode(place);
    if (!location) {
      return {
        found: false as const,
        place,
        note: `No place called "${place}" was found. Ask the user to confirm it.`,
      };
    }

    const startDate = date ?? isoDate();
    const endDate = addDays(startDate, Math.max(1, days ?? 1) - 1);
    const forecast = await fetchDailyForecast(location.latitude, location.longitude, startDate, endDate);

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
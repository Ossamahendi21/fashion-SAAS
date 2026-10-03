import sharp from "sharp";

/**
 * Phase B render-benchmark validators. Pure inspection only: no models, no network,
 * no image generation. Uses sharp (already a repo dependency).
 *
 * Result record schema (one per candidate/case):
 * {
 *   candidate, caseId, success, outputPath, width, height, format, opaque,
 *   latencyMs, peakRssMb, externalCostUsd, error
 * }
 * externalCostUsd must ALWAYS be present (explicit 0 is valid, omission is not).
 */

export const TARGET = { width: 1024, height: 1536, format: "png" };
export const ASPECT_W = 2;
export const ASPECT_H = 3;
export const ASPECT_TOLERANCE = 0.01;

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

const CASE_ID_PATTERN = /^[A-Z0-9_]+$/;

export function validateManifest(manifest) {
  const errors = [];
  if (!isRecord(manifest)) return { ok: false, errors: ["manifest must be an object"] };
  if (!Array.isArray(manifest.cases) || manifest.cases.length === 0) {
    return { ok: false, errors: ["manifest.cases must be a non-empty array"] };
  }
  const seen = new Set();
  for (const [index, kase] of manifest.cases.entries()) {
    const where = `cases[${index}]`;
    if (!isRecord(kase)) {
      errors.push(`${where} must be an object`);
      continue;
    }
    if (typeof kase.id !== "string" || !CASE_ID_PATTERN.test(kase.id)) {
      errors.push(`${where}.id must be a non-empty UPPER_SNAKE id`);
    } else if (seen.has(kase.id)) {
      errors.push(`${where}.id duplicates "${kase.id}"`);
    } else {
      seen.add(kase.id);
    }
    if (typeof kase.person !== "string" || kase.person.length === 0) {
      errors.push(`${where}.person must be a fixture path`);
    }
    if (!Array.isArray(kase.garments) || kase.garments.length === 0) {
      errors.push(`${where}.garments must be a non-empty array`);
    } else {
      for (const [gi, garment] of kase.garments.entries()) {
        if (!isRecord(garment) || typeof garment.path !== "string" || garment.path.length === 0) {
          errors.push(`${where}.garments[${gi}].path must be a fixture path`);
        }
        if (!isRecord(garment) || typeof garment.slot !== "string" || garment.slot.length === 0) {
          errors.push(`${where}.garments[${gi}].slot must be a slot name`);
        }
      }
    }
    if (typeof kase.tests !== "string" || kase.tests.length === 0) {
      errors.push(`${where}.tests must describe what the case tests`);
    }
  }
  return { ok: errors.length === 0, errors };
}

const RESULT_NUMBERS = ["width", "height", "latencyMs", "peakRssMb", "externalCostUsd"];

export function validateResult(record) {
  const errors = [];
  if (!isRecord(record)) return { ok: false, errors: ["result must be an object"] };
  if (typeof record.candidate !== "string" || record.candidate.length === 0) {
    errors.push("candidate must be a non-empty string");
  }
  if (typeof record.caseId !== "string" || !CASE_ID_PATTERN.test(record.caseId)) {
    errors.push("caseId must be a non-empty UPPER_SNAKE id");
  }
  if (typeof record.success !== "boolean") errors.push("success must be a boolean");
  if (typeof record.outputPath !== "string" || record.outputPath.length === 0) {
    errors.push("outputPath must be a non-empty string");
  }
  if (typeof record.format !== "string" || record.format.length === 0) {
    errors.push("format must be a non-empty string");
  }
  if (typeof record.opaque !== "boolean") errors.push("opaque must be a boolean");
  for (const field of RESULT_NUMBERS) {
    if (typeof record[field] !== "number" || !Number.isFinite(record[field])) {
      errors.push(`${field} must be a finite number (explicit 0 is valid, omission is not)`);
    }
  }
  if (record.latencyMs !== undefined && record.latencyMs < 0) errors.push("latencyMs must be >= 0");
  if (record.peakRssMb !== undefined && record.peakRssMb < 0) errors.push("peakRssMb must be >= 0");
  if (record.externalCostUsd !== undefined && record.externalCostUsd < 0) {
    errors.push("externalCostUsd must be >= 0");
  }
  if (record.error !== undefined && record.error !== null && typeof record.error !== "string") {
    errors.push("error must be a string or null when present");
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Inspect a produced output file. Returns { ok, errors[], info } where info carries the
 * measured width/height/format/alpha/bytes. `expect` defaults to the 1024x1536 PNG target;
 * aspect is checked independently so a correctly-proportioned non-exact size is reported
 * as normalizable rather than silently accepted.
 */
export async function validateOutput(record, expect = TARGET) {
  const errors = [];
  const schema = validateResult(record);
  if (!schema.ok) return { ok: false, errors: schema.errors, info: null };
  let buffer;
  try {
    buffer = await sharp(record.outputPath).toBuffer();
  } catch {
    return { ok: false, errors: [`outputPath is not a readable image: ${record.outputPath}`], info: null };
  }
  let metadata;
  try {
    metadata = await sharp(buffer).metadata();
  } catch {
    return { ok: false, errors: ["output bytes are not a decodable image"], info: null };
  }
  const info = {
    width: metadata.width ?? 0,
    height: metadata.height ?? 0,
    format: metadata.format ?? "unknown",
    channels: metadata.channels ?? 0,
    hasAlpha: (metadata.channels ?? 0) === 4,
    bytes: buffer.length,
  };
  if (info.format !== expect.format) {
    errors.push(`format is ${info.format}, expected ${expect.format}`);
  }
  const exact = info.width === expect.width && info.height === expect.height;
  const ratio = info.height === 0 ? 0 : info.width / info.height;
  const aspectOk = Math.abs(ratio - ASPECT_W / ASPECT_H) <= ASPECT_TOLERANCE;
  if (!aspectOk) {
    errors.push(`aspect ${info.width}x${info.height} is not 2:3 (tolerance ${ASPECT_TOLERANCE})`);
  }
  if (record.width !== info.width || record.height !== info.height) {
    errors.push(`recorded dimensions ${record.width}x${record.height} do not match measured ${info.width}x${info.height}`);
  }
  if (record.format !== info.format) {
    errors.push(`recorded format "${record.format}" does not match measured "${info.format}"`);
  }
  return { ok: errors.length === 0, errors, info: { ...info, exactDimensions: exact, aspectOk } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [recordPath] = process.argv.slice(2);
  if (!recordPath) {
    console.error("usage: node bench/render/validate.mjs <result-record.json>");
    process.exit(2);
  }
  const { readFile } = await import("node:fs/promises");
  const record = JSON.parse(await readFile(recordPath, "utf8"));
  const checked = await validateOutput(record);
  console.log(JSON.stringify(checked, null, 2));
  process.exit(checked.ok ? 0 : 1);
}

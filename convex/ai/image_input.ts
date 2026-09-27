"use node";

import sharp from "sharp";
import { appError, isAppError } from "../lib/errors";

const MAX_INPUT_PIXELS = 50_000_000;
const MAX_INPUT_EDGE = 2048;
const SUPPORTED_FORMATS = new Set(["jpeg", "png", "webp"]);

/** Decode the actual bytes rather than trusting stored MIME, and send a predictable image to the model. */
export async function normalizeImageInput(blob: Blob, label = "photo"): Promise<Uint8Array<ArrayBuffer>> {
  try {
    if (blob.size === 0) {
      throw appError("INVALID_INPUT", `The ${label} is empty. Replace it with a JPEG, PNG or WebP image.`);
    }

    const input = sharp(Buffer.from(await blob.arrayBuffer()), {
      limitInputPixels: MAX_INPUT_PIXELS,
      failOn: "warning",
    });
    const metadata = await input.metadata();
    if (!SUPPORTED_FORMATS.has(metadata.format)) {
      throw appError(
        "INVALID_INPUT",
        `The ${label} is not a JPEG, PNG or WebP image. Replace it with a supported photo.`,
      );
    }
    if ((metadata.pages ?? 1) > 1 || (metadata.delay?.length ?? 0) > 1) {
      throw appError("INVALID_INPUT", `The ${label} contains multiple frames. Replace it with a single still photo.`);
    }
    if (metadata.width * metadata.height > MAX_INPUT_PIXELS) {
      throw appError("INVALID_INPUT", `The ${label} is too large. Replace it with a photo under 50 megapixels.`);
    }

    // Decode the primary JPEG image, including iPhone MPOs with an auxiliary HDR gain map.
    // Sharp strips metadata/gain maps by default; sRGB converts CMYK/16-bit input to 8-bit RGB(A).
    const output = await input
      .autoOrient()
      .resize({ width: MAX_INPUT_EDGE, height: MAX_INPUT_EDGE, fit: "inside", withoutEnlargement: true })
      .toColourspace("srgb")
      .png({ palette: false })
      .toBuffer();
    return new Uint8Array(output);
  } catch (error) {
    if (isAppError(error)) throw error;
    if (error instanceof Error && error.message.includes("exceeds pixel limit")) {
      throw appError("INVALID_INPUT", `The ${label} is too large. Replace it with a photo under 50 megapixels.`);
    }
    throw appError("INVALID_INPUT", `The ${label} could not be read. Replace it with a valid JPEG, PNG or WebP photo.`);
  }
}

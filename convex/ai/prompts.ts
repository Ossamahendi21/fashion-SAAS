import { LIMITS } from "../shared/credits";
import { CATEGORIES, FORMALITY, SEASONS, type Fit, type Presentation, type Slot } from "../shared/wardrobe";

/**
 * Every prompt the pipeline sends, as pure functions so they can be read, diffed and unit-tested
 * without touching OpenAI. Nothing here reads the clock, the database or the environment.
 */

export type DetectionSpec = {
  instructions: string;
  /** JSON Schema for `text.format: { type: "json_schema", strict: true } `. */
  schema: Record<string, unknown>;
};

export type RenderGarment = { name: string; slot: Slot };

export type RenderPromptInput = {
  /** Garments in layer order, inner to outer — the same order the reference images are sent in. */
  garments: RenderGarment[];
  presentation: Presentation;
  fit: Fit;
  hasOuterwear: boolean;
  /** Core slots the outfit leaves empty, so the model is told what to improvise. */
  missingSlots: Slot[];
};

/** How each slot is described to the image model when listing the reference images. */
const SLOT_PHRASE: Record<Slot, string> = {
  dress: "a dress",
  top: "a top, worn on the upper body",
  bottom: "bottoms, worn on the lower body",
  shoes: "shoes, worn on the feet",
  outerwear: "outerwear, worn open over the top",
  accessories: "an accessory",
};

/** What to improvise when the outfit leaves a core slot empty. */
const SLOT_FALLBACK: Partial<Record<Slot, string>> = {
  top: "The outfit has no top: add a plain neutral t-shirt.",
  bottom: "The outfit has no bottom: add simple neutral dark trousers.",
  shoes: "The outfit has no shoes: add plain white trainers.",
};

const PRESENTATION_PHRASE: Record<Presentation, string> = {
  masculine: "Use masculine clothing styling without changing the person's body.",
  feminine: "Use feminine clothing styling without changing the person's body.",
  neutral: "Use gender-neutral clothing styling without changing the person's body.",
};

/** Instructions + structured-output schema for the gpt-5-mini vision pass over one photo. */
export function detectionInstructions(): DetectionSpec {
  const instructions = [
    "You are cataloguing one photo for a digital wardrobe.",
    "",
    "List every distinct clothing item, pair of shoes, bag, hat or accessory that is visible, whether it is worn, folded, hanging or laid flat. One entry per physical item: a pair of shoes is one item, a pair of earrings is one item, a two-piece suit is two items. Ignore anything that is not wearable — furniture, hangers, plants, packaging, bare skin.",
    "",
    `Return at most ${LIMITS.maxItemsPerPhoto} items, most prominent first. If the photo contains no wearable items, return an empty list.`,
    "",
    "For each item:",
    `- name: a short shoppable name of two to four words, e.g. "cream ribbed knit jumper". Only name a brand if it is clearly legible in the photo.`,
    `- category: exactly one of ${CATEGORIES.join(", ")}.`,
    `- subcategory: the specific garment type in one or two words, e.g. "crewneck jumper", "straight-leg jeans", "low-top trainers".`,
    `- colours.primary: the single dominant colour as a plain English name. colours.secondary: the other clearly visible colours, most prominent first; an empty list when the item is one colour.`,
    `- pattern: "solid" when there is no pattern, otherwise the pattern in one or two words, e.g. "breton stripe", "floral print", "houndstooth".`,
    `- material_guess: your best guess at the main material from the drape and texture, e.g. "cotton", "denim", "leather", "wool blend". Never answer "unknown".`,
    `- season: every season the item is genuinely wearable in, from ${SEASONS.join(", ")}.`,
    `- formality: exactly one of ${FORMALITY.join(", ")}.`,
    `- bbox: the item's bounding box as [x0, y0, x1, y1], each a fraction of the image width or height, with 0,0 at the top-left corner and 1,1 at the bottom-right. Cover the whole item, including parts partly hidden behind something else.`,
    `- description: ONE precise sentence another image model can use to isolate this exact item from the photo. Say what the item is, its colour and pattern, and where it sits in the frame, e.g. "the charcoal wool overcoat worn open on the left of the frame". Describe only this item; mention the others only as landmarks.`,
    "",
    "Be literal: describe what is in the photo, not what you expect to be there. Do not invent brands, logos or details you cannot see.",
  ].join("\n");

  const schema: Record<string, unknown> = {
    type: "object",
    additionalProperties: false,
    required: ["items"],
    properties: {
      items: {
        type: "array",
        description: `Every distinct wearable item in the photo, most prominent first, at most ${LIMITS.maxItemsPerPhoto}.`,
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "name",
            "category",
            "subcategory",
            "colours",
            "pattern",
            "material_guess",
            "season",
            "formality",
            "bbox",
            "description",
          ],
          properties: {
            name: { type: "string", description: "Short shoppable name, two to four words." },
            category: { type: "string", enum: [...CATEGORIES] },
            subcategory: { type: "string", description: "Specific garment type, one or two words." },
            colours: {
              type: "object",
              additionalProperties: false,
              required: ["primary", "secondary"],
              properties: {
                primary: { type: "string", description: "Dominant colour as a plain English name." },
                secondary: {
                  type: "array",
                  description: "Other visible colours, most prominent first. Empty for single-colour items.",
                  items: { type: "string" },
                },
              },
            },
            pattern: {
              type: "string",
              description: '"solid" when unpatterned, otherwise the pattern in one or two words.',
            },
            material_guess: { type: "string", description: "Best guess at the main material." },
            season: { type: "array", items: { type: "string", enum: [...SEASONS] } },
            formality: { type: "string", enum: [...FORMALITY] },
            bbox: {
              type: "array",
              description: "[x0, y0, x1, y1] as fractions of width and height, 0,0 top-left.",
              items: { type: "number" },
            },
            description: {
              type: "string",
              description: "One sentence isolating this item and its position in the frame.",
            },
          },
        },
      },
    },
  };

  return { instructions, schema };
}

/** The gpt-image-2 edit prompt that turns one photographed garment into a catalogue cutout. */
export function extractionPrompt(description: string): string {
  return [
    `Isolate ONLY this item from the photo: ${description.trim()}`,
    "",
    "Render it as a clean e-commerce flat-lay product photo: the item alone, neatly laid out, lightly smoothed, fully visible, centred in frame, soft even studio lighting, transparent background.",
    "",
    "Preserve the item exactly as it appears in the photo — the same colours, print, stitching, cuffs, collar, buttons, hems, lining and proportions. Do not add, remove or restyle anything. Do not add any brand labels, tags or logos that are not visible in the photo. Do not include any part of a person, any other garment, or any background object.",
  ].join("\n");
}

/** The gpt-image-2 edit prompt that dresses the avatar in every garment of one outfit. */
export function renderPrompt(input: RenderPromptInput): string {
  const references = input.garments.map(
    (garment, index) => `Image ${index + 2} is the ${garment.name} — ${SLOT_PHRASE[garment.slot]}.`,
  );
  const fallbacks = input.missingSlots
    .map((slot) => SLOT_FALLBACK[slot])
    .filter((line): line is string => Boolean(line));

  return [
    "Image 1 identifies the person to dress. The following images are clothing references.",
    ...references,
    "",
    `Dress the SAME person in ALL of these items together as one outfit, layered correctly${
      input.hasOuterwear ? " — the jacket open over the top" : ""
    }.`,
    "",
    "Preserve the person's face, hair, skin tone and recognizable identity. If image 1 shows the full body, preserve its anatomical proportions, body silhouette and pose; change only the clothes and accessories.",
    "",
    "If image 1 is a headshot or cropped seated photo, use it for identity only, never its face-to-frame scale. Infer a naturally proportioned adult standing body: the head is roughly one seventh to one eighth of total height, with balanced shoulders, torso and limbs. Pull the camera back for a full-body photo against a plain light grey studio background with soft natural light.",
    "Show the entire person from head to toe with space above the hair and below both shoes. Use natural perspective and a normal focal length: no enlarged head, portrait zoom, wide-angle distortion or cropped head/feet. Keep the result photographic.",
    "Match each garment's reference colour, print, cut and detail exactly. Do not substitute items or invent logos.",
    "",
    ...fallbacks,
    "Keep whatever is worn underneath simple and neutral so the listed items stay the focus.",
    `Use a ${input.fit} garment fit by adjusting fabric drape and ease only, never anatomy or body silhouette. ${PRESENTATION_PHRASE[input.presentation]}`,
  ]
    .filter((line, index, lines) => !(line === "" && lines[index - 1] === ""))
    .join("\n");
}

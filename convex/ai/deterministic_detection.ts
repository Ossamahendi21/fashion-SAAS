import type { Category, Formality, Season } from "../shared/wardrobe";

export type DeterministicDetectedItem = {
  name: string;
  category: Category;
  subcategory: string;
  colours: { primary: string; secondary: string[]; hex: string[] };
  pattern: string;
  material: string;
  season: Season[];
  formality: Formality;
  description: string;
  bbox: number[];
};

type Classification = { category: Category; subcategory: string };

const CLASSIFIERS: Array<{ pattern: RegExp; result: Classification }> = [
  {
    pattern: /\b(overcoat|jacket|coat|blazer|parka|cardigan)\b/i,
    result: { category: "outerwear", subcategory: "jacket" },
  },
  { pattern: /\b(dress|gown)\b/i, result: { category: "dress", subcategory: "dress" } },
  {
    pattern: /\b(t[\s_-]?(shirt|short)|tee|shirt|blouse|sweater|jumper|hoodie|jersey|top)\b/i,
    result: { category: "top", subcategory: "t-shirt" },
  },
  {
    pattern: /\b(pants?|trousers?|jeans?|shorts?|skirt|leggings?)\b/i,
    result: { category: "bottom", subcategory: "bottom" },
  },
  {
    pattern: /\b(sneakers?|trainers?|shoes?|boots?|heels?|sandals?|loafers?)\b/i,
    result: { category: "shoes", subcategory: "shoes" },
  },
  { pattern: /\b(handbag|backpack|tote|purse|bag)\b/i, result: { category: "bag", subcategory: "bag" } },
  { pattern: /\b(beanie|baseball cap|cap|hat|headwear)\b/i, result: { category: "headwear", subcategory: "hat" } },
  {
    pattern: /\b(belt|scarf|watch|necklace|bracelet|earrings?|sunglasses?)\b/i,
    result: { category: "accessory", subcategory: "accessory" },
  },
];

const COLOURS: Array<{ name: string; rgb: [number, number, number] }> = [
  { name: "black", rgb: [24, 24, 27] },
  { name: "white", rgb: [245, 245, 244] },
  { name: "gray", rgb: [135, 135, 140] },
  { name: "red", rgb: [200, 45, 45] },
  { name: "orange", rgb: [220, 125, 45] },
  { name: "yellow", rgb: [225, 200, 65] },
  { name: "green", rgb: [55, 135, 75] },
  { name: "blue", rgb: [55, 90, 170] },
  { name: "navy", rgb: [30, 50, 90] },
  { name: "purple", rgb: [120, 75, 155] },
  { name: "pink", rgb: [220, 145, 170] },
  { name: "brown", rgb: [120, 80, 50] },
  { name: "cream", rgb: [235, 225, 200] },
];

function classify(label: string): Classification {
  for (const entry of CLASSIFIERS) {
    if (entry.pattern.test(label)) return entry.result;
  }
  return { category: "top", subcategory: "garment" };
}

function colourName(hex: string | undefined): string {
  if (!hex || !/^#[0-9a-f]{6}$/i.test(hex)) return "neutral";
  const rgb: [number, number, number] = [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
  return COLOURS.reduce(
    (best, candidate) => {
      const distance = candidate.rgb.reduce((sum, channel, index) => sum + (channel - rgb[index]) ** 2, 0);
      return distance < best.distance ? { name: candidate.name, distance } : best;
    },
    { name: "neutral", distance: Number.POSITIVE_INFINITY },
  ).name;
}

function garmentHex(swatches: string[]): string[] {
  const valid = swatches.filter((value) => /^#[0-9a-f]{6}$/i.test(value));
  const nonBackground = valid.filter((value) => {
    const r = Number.parseInt(value.slice(1, 3), 16);
    const g = Number.parseInt(value.slice(3, 5), 16);
    const b = Number.parseInt(value.slice(5, 7), 16);
    return !(r > 235 && g > 235 && b > 235);
  });
  return (nonBackground.length > 0 ? nonBackground : valid).slice(0, 3);
}

/**
 * Zero-provider fallback for isolated-garment photos. It deliberately returns one full-frame item;
 * multi-garment photos require the separately deployed self-hosted detector.
 */
export function deterministicDetectedItem(fileName: string, swatches: string[]): DeterministicDetectedItem {
  const classification = classify(fileName.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " "));
  const hex = garmentHex(swatches);
  const primary = colourName(hex[0]);
  const title = `${primary} ${classification.subcategory}`.replace(/^./, (letter) => letter.toUpperCase());
  return {
    name: title,
    category: classification.category,
    subcategory: classification.subcategory,
    colours: { primary, secondary: [], hex },
    pattern: "solid",
    material: "unspecified",
    season: ["spring", "summer", "autumn", "winter"],
    formality: "casual",
    description: `the ${primary} ${classification.subcategory} filling the uploaded photo`,
    bbox: [0, 0, 1, 1],
  };
}

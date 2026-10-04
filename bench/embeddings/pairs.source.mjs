"use strict";

/*
 * Step 7 Phase B0 — HAND-AUTHORED ground truth for the embedding benchmark.
 *
 * Nothing here is derived from a model, a score, a cosine value or a threshold. Every pair is a
 * deliberate human judgement about two garments that could plausibly meet in a Fitcheck wardrobe,
 * written to look like real catalogue / extractor output (the same attribute shape production
 * persists, so `embeddingText()` produces a production-shaped string).
 *
 * Only the fields production feeds to the embedding are authored here (name, category, subcategory,
 * colours, pattern, material, description). season / formality / fit / brand are intentionally
 * omitted: they never reach the embedding string, so carrying them in a frozen fixture would only
 * invite drift between what is labelled and what is actually compared.
 *
 * Colour hex values are derived from the colour name via COLOUR_HEX so a fixture cannot carry an
 * impossible colour/hex pairing; build-fixtures.mjs and the test both re-derive the string.
 */

import { LABEL_CONTRACT, PAIR_CLASSES } from "./label-contract.mjs";

/** Fixture hex per colour name. Throws on an unknown name so authoring mistakes surface at build. */
const COLOUR_HEX = {
  black: "#1c1c1c",
  blue: "#2f5d9e",
  beige: "#d9cbb3",
  brown: "#5b3a26",
  burgundy: "#5c1a2b",
  camel: "#c39a63",
  charcoal: "#3b3b3f",
  cream: "#f0ead9",
  green: "#2f5d43",
  grey: "#8f8f8f",
  khaki: "#b5a887",
  navy: "#1f2a44",
  olive: "#5f6141",
  pink: "#d9a3ae",
  red: "#a8202f",
  sand: "#cbb896",
  tan: "#b98b5e",
  white: "#f4f4f0",
};

const colours = (primary, secondary = []) => ({
  primary,
  secondary,
  hex: [primary, ...secondary].map((name) => {
    const hex = COLOUR_HEX[name];
    if (!hex) throw new Error(`pairs.source.mjs: no fixture hex for colour "${name}"`);
    return hex;
  }),
});

const item = (name, category, subcategory, itemColours, pattern, material, description) => ({
  name,
  category,
  subcategory,
  colours: itemColours,
  pattern,
  material,
  description,
});

const pair = (id, cls, a, b, note, changedAttributes) => ({ id, cls, a, b, note, changedAttributes });

export const PAIRS = [
  // ---------------------------------------------------------------------------------------------
  // true_duplicate — the same physical garment listed twice. Two listings, one garment.
  // ---------------------------------------------------------------------------------------------
  pair(
    "td-001",
    "true_duplicate",
    item("Classic white oxford shirt", "top", "shirt", colours("white"), "solid", "cotton", "Men's white button-down shirt in breathable cotton oxford with a buttoned collar."),
    item("White button-up oxford shirt", "top", "shirt", colours("white"), "solid", "cotton", "A men's white button-up shirt made from cotton oxford cloth with a button-down collar."),
    "One shirt sold by two retailers; only the retailer's wording differs.",
  ),
  pair(
    "td-002",
    "true_duplicate",
    item("Navy slim-fit chinos", "bottom", "chinos", colours("navy"), "solid", "cotton", "Slim navy chinos in stretch cotton twill with side pockets and a slim tapered leg."),
    item("Slim navy cotton chinos", "bottom", "chinos", colours("navy"), "solid", "cotton", "Chinos in navy cotton twill, cut slim through the leg with side pockets."),
    "Same product line, two retailer descriptions.",
  ),
  pair(
    "td-003",
    "true_duplicate",
    item("Black Chelsea boots in leather", "shoes", "Chelsea boots", colours("black"), "solid", "leather", "Men's black leather Chelsea boots with an elastic side panel and a stacked heel."),
    item("Leather black ankle boots", "shoes", "Chelsea boots", colours("black"), "solid", "leather", "Black ankle boots cut from leather, finished with elastic gussets and a low stacked heel."),
    "Same boot; 'ankle boots' is the retailer's wording for the same Chelsea silhouette.",
  ),
  pair(
    "td-004",
    "true_duplicate",
    item("Floral-print maxi dress", "dress", "maxi dress", colours("navy", ["pink", "cream"]), "floral", "polyester", "Floor-length floral print maxi dress in polyester with a V-neckline and short sleeves."),
    item("Long floral dress with deep V neck", "dress", "maxi dress", colours("navy", ["pink", "cream"]), "floral", "polyester", "A long floral dress in polyester with a plunging V neckline, short sleeves and a full-length skirt."),
    "Same dress, two listings from different stockists.",
  ),
  pair(
    "td-005",
    "true_duplicate",
    item("Heather grey hooded sweatshirt", "top", "sweatshirt", colours("grey"), "solid", "cotton", "Grey marl sweatshirt in heavyweight cotton fleece with a hood and ribbed cuffs."),
    item("Cotton hooded sweatshirt in heather grey", "top", "sweatshirt", colours("grey"), "solid", "cotton", "A hooded sweatshirt in heather grey cotton fleece, finished with ribbed cuffs and a drawstring hood."),
    "Same sweatshirt; 'marl' and 'heather' are synonyms here.",
  ),
  pair(
    "td-006",
    "true_duplicate",
    item("Sand-coloured trench coat", "outerwear", "trench coat", colours("beige"), "solid", "cotton", "Belted sand-coloured trench coat in cotton gabardine with epaulettes and storm flap."),
    item("Classic beige belted trench", "outerwear", "trench coat", colours("beige"), "solid", "cotton", "A classic belted beige trench in cotton gabardine, detailed with shoulder epaulettes and a storm flap."),
    "Same coat; 'sand-coloured' and 'beige' are the same colourway.",
  ),
  pair(
    "td-007",
    "true_duplicate",
    item("Light wash denim trucker jacket", "outerwear", "denim jacket", colours("blue"), "solid", "denim", "Light wash denim trucker jacket with a pointed collar, two chest pockets and button front."),
    item("Washed denim jacket, trucker style", "outerwear", "denim jacket", colours("blue"), "solid", "denim", "Washed blue denim jacket in a classic trucker cut with a pointed collar and two buttoned chest pockets."),
    "Same jacket; wash described qualitatively in both listings.",
  ),
  pair(
    "td-008",
    "true_duplicate",
    item("Black biker jacket in faux leather", "outerwear", "biker jacket", colours("black"), "solid", "faux leather", "Women's black faux-leather biker jacket with an asymmetric zip, lapels and zippered pockets."),
    item("Leather-look biker jacket", "outerwear", "biker jacket", colours("black"), "solid", "faux leather", "A biker jacket in a black leather-look finish with asymmetric zip fastening and zipped pockets."),
    "Same jacket; 'faux leather' and 'leather-look' name the same material.",
  ),
  pair(
    "td-009",
    "true_duplicate",
    item("Red wool scarf with fringed ends", "accessory", "scarf", colours("red"), "solid", "wool", "Pure new-wool scarf in red with fringed ends, generous 180 by 30 centimetre size."),
    item("Fringed red scarf in wool", "accessory", "scarf", colours("red"), "solid", "wool", "A red scarf woven from wool with knotted fringe at both ends, measuring 180 by 30 centimetres."),
    "Same scarf, identical stated dimensions.",
  ),
  pair(
    "td-010",
    "true_duplicate",
    item("Olive green quilted puffer coat", "outerwear", "puffer coat", colours("olive"), "solid", "polyester", "Olive green quilted puffer coat with horizontal baffles, a hood and a two-way zip."),
    item("Green padded winter coat", "outerwear", "puffer coat", colours("olive"), "solid", "polyester", "Padded winter coat in green with horizontal quilted baffles, a hood and a two-way zip front."),
    "Same coat; 'puffer' and 'padded' are synonyms.",
  ),
  pair(
    "td-011",
    "true_duplicate",
    item("Brown leather shoulder bag", "bag", "shoulder bag", colours("brown"), "solid", "leather", "Adult women's brown leather shoulder bag with two top handles and gold-tone hardware."),
    item("Women's tan shoulder bag in leather", "bag", "shoulder bag", colours("brown"), "solid", "leather", "Shoulder bag in brown leather with twin handles and gold-tone fittings."),
    "Same bag; 'tan' is the retailer's name for the brown colourway.",
  ),
  pair(
    "td-012",
    "true_duplicate",
    item("Blue and white striped cotton T-shirt", "top", "T-shirt", colours("blue", ["white"]), "striped", "cotton", "Regular-fit T-shirt in cotton with blue and white horizontal stripes and a crew neck."),
    item("Striped tee in blue and white", "top", "T-shirt", colours("blue", ["white"]), "striped", "cotton", "Classic striped tee with a crew neck in cotton, striped blue and white horizontally."),
    "Same tee listed twice with reordered wording.",
  ),

  // ---------------------------------------------------------------------------------------------
  // same_garment_alt_wording — same garment, no attribute changed, but the vocabulary or the
  // clause order of the description differs. Splits into vocabulary-changed and reordered.
  // ---------------------------------------------------------------------------------------------
  pair(
    "sag-001",
    "same_garment_alt_wording",
    item("Men's blue Oxford shirt", "top", "shirt", colours("blue"), "solid", "cotton", "A men's blue shirt in cotton Oxford cloth with a buttoned collar and long sleeves."),
    item("Blue button-down shirt in Oxford weave", "top", "shirt", colours("blue"), "solid", "cotton", "Blue cotton shirt in an Oxford weave with a button-down collar and full-length sleeves."),
    "Vocabulary changed: buttoned/button-down collar, long/full-length sleeves.",
    ["wording"],
  ),
  pair(
    "sag-002",
    "same_garment_alt_wording",
    item("White cotton crew-neck T-shirt", "top", "T-shirt", colours("white"), "solid", "cotton", "A white crew-neck T-shirt in 100% cotton, regular fit, with short sleeves and a plain finish."),
    item("Plain short-sleeve tee in white cotton", "top", "T-shirt", colours("white"), "solid", "cotton", "Plain T-shirt with short sleeves and a regular fit, in white 100% cotton with a crew neck."),
    "Reordered description: fit and fabric clauses swapped, neckline moved to the end.",
    ["wording"],
  ),
  pair(
    "sag-003",
    "same_garment_alt_wording",
    item("Grey sweatshirt in loopback cotton", "top", "sweatshirt", colours("grey"), "solid", "cotton", "Grey hooded sweatshirt in loopback cotton with a kangaroo pocket and ribbed hem."),
    item("Heather grey pullover, cotton loopback, hooded", "top", "sweatshirt", colours("grey"), "solid", "cotton", "Heather grey pullover in cotton loopback, hooded, with a kangaroo pocket and a ribbed hem."),
    "Vocabulary changed: sweatshirt/pullover, grey/heather grey.",
    ["wording"],
  ),
  pair(
    "sag-004",
    "same_garment_alt_wording",
    item("Navy cotton chinos", "bottom", "chinos", colours("navy"), "solid", "cotton", "Navy chinos in cotton twill with side pockets, a zip fly and a straight tapered leg."),
    item("Chinos in navy twill with a straight leg", "bottom", "chinos", colours("navy"), "solid", "cotton", "Chinos with a straight tapered leg, cut from navy cotton twill with a zip fly and side pockets."),
    "Reordered description: leg cut moved to the front.",
    ["wording"],
  ),
  pair(
    "sag-005",
    "same_garment_alt_wording",
    item("Black ankle boots in leather", "shoes", "Chelsea boots", colours("black"), "solid", "leather", "Men's black leather ankle boots with elastic side panels and a low stacked heel."),
    item("Leather Chelsea boots in black", "shoes", "Chelsea boots", colours("black"), "solid", "leather", "Black leather Chelsea boots with an elastic gusset side and a low stacked heel."),
    "Vocabulary changed: ankle boots/Chelsea boots, elastic side/gusset.",
    ["wording"],
  ),
  pair(
    "sag-006",
    "same_garment_alt_wording",
    item("Floral V-neck maxi dress", "dress", "maxi dress", colours("black", ["pink", "green"]), "floral", "polyester", "A floral V-neck maxi dress with short sleeves and a floor-length skirt in polyester."),
    item("Maxi dress with a V-neck and short sleeves", "dress", "maxi dress", colours("black", ["pink", "green"]), "floral", "polyester", "Floor-length maxi dress in polyester with a V neckline, short sleeves and an all-over floral print in black, pink and green."),
    "Reordered description: colour list moved to the end of the sentence.",
    ["wording"],
  ),
  pair(
    "sag-007",
    "same_garment_alt_wording",
    item("Straight-leg blue jeans in denim", "bottom", "jeans", colours("blue"), "solid", "denim", "Straight-leg jeans in mid-blue denim with classic five-pocket styling and a mid rise."),
    item("Mid-blue jeans in a straight cut", "bottom", "jeans", colours("blue"), "solid", "denim", "Mid-blue jeans cut straight through the leg, in denim with classic five-pocket styling and a mid rise."),
    "Vocabulary changed: straight-leg/straight cut.",
    ["wording"],
  ),
  pair(
    "sag-008",
    "same_garment_alt_wording",
    item("White low-top trainers with red panels", "shoes", "trainers", colours("white", ["red"]), "colourblock", "synthetic", "Low-top trainers in synthetic with bold red panels, white laces and a rubber sole."),
    item("Trainers with white laces and a rubber sole", "shoes", "trainers", colours("white", ["red"]), "colourblock", "synthetic", "Low-top synthetic trainers with white laces and a rubber sole, finished with bold red panels."),
    "Reordered description: laces and sole moved ahead of the panels.",
    ["wording"],
  ),
  pair(
    "sag-009",
    "same_garment_alt_wording",
    item("Burgundy crew-neck jumper in lambswool", "top", "jumper", colours("burgundy"), "solid", "knit", "Crew-neck jumper in burgundy lambswool with ribbed cuffs and a relaxed fit."),
    item("Lambswool sweater in burgundy with a round neck", "top", "jumper", colours("burgundy"), "solid", "knit", "Round-neck lambswool sweater in burgundy, ribbed at the cuffs and cut in a relaxed fit."),
    "Vocabulary changed: jumper/sweater, crew-neck/round-neck, lambswool/new-wool.",
    ["wording"],
  ),
  pair(
    "sag-010",
    "same_garment_alt_wording",
    item("Olive field jacket in cotton", "outerwear", "field jacket", colours("olive"), "solid", "cotton", "Olive field jacket in cotton with four front pockets, a stand collar and a button front."),
    item("Field jacket with a button front and stand collar", "outerwear", "field jacket", colours("olive"), "solid", "cotton", "Cotton field jacket with a button front and a stand collar, plus four front patch pockets."),
    "Reordered description: pocket clause moved to the end.",
    ["wording"],
  ),
  pair(
    "sag-011",
    "same_garment_alt_wording",
    item("Mid-indigo mom jeans, high rise", "bottom", "jeans", colours("blue"), "solid", "denim", "High-rise mom jeans in mid-indigo denim with a relaxed straight leg and a cropped hem."),
    item("High-waisted jeans in mid-indigo denim", "bottom", "jeans", colours("blue"), "solid", "denim", "Jeans in a mid-indigo denim with a high waist, relaxed straight leg and a cropped hem."),
    "Vocabulary changed: mom jeans, high-rise/high-waisted.",
    ["wording"],
  ),
  pair(
    "sag-012",
    "same_garment_alt_wording",
    item("Cream linen blouse with a relaxed fit", "top", "blouse", colours("cream"), "solid", "linen", "Relaxed-fit blouse in cream linen with a notch neckline and long balloon sleeves."),
    item("Blouse in cream linen with balloon sleeves", "top", "blouse", colours("cream"), "solid", "linen", "Blouse cut from cream linen with long balloon sleeves, a notch neckline and a relaxed fit."),
    "Reordered description: fit clause moved to the end.",
    ["wording"],
  ),

  // ---------------------------------------------------------------------------------------------
  // near_duplicate — one important attribute differs, so it is NOT the same garment, but it is the
  // nearest sensible neighbour of it.
  // ---------------------------------------------------------------------------------------------
  pair(
    "nd-001",
    "near_duplicate",
    item("Navy Oxford shirt", "top", "shirt", colours("navy"), "solid", "cotton", "Navy shirt in cotton Oxford cloth with a button-down collar and long sleeves."),
    item("Blue Oxford shirt", "top", "shirt", colours("blue"), "solid", "cotton", "Blue shirt in cotton Oxford cloth with a button-down collar and long sleeves."),
    "Identical shirt in a different colourway.",
    ["colours.primary: navy -> blue"],
  ),
  pair(
    "nd-002",
    "near_duplicate",
    item("White trainers with red panels", "shoes", "trainers", colours("white", ["red"]), "colourblock", "synthetic", "Low-top synthetic trainers with bold red panels, white laces and a rubber sole."),
    item("Black trainers with white panels", "shoes", "trainers", colours("black", ["white"]), "colourblock", "synthetic", "Low-top synthetic trainers with bold white panels, black laces and a rubber sole."),
    "Same trainer model, inverted colourway.",
    ["colours.primary: white -> black", "colours.secondary: red -> white"],
  ),
  pair(
    "nd-003",
    "near_duplicate",
    item("Straight-leg blue jeans", "bottom", "jeans", colours("blue"), "solid", "denim", "Blue jeans in denim with a straight leg, mid rise and classic five-pocket styling."),
    item("Slim-leg blue jeans", "bottom", "jeans", colours("blue"), "solid", "denim", "Blue jeans in denim with a slim tapered leg, mid rise and classic five-pocket styling."),
    "Same fit family, different leg cut.",
    ["subcategory detail: straight leg -> slim leg"],
  ),
  pair(
    "nd-004",
    "near_duplicate",
    item("Long-sleeve midi dress", "dress", "midi dress", colours("green"), "solid", "viscose blend", "Midi dress in green viscose blend with long sleeves, a square neck and a belted waist."),
    item("Short-sleeve midi dress", "dress", "midi dress", colours("green"), "solid", "viscose blend", "Midi dress in green viscose blend with short sleeves, a square neck and a belted waist."),
    "Same dress, different sleeve length.",
    ["sleeve length: long -> short"],
  ),
  pair(
    "nd-005",
    "near_duplicate",
    item("Grey crew-neck jumper", "top", "jumper", colours("grey"), "solid", "knit", "wool", "Crew-neck jumper in grey lambswool with ribbed cuffs and a regular fit."),
    item("Grey V-neck jumper", "top", "jumper", colours("grey"), "solid", "knit", "wool", "V-neck jumper in grey lambswool with ribbed cuffs and a regular fit."),
    "Same jumper, different neckline.",
    ["neckline: crew -> V"],
  ),
  pair(
    "nd-006",
    "near_duplicate",
    item("Belted beige trench coat", "outerwear", "trench coat", colours("beige"), "solid", "cotton", "Beige trench coat in cotton gabardine with a removable belt, epaulettes and a storm flap."),
    item("Unbelted beige trench coat", "outerwear", "trench coat", colours("beige"), "solid", "cotton", "Beige trench coat in cotton gabardine without a belt, with epaulettes and a storm flap."),
    "Same coat, belt is the only design difference.",
    ["belt: present -> absent"],
  ),
  pair(
    "nd-007",
    "near_duplicate",
    item("Natural canvas tote bag", "bag", "tote bag", colours("beige"), "solid", "canvas", "Tote bag in natural cotton canvas with reinforced handles and an open top."),
    item("Tan leather tote bag", "bag", "tote bag", colours("brown"), "solid", "leather", "Tote bag in tan leather with reinforced handles and an open top."),
    "Same bag shape and handle layout, different material (and the colour that follows it).",
    ["material: canvas -> leather", "colours.primary: beige -> brown"],
  ),
  pair(
    "nd-008",
    "near_duplicate",
    item("Light wash denim jacket", "outerwear", "denim jacket", colours("blue"), "solid", "denim", "Light wash denim jacket with a pointed collar, two chest pockets and a button front."),
    item("Mid wash denim jacket", "outerwear", "denim jacket", colours("blue"), "solid", "denim", "Mid wash denim jacket with a pointed collar, two chest pockets and a button front."),
    "Same jacket, different wash.",
    ["wash: light -> mid"],
  ),
  pair(
    "nd-009",
    "near_duplicate",
    item("Black A-line skirt", "bottom", "skirt", colours("black"), "solid", "polyester", "A-line skirt in black polyester, sitting at the natural waist and falling above the knee."),
    item("Black pencil skirt", "bottom", "skirt", colours("black"), "solid", "polyester", "Pencil skirt in black polyester, sitting at the natural waist and falling to the knee."),
    "Same fabric and colour, different silhouette and length.",
    ["silhouette: A-line -> pencil", "length: above knee -> knee"],
  ),
  pair(
    "nd-010",
    "near_duplicate",
    item("Grey hooded sweatshirt", "top", "sweatshirt", colours("grey"), "solid", "cotton", "Hooded sweatshirt in grey cotton fleece with a kangaroo pocket and ribbed cuffs."),
    item("Navy hooded sweatshirt", "top", "sweatshirt", colours("navy"), "solid", "cotton", "Hooded sweatshirt in navy cotton fleece with a kangaroo pocket and ribbed cuffs."),
    "Identical sweatshirt in a different colour.",
    ["colours.primary: grey -> navy"],
  ),
  pair(
    "nd-011",
    "near_duplicate",
    item("Navy cotton chinos", "bottom", "chinos", colours("navy"), "solid", "cotton", "Chinos in navy cotton twill with side pockets and a slim tapered leg."),
    item("Khaki cotton chinos", "bottom", "chinos", colours("khaki"), "solid", "cotton", "Chinos in khaki cotton twill with side pockets and a slim tapered leg."),
    "Identical chinos in a different colour.",
    ["colours.primary: navy -> khaki"],
  ),
  pair(
    "nd-012",
    "near_duplicate",
    item("Cropped cream cardigan", "top", "cardigan", colours("cream"), "solid", "knit", "wool", "Cropped cardigan in cream lambswool with a button front and dropped shoulders."),
    item("Longline cream cardigan", "top", "cardigan", colours("cream"), "solid", "knit", "wool", "Longline cardigan in cream lambswool with a button front and dropped shoulders."),
    "Same cardigan, different length.",
    ["length: cropped -> longline"],
  ),

  // ---------------------------------------------------------------------------------------------
  // same_category_diff_colour — same garment type and subcategory, different colourway.
  // ---------------------------------------------------------------------------------------------
  pair(
    "sc-001",
    "same_category_diff_colour",
    item("White Oxford shirt", "top", "shirt", colours("white"), "solid", "cotton", "White shirt in cotton Oxford cloth with a button-down collar and long sleeves."),
    item("Navy Oxford shirt", "top", "shirt", colours("navy"), "solid", "cotton", "Navy shirt in cotton Oxford cloth with a button-down collar and long sleeves."),
    "Same shirt, white versus navy colourway.",
  ),
  pair(
    "sc-002",
    "same_category_diff_colour",
    item("Black cotton chinos", "bottom", "chinos", colours("black"), "solid", "cotton", "Chinos in black cotton twill with side pockets and a slim tapered leg."),
    item("Beige cotton chinos", "bottom", "chinos", colours("beige"), "solid", "cotton", "Chinos in beige cotton twill with side pockets and a slim tapered leg."),
    "Same chinos, black versus beige.",
  ),
  pair(
    "sc-003",
    "same_category_diff_colour",
    item("Grey hooded sweatshirt", "top", "sweatshirt", colours("grey"), "solid", "cotton", "Hooded sweatshirt in grey cotton fleece with a kangaroo pocket and ribbed cuffs."),
    item("Green hooded sweatshirt", "top", "sweatshirt", colours("green"), "solid", "cotton", "Hooded sweatshirt in green cotton fleece with a kangaroo pocket and ribbed cuffs."),
    "Same sweatshirt, grey versus green.",
  ),
  pair(
    "sc-004",
    "same_category_diff_colour",
    item("Burgundy midi dress", "dress", "midi dress", colours("burgundy"), "solid", "polyester", "Midi dress in burgundy polyester with short sleeves, a round neck and a belted waist."),
    item("Navy midi dress", "dress", "midi dress", colours("navy"), "solid", "polyester", "Midi dress in navy polyester with short sleeves, a round neck and a belted waist."),
    "Same dress, burgundy versus navy.",
  ),
  pair(
    "sc-005",
    "same_category_diff_colour",
    item("Brown Chelsea boots", "shoes", "Chelsea boots", colours("brown"), "solid", "leather", "Brown leather Chelsea boots with an elastic side panel and a stacked heel."),
    item("Black Chelsea boots", "shoes", "Chelsea boots", colours("black"), "solid", "leather", "Black leather Chelsea boots with an elastic side panel and a stacked heel."),
    "Same boot, brown versus black.",
  ),
  pair(
    "sc-006",
    "same_category_diff_colour",
    item("Navy tote bag", "bag", "tote bag", colours("navy"), "solid", "canvas", "Tote bag in navy cotton canvas with reinforced handles and an open top."),
    item("Pink tote bag", "bag", "tote bag", colours("pink"), "solid", "canvas", "Tote bag in pink cotton canvas with reinforced handles and an open top."),
    "Same tote, navy versus pink.",
  ),
  pair(
    "sc-007",
    "same_category_diff_colour",
    item("Red cotton T-shirt", "top", "T-shirt", colours("red"), "solid", "cotton", "Crew-neck T-shirt in red cotton with short sleeves and a regular fit."),
    item("Blue cotton T-shirt", "top", "T-shirt", colours("blue"), "solid", "cotton", "Crew-neck T-shirt in blue cotton with short sleeves and a regular fit."),
    "Same tee, red versus blue.",
  ),
  pair(
    "sc-008",
    "same_category_diff_colour",
    item("Camel wool coat", "outerwear", "coat", colours("camel"), "solid", "wool", "Camel wool coat with a notch lapel, long sleeves and a straight hem."),
    item("Grey wool coat", "outerwear", "coat", colours("grey"), "solid", "wool", "Grey wool coat with a notch lapel, long sleeves and a straight hem."),
    "Same coat, camel versus grey.",
  ),
  pair(
    "sc-009",
    "same_category_diff_colour",
    item("Navy and white striped shirt", "top", "shirt", colours("navy", ["white"]), "striped", "cotton", "Shirt in cotton with navy and white vertical stripes, a button-down collar and long sleeves."),
    item("Green and white striped shirt", "top", "shirt", colours("green", ["white"]), "striped", "cotton", "Shirt in cotton with green and white vertical stripes, a button-down collar and long sleeves."),
    "Same striped shirt, different stripe colour.",
  ),
  pair(
    "sc-010",
    "same_category_diff_colour",
    item("Black A-line skirt", "bottom", "skirt", colours("black"), "solid", "polyester", "A-line skirt in black polyester, sitting at the natural waist and falling above the knee."),
    item("Cream A-line skirt", "bottom", "skirt", colours("cream"), "solid", "polyester", "A-line skirt in cream polyester, sitting at the natural waist and falling above the knee."),
    "Same skirt, black versus cream.",
  ),
  pair(
    "sc-011",
    "same_category_diff_colour",
    item("Be lambswool beanie", "headwear", "beanie", colours("beige"), "solid", "knit", "wool", "Beanie in beige lambswool with a folded cuff and a ribbed knit finish."),
    item("Navy lambswool beanie", "headwear", "beanie", colours("navy"), "solid", "knit", "wool", "Beanie in navy lambswool with a folded cuff and a ribbed knit finish."),
    "Same beanie, beige versus navy.",
  ),
  pair(
    "sc-012",
    "same_category_diff_colour",
    item("White low-top trainers", "shoes", "trainers", colours("white"), "solid", "synthetic", "Low-top trainers in white synthetic with a rubber sole and white laces."),
    item("Black low-top trainers", "shoes", "trainers", colours("black"), "solid", "synthetic", "Low-top trainers in black synthetic with a rubber sole and black laces."),
    "Same trainer, white versus black.",
  ),

  // ---------------------------------------------------------------------------------------------
  // same_colour_diff_category — the shared colour is the only thing in common. Different garment
  // classes, unrelated use, and the pair should NOT read as similar.
  // ---------------------------------------------------------------------------------------------
  pair(
    "sd-001",
    "same_colour_diff_category",
    item("Navy blue jeans", "bottom", "jeans", colours("navy"), "solid", "denim", "Blue jeans in navy denim with a straight leg and classic five-pocket styling."),
    item("Navy hooded sweatshirt", "top", "sweatshirt", colours("navy"), "solid", "cotton", "Hooded sweatshirt in navy cotton fleece with a kangaroo pocket and ribbed cuffs."),
    "Both navy; a bottom and a top with nothing else shared.",
  ),
  pair(
    "sd-002",
    "same_colour_diff_category",
    item("Black biker jacket", "outerwear", "biker jacket", colours("black"), "solid", "faux leather", "Black faux-leather biker jacket with an asymmetric zip, lapels and zippered pockets."),
    item("Black gym bag", "bag", "holdall", colours("black"), "solid", "polyester", "Black holdall gym bag in polyester with a shoulder strap and a zip opening."),
    "Both black; outerwear and a sports bag.",
  ),
  pair(
    "sd-003",
    "same_colour_diff_category",
    item("White draped blouse", "top", "blouse", colours("white"), "solid", "viscose blend", "White short-sleeve blouse in viscose blend with a wide neckline and a draped waist."),
    item("White low-top trainers", "shoes", "trainers", colours("white"), "solid", "synthetic", "Low-top trainers in white synthetic with a rubber sole and white laces."),
    "Both white; a blouse and a shoe.",
  ),
  pair(
    "sd-004",
    "same_colour_diff_category",
    item("Beige trench coat", "outerwear", "trench coat", colours("beige"), "solid", "cotton", "Belted beige trench coat in cotton gabardine with epaulettes and a storm flap."),
    item("Beige suede loafers", "shoes", "loafers", colours("beige"), "solid", "suede", "Beige suede loafers with a penny bar, a leather lining and a stacked heel."),
    "Both beige; outerwear and a shoe.",
  ),
  pair(
    "sd-005",
    "same_colour_diff_category",
    item("Red midi dress", "dress", "midi dress", colours("red"), "solid", "polyester", "Midi dress in red polyester with short sleeves, a round neck and a belted waist."),
    item("Red wool beanie", "headwear", "beanie", colours("red"), "solid", "knit", "wool", "Beanie in red lambswool with a folded cuff and a ribbed knit finish."),
    "Both red; a dress and headwear.",
  ),
  pair(
    "sd-006",
    "same_colour_diff_category",
    item("Brown leather brogues", "shoes", "brogues", colours("brown"), "solid", "leather", "Brown leather brogues with a medallion toe, a Goodyear welt and a leather sole."),
    item("Brown leather belt", "accessory", "belt", colours("brown"), "solid", "leather", "Brown leather belt with a 35 millimetre brass buckle and punched holes."),
    "Both brown leather; a shoe and an accessory.",
  ),
  pair(
    "sd-007",
    "same_colour_diff_category",
    item("Green lambswool cardigan", "top", "cardigan", colours("green"), "solid", "knit", "wool", "Button-front cardigan in green lambswool with dropped shoulders and ribbed cuffs."),
    item("Green tote bag", "bag", "tote bag", colours("green"), "solid", "canvas", "Tote bag in green cotton canvas with reinforced handles and an open top."),
    "Both green; a knitwear top and a bag.",
  ),
  pair(
    "sd-008",
    "same_colour_diff_category",
    item("Grey tailored trousers", "bottom", "trousers", colours("grey"), "solid", "wool", "Tailored trousers in grey wool with a flat front, side pockets and a pressed crease."),
    item("Grey wool beanie", "headwear", "beanie", colours("grey"), "solid", "knit", "wool", "Beanie in grey lambswool with a folded cuff and a ribbed knit finish."),
    "Both grey wool; tailored trousers and a hat.",
  ),
  pair(
    "sd-009",
    "same_colour_diff_category",
    item("Black A-line skirt", "bottom", "skirt", colours("black"), "solid", "polyester", "A-line skirt in black polyester, sitting at the natural waist and falling above the knee."),
    item("Black ankle boots", "shoes", "Chelsea boots", colours("black"), "solid", "leather", "Black leather ankle boots with an elastic side panel and a stacked heel."),
    "Both black; a skirt and a boot.",
  ),
  pair(
    "sd-010",
    "same_colour_diff_category",
    item("Cream oversized shirt", "top", "shirt", colours("cream"), "solid", "cotton", "Oversized cream shirt in cotton with a relaxed fit, a camp collar and long sleeves."),
    item("Cream handbag", "bag", "handbag", colours("cream"), "solid", "leather", "Small cream handbag in leather with a top handle, a magnetic closure and gold-tone studs."),
    "Both cream; a shirt and a handbag.",
  ),
  pair(
    "sd-011",
    "same_colour_diff_category",
    item("Burgundy lambswool jumper", "top", "jumper", colours("burgundy"), "solid", "knit", "wool", "Crew-neck jumper in burgundy lambswool with ribbed cuffs and a relaxed fit."),
    item("Burgundy wool scarf", "accessory", "scarf", colours("burgundy"), "solid", "wool", "A burgundy scarf woven from wool with knotted fringe at both ends."),
    "Both burgundy wool; knitwear and an accessory.",
  ),
  pair(
    "sd-012",
    "same_colour_diff_category",
    item("Blue quilted parka", "outerwear", "parka", colours("blue"), "solid", "polyester", "Blue quilted parka in polyester with a hood, a fur-trimmed hood edge and insulated sleeves."),
    item("Blue denim jeans", "bottom", "jeans", colours("blue"), "solid", "denim", "Blue jeans in denim with a straight leg and classic five-pocket styling."),
    "Both blue; outerwear and a bottom.",
  ),

  // ---------------------------------------------------------------------------------------------
  // related_not_duplicate — complementary wardrobe roles inside one style family. These SHOULD be
  // worn together and are NOT near neighbours in a similarity ranking, so both gates are false.
  // ---------------------------------------------------------------------------------------------
  pair(
    "rn-001",
    "related_not_duplicate",
    item("White Oxford shirt", "top", "shirt", colours("white"), "solid", "cotton", "White shirt in cotton Oxford cloth with a button-down collar and long sleeves."),
    item("Navy slim chinos", "bottom", "chinos", colours("navy"), "solid", "cotton", "Slim navy chinos in stretch cotton twill with side pockets and a slim tapered leg."),
    "Smart-casual outfit partners: shirt and trousers, different colours, different roles.",
  ),
  pair(
    "rn-002",
    "related_not_duplicate",
    item("Navy and white striped tee", "top", "T-shirt", colours("navy", ["white"]), "striped", "cotton", "T-shirt in cotton with navy and white horizontal stripes and a crew neck."),
    item("Light wash denim jacket", "outerwear", "denim jacket", colours("blue"), "solid", "denim", "Light wash denim jacket with a pointed collar, two chest pockets and a button front."),
    "Casual layered outfit: striped tee under a denim jacket.",
  ),
  pair(
    "rn-003",
    "related_not_duplicate",
    item("Cream lambswool jumper", "top", "jumper", colours("cream"), "solid", "knit", "wool", "Crew-neck jumper in cream lambswool with ribbed cuffs and a relaxed fit."),
    item("Navy tailored trousers", "bottom", "trousers", colours("navy"), "solid", "wool", "Tailored trousers in navy wool with a flat front, side pockets and a pressed crease."),
    "Knitwear over tailored trousers in the same smart-casual register.",
  ),
  pair(
    "rn-004",
    "related_not_duplicate",
    item("Red wool scarf", "accessory", "scarf", colours("red"), "solid", "wool", "Pure new-wool scarf in red with fringed ends, generous 180 by 30 centimetre size."),
    item("Camel wool coat", "outerwear", "coat", colours("camel"), "solid", "wool", "Camel wool coat with a notch lapel, long sleeves and a straight hem."),
    "Accessory worn with an outerwear coat; a pairing, not a similarity.",
  ),
  pair(
    "rn-005",
    "related_not_duplicate",
    item("White draped blouse", "top", "blouse", colours("white"), "solid", "viscose blend", "White short-sleeve blouse in viscose blend with a wide neckline and a draped waist."),
    item("Beige A-line skirt", "bottom", "skirt", colours("beige"), "solid", "polyester", "A-line skirt in beige polyester, sitting at the natural waist and falling above the knee."),
    "Light summer outfit: blouse with a skirt.",
  ),
  pair(
    "rn-006",
    "related_not_duplicate",
    item("Navy cotton T-shirt", "top", "T-shirt", colours("navy"), "solid", "cotton", "Crew-neck T-shirt in navy cotton with short sleeves and a regular fit."),
    item("Grey sweatpants", "bottom", "joggers", colours("grey"), "solid", "cotton", "Joggers in grey cotton fleece with an elastic waist, drawcords and cuffed ankles."),
    "Loungewear outfit partners, deliberately mismatched colours.",
  ),
  pair(
    "rn-007",
    "related_not_duplicate",
    item("White ribbed tank top", "top", "tank top", colours("white"), "solid", "cotton", "White ribbed tank top in cotton with a scoop neckline and a fitted cropped body."),
    item("Black tailored trousers", "bottom", "trousers", colours("black"), "solid", "wool", "Tailored trousers in black wool with a flat front, side pockets and a pressed crease."),
    "Minimal evening outfit: tank with tailored trousers.",
  ),
  pair(
    "rn-008",
    "related_not_duplicate",
    item("Green bomber jacket", "outerwear", "bomber jacket", colours("green"), "solid", "polyester", "Green bomber jacket in polyester with ribbed cuffs, a zip front and two welt pockets."),
    item("White low-top trainers", "shoes", "trainers", colours("white"), "solid", "synthetic", "Low-top trainers in white synthetic with a rubber sole and white laces."),
    "Casual streetwear outfit: jacket with trainers.",
  ),
  pair(
    "rn-009",
    "related_not_duplicate",
    item("Blue Oxford shirt", "top", "shirt", colours("blue"), "solid", "cotton", "Blue shirt in cotton Oxford cloth with a button-down collar and long sleeves."),
    item("Grey tailored trousers", "bottom", "trousers", colours("grey"), "solid", "wool", "Tailored trousers in grey wool with a flat front, side pockets and a pressed crease."),
    "Office outfit: shirt with tailored trousers.",
  ),
  pair(
    "rn-010",
    "related_not_duplicate",
    item("Burgundy midi dress", "dress", "midi dress", colours("burgundy"), "solid", "polyester", "Midi dress in burgundy polyester with short sleeves, a round neck and a belted waist."),
    item("Black opaque tights", "bottom", "tights", colours("black"), "solid", "polyester", "Opaque black tights in polyester with a reinforced waistband and 40 denier opacity."),
    "A dress and its legwear; a styling dependency, not a similarity.",
  ),
  pair(
    "rn-011",
    "related_not_duplicate",
    item("Tan suede jacket", "outerwear", "suede jacket", colours("tan"), "solid", "suede", "Tan suede jacket with a pointed collar, a zip front and two chest pockets."),
    item("Mid-indigo mom jeans", "bottom", "jeans", colours("blue"), "solid", "denim", "High-rise mom jeans in mid-indigo denim with a relaxed straight leg and a cropped hem."),
    "Weekend outfit: suede jacket with jeans.",
  ),
  pair(
    "rn-012",
    "related_not_duplicate",
    item("Pink lambswool beanie", "headwear", "beanie", colours("pink"), "solid", "knit", "wool", "Beanie in pink lambswool with a folded cuff and a ribbed knit finish."),
    item("Grey wool coat", "outerwear", "coat", colours("grey"), "solid", "wool", "Grey wool coat with a notch lapel, long sleeves and a straight hem."),
    "Winter accessory worn with a winter coat.",
  ),

  // ---------------------------------------------------------------------------------------------
  // hard_negative — high lexical overlap, genuinely different garments. These are the cases a
  // lexical or colour-dominated representation gets wrong: denim jacket vs denim jeans, a bag vs
  // a belt made of the same word, a shirt vs a shirt dress.
  // ---------------------------------------------------------------------------------------------
  pair(
    "hn-001",
    "hard_negative",
    item("Light wash denim jacket", "outerwear", "denim jacket", colours("blue"), "solid", "denim", "Light wash denim jacket with a pointed collar, two chest pockets and a button front."),
    item("Light wash denim jeans", "bottom", "jeans", colours("blue"), "solid", "denim", "Light wash denim jeans with a straight leg and classic five-pocket styling."),
    "Denim jacket vs denim jeans: same material, same wash, same colour, different garment class.",
    ["category: outerwear -> bottom", "subcategory: denim jacket -> jeans"],
  ),
  pair(
    "hn-002",
    "hard_negative",
    item("Dark wash denim jeans", "bottom", "jeans", colours("blue"), "solid", "denim", "Dark wash denim jeans in a slim leg with classic five-pocket styling."),
    item("Dark wash denim trucker jacket", "outerwear", "denim jacket", colours("blue"), "solid", "denim", "Dark wash denim trucker jacket with a pointed collar and two buttoned chest pockets."),
    "Same pair of concepts as hn-001 with the wash swapped, to break any wash-led shortcut.",
    ["category: bottom -> outerwear", "subcategory: jeans -> denim jacket"],
  ),
  pair(
    "hn-003",
    "hard_negative",
    item("Indigo denim dungarees", "bottom", "dungarees", colours("blue"), "solid", "denim", "Indigo denim dungarees with adjustable shoulder straps, a chest pocket and side pockets."),
    item("Indigo denim jeans", "bottom", "jeans", colours("blue"), "solid", "denim", "Indigo denim jeans with a straight leg and classic five-pocket styling."),
    "Denim dungarees vs denim jeans: same material and colour, entirely different garment.",
    ["subcategory: dungarees -> jeans"],
  ),
  pair(
    "hn-004",
    "hard_negative",
    item("Blue check shirt", "top", "shirt", colours("blue", ["black", "white"]), "check", "cotton", "Blue, black and white checked long-sleeve button-down shirt in cotton."),
    item("Blue floral shirt", "top", "shirt", colours("blue", ["white"]), "floral", "cotton", "Relaxed short-sleeve blue shirt in cotton with a white tropical leaf print."),
    "Both blue cotton men's shirts; the print and the sleeve length are different garments.",
    ["pattern: check -> floral", "subcategory: shirt -> short-sleeve shirt"],
  ),
  pair(
    "hn-005",
    "hard_negative",
    item("Black biker jacket", "outerwear", "biker jacket", colours("black"), "solid", "faux leather", "Black faux-leather biker jacket with an asymmetric zip, lapels and zippered pockets."),
    item("Black wool overcoat", "outerwear", "coat", colours("black"), "solid", "wool", "Full-length black wool overcoat with a notch lapel and a concealed button front."),
    "Both black outerwear with 'jacket' in the name; completely different garment.",
    ["subcategory: biker jacket -> coat", "material: faux leather -> wool"],
  ),
  pair(
    "hn-006",
    "hard_negative",
    item("Canvas trainers", "shoes", "trainers", colours("white"), "solid", "canvas", "Low-top trainers in white canvas with a vulcanised rubber sole and white laces."),
    item("Canvas tote bag", "bag", "tote bag", colours("beige"), "solid", "canvas", "Tote bag in natural cotton canvas with reinforced handles and an open top."),
    "Same material word and both unstructured, but one is footwear and one is a bag.",
    ["category: shoes -> bag", "subcategory: trainers -> tote bag"],
  ),
  pair(
    "hn-007",
    "hard_negative",
    item("Black leather shoulder bag", "bag", "shoulder bag", colours("black"), "solid", "leather", "Adult women's black leather shoulder bag with two top handles and silver-tone hardware."),
    item("Black leather belt", "accessory", "belt", colours("black"), "solid", "leather", "Black leather belt with a 35 millimetre silver buckle and punched holes."),
    "Identical material and colour words; a bag and a belt are not near neighbours.",
    ["category: bag -> accessory", "subcategory: shoulder bag -> belt"],
  ),
  pair(
    "hn-008",
    "hard_negative",
    item("Blue and white striped shirt", "top", "shirt", colours("blue", ["white"]), "striped", "cotton", "Shirt in cotton with blue and white vertical stripes, a button-down collar and long sleeves."),
    item("Blue and white striped scarf", "accessory", "scarf", colours("blue", ["white"]), "striped", "wool", "A blue and white striped scarf woven from wool with knotted fringe at both ends."),
    "Identical colours and identical pattern word; a shirt and a scarf.",
    ["category: top -> accessory", "subcategory: shirt -> scarf"],
  ),
  pair(
    "hn-009",
    "hard_negative",
    item("Checked wool skirt", "bottom", "skirt", colours("brown", ["cream"]), "check", "wool", "A-line skirt in brown and cream checked wool, sitting at the natural waist."),
    item("Checked wool shirt", "top", "shirt", colours("brown", ["cream"]), "check", "wool", "Long-sleeve shirt in brown and cream checked wool with a button-down collar."),
    "Same fabric, same check, same colours; skirt vs shirt.",
    ["category: bottom -> top", "subcategory: skirt -> shirt"],
  ),
  pair(
    "hn-010",
    "hard_negative",
    item("Cotton shirt dress", "dress", "shirt dress", colours("white"), "solid", "cotton", "Shirt dress in white cotton with a button front, a collar and a belted waist."),
    item("White cotton shirt", "top", "shirt", colours("white"), "solid", "cotton", "White button-down shirt in cotton with a buttoned collar and long sleeves."),
    "Contains the word 'shirt' and is otherwise near-identical text; a dress, not a shirt.",
    ["category: top -> dress", "subcategory: shirt -> shirt dress"],
  ),
  pair(
    "hn-011",
    "hard_negative",
    item("Red wool scarf", "accessory", "scarf", colours("red"), "solid", "wool", "A red scarf woven from wool with knotted fringe at both ends."),
    item("Red wool beanie", "headwear", "beanie", colours("red"), "solid", "knit", "wool", "Beanie in red lambswool with a folded cuff and a ribbed knit finish."),
    "Identical colour and material; headwear vs accessory.",
    ["category: accessory -> headwear", "subcategory: scarf -> beanie"],
  ),
  pair(
    "hn-012",
    "hard_negative",
    item("Striped cotton T-shirt", "top", "T-shirt", colours("navy", ["white"]), "striped", "cotton", "Crew-neck T-shirt in cotton with navy and white horizontal stripes."),
    item("Striped cotton hoodie", "top", "sweatshirt", colours("navy", ["white"]), "striped", "cotton", "Hooded sweatshirt in cotton with navy and white stripes, a kangaroo pocket and drawcords."),
    "Same stripes, same fabric, same colours; a tee and a sweatshirt.",
    ["subcategory: T-shirt -> sweatshirt", "garment: short-sleeve -> hooded"],
  ),
  pair(
    "hn-013",
    "hard_negative",
    item("Long-sleeve shirt", "top", "shirt", colours("white"), "solid", "cotton", "Long-sleeve button-down shirt in white cotton with a relaxed fit and a buttoned collar."),
    item("Long-sleeve shirt dress", "dress", "shirt dress", colours("white"), "solid", "cotton", "Long-sleeve shirt dress in white cotton with a collar and a belted waist."),
    "Long-sleeve cotton white in both; the garment class differs.",
    ["category: top -> dress"],
  ),
  pair(
    "hn-014",
    "hard_negative",
    item("Linen trousers", "bottom", "trousers", colours("beige"), "solid", "linen", "Wide-leg trousers in beige linen with a drawstring waist and side pockets."),
    item("Linen shorts", "bottom", "shorts", colours("beige"), "solid", "linen", "Drawstring shorts in beige linen with an elastic waist and side pockets."),
    "Same fabric and colour, both bottoms; a leg-length difference, not a similar item.",
    ["subcategory: trousers -> shorts"],
  ),
];

/** Fail fast if an authored pair drifts out of the frozen label contract. */
for (const entry of PAIRS) {
  const contract = LABEL_CONTRACT[entry.cls];
  if (!contract) throw new Error(`pairs.source.mjs: ${entry.id} has unknown class "${entry.cls}"`);
  if (!PAIR_CLASSES.includes(entry.cls)) {
    throw new Error(`pairs.source.mjs: ${entry.id} class "${entry.cls}" is not in PAIR_CLASSES`);
  }
}

export const PAIRS_BY_CLASS = Object.fromEntries(
  PAIR_CLASSES.map((cls) => [cls, PAIRS.filter((entry) => entry.cls === cls)]),
);
// Phase B1: validate Qwen traces with the FROZEN B0 validator. No fixture changes.
// Usage: node bench/stylist/validate-results.mjs [path-to-.out-dir]
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { validateTrace } from "./validate-trace.mjs";

const outDir = process.argv[2] ?? join(import.meta.dirname, ".out");
const wardrobe = JSON.parse(readFileSync(join(import.meta.dirname, "wardrobe.json"), "utf8"));
const items = Array.isArray(wardrobe) ? wardrobe : wardrobe.items;
const fixtures = { wardrobeIds: items.map((item) => item.id) };

const files = readdirSync(outDir).filter((file) => file.endsWith(".trace.json")).sort();
let pass = 0;
for (const file of files) {
  const record = JSON.parse(readFileSync(join(outDir, file), "utf8"));
  const expectation = JSON.parse(
    readFileSync(join(import.meta.dirname, "cases", `${record.caseId}.json`), "utf8"),
  ).expect;
  const allowed =
    expectation.allowedItemIds === "ALL" ? "ALL" : expectation.allowedItemIds;
  const result = validateTrace(record.trace, expectation, {
    wardrobeIds: fixtures.wardrobeIds,
    allowedItemIds: allowed,
  });
  if (result.ok) pass += 1;
  console.log(
    `${record.caseId}: ${result.ok ? "PASS" : "FAIL"} (${record.trace.length} steps)` +
      (result.ok ? "" : ` errors=${JSON.stringify(result.errors)}`) +
      (result.warnings.length > 0 ? ` warnings=${JSON.stringify(result.warnings)}` : ""),
  );
}
console.log(`\n${pass}/${files.length} cases pass`);

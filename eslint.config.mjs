import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "convex/_generated/**",
    ".claude/**",
    "docs/**",
    "**/.eve/**",
    ".output/**",
    ".convex/**",
    // OpenWear is a separate Plasmo/React project with its own package.json and
    // tsconfig. This config applies Next.js rules (e.g. @next/next/no-img-element)
    // that do not apply to it, and the extension has no ESLint config of its own yet.
    "extension/**",
  ]),
]);

export default eslintConfig;

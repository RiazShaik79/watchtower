// Resolve hooks installed by register.mjs (same approach as the app's tests/helpers/ts-hooks.mjs).
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = new URL("../", import.meta.url);

export async function resolve(specifier, context, next) {
  if (specifier.startsWith("@/")) specifier = new URL(specifier.slice(2), ROOT).href;
  const isPath = specifier.startsWith(".") || specifier.startsWith("file:");
  if (isPath && !/\.[cm]?[jt]sx?$|\.json$/.test(specifier)) {
    const base = new URL(specifier, context.parentURL ?? ROOT);
    for (const ext of [".ts", ".tsx", "/index.ts"]) {
      const candidate = new URL(base.href + ext);
      if (fs.existsSync(fileURLToPath(candidate))) return next(pathToFileURL(fileURLToPath(candidate)).href, context);
    }
  }
  return next(specifier, context);
}

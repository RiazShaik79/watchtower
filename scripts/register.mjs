// `node --import ./scripts/register.mjs` lets the worker, scripts and unit tests import TypeScript
// the way Next.js does: "@/lib/x" and extensionless "./x" both resolve to the .ts file.
// Node 24 strips the types itself (erasable syntax only, enforced by tsconfig).
import { register } from "node:module";

register("./ts-hooks.mjs", import.meta.url);

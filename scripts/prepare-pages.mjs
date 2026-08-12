import { cp, mkdir } from "node:fs/promises";
import { join } from "node:path";

const output = "pages-output";

await mkdir(output, { recursive: true });
await cp("dist/client", output, { recursive: true, force: true });
await cp("dist/server/index.js", join(output, "_worker.js"), { force: true });
await cp("dist/server/__vite_rsc_assets_manifest.js", join(output, "__vite_rsc_assets_manifest.js"), { force: true });
await cp("dist/server/ssr", join(output, "ssr"), { recursive: true, force: true });


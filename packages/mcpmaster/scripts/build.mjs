// Bundles mcpmaster into ONE dependency-free file, dist/mcpmaster.mjs, with the
// web UI inlined — which is what makes `npx mcpmaster` and the curl installer
// a single download with nothing to resolve at runtime.

import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const WEB_FILES = { "/": "index.html", "/app.js": "app.js", "/app.css": "app.css", "/logo.svg": "logo.svg" };
// Binary files are inlined as base64 and decoded once at startup.
const BINARY_FILES = { "/logo.png": "logo.png" };

// Replaces src/web-assets.ts (which reads from disk) with the same files inlined.
const inlineWebAssets = {
  name: "inline-web-assets",
  setup(b) {
    b.onLoad({ filter: /[\\/]web-assets\.ts$/ }, () => {
      const files = Object.fromEntries(
        Object.entries(WEB_FILES).map(([path, file]) => [
          path,
          readFileSync(join(root, "src", "web", file), "utf8").replaceAll("__MCPMASTER_VERSION__", pkg.version),
        ]),
      );
      const binary = Object.fromEntries(
        Object.entries(BINARY_FILES).map(([path, file]) => [path, readFileSync(join(root, "src", "web", file)).toString("base64")]),
      );
      return {
        loader: "ts",
        contents:
          `const FILES = ${JSON.stringify(files)};\n` +
          `const BINARY = Object.fromEntries(Object.entries(${JSON.stringify(binary)}).map(([p, b]) => [p, Buffer.from(b, "base64")]));\n` +
          `export function webAsset(path) { return Object.hasOwn(FILES, path) ? FILES[path] : Object.hasOwn(BINARY, path) ? BINARY[path] : null; }\n`,
      };
    });
  },
};

await build({
  entryPoints: [join(root, "src", "index.ts")],
  outfile: join(root, "dist", "mcpmaster.mjs"),
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  minify: true,
  legalComments: "eof",
  // Some bundled CommonJS dependencies call require(); give ESM output one.
  banner: {
    js: "import { createRequire as __mcpmCreateRequire } from 'node:module';\nconst require = __mcpmCreateRequire(import.meta.url);",
  },
  define: { __MCPMASTER_VERSION__: JSON.stringify(pkg.version) },
  // The code-mode sandbox (core/src/sandbox.ts) uses QuickJS's .wasm-file
  // variant, which reads the .wasm from its package folder at runtime — that
  // can't survive being bundled into one file. The single-file variant is the
  // same build with the WASM inlined, so the bundle stays one download.
  alias: { "@jitl/quickjs-wasmfile-release-sync": "@jitl/quickjs-singlefile-mjs-release-sync" },
  plugins: [inlineWebAssets],
  logLevel: "warning",
});

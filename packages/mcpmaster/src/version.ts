// Injected by scripts/build.mjs from package.json; "dev" when run from source.
declare const __MCPMASTER_VERSION__: string | undefined;

export const VERSION: string = typeof __MCPMASTER_VERSION__ === "string" ? __MCPMASTER_VERSION__ : "0.0.0-dev";

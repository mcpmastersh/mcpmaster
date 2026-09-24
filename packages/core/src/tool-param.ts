// The single definition of "which part of the HTTP request does this argument
// belong to".
//
// It lives in its own module because three layers need the same type and none
// of them should own it: the openapi translator produces it (openapi.ts), the
// runtime stores it on every cached tool, and dispatch routes by it
// (openapi-params.ts). A duplicated union in any one of those is how the
// halves drift.
//
// `cookie` is intentionally absent. Dispatch has never had a branch for
// cookie parameters, so they were never interpolated; keeping them out of the
// type means the compiler enforces that nothing starts claiming to handle them
// on one path only.
export type ToolParamLocation = "path" | "query" | "header" | "body";

export type ToolParam = { name: string; in: ToolParamLocation };

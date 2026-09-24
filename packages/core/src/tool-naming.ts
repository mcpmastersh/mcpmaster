// The naming rules for aggregated tool `fullName`s (`<prefix>.<tool>`), as
// used by mcpmaster Cloud: a per-integration prefix that stays unique within
// a workspace.
//
// This logic is pure — no storage, no network, no environment — so it lives
// in its own module where a test can EXECUTE it, rather than asserting on the
// shape of the source that calls it. A test that only checks a line exists
// can never show the code produces the right *output*.
//
// These names are load-bearing well beyond display. A tool's `fullName` is:
//   - what `list_tools` advertises and `call_tool` accepts;
//   - what dispatch resolves to exactly one integration;
//   - the key a cached tool list is indexed by;
//   - the key a blocked tool is recorded under, so a collision makes one
//     block suppress two different integrations' tools.
// Two integrations sharing a prefix is therefore not cosmetic: it makes one
// integration unreachable while still appearing healthy in the tool list.

/** Slugify an integration's display name, falling back to its id prefix. */
export function slugifyIntegrationName(name: string, integrationId: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || integrationId.slice(0, 8);
}

/** The subset of an integration row the prefix assignment needs. */
export interface PrefixCandidate {
  id: string;
  name: string;
}

/**
 * Assign a unique prefix to every integration, in the order given.
 *
 * The contract: the returned array has exactly one entry per input, in the
 * same order, and **no two prefixes are ever equal**. Callers rely on the
 * positional correspondence to attach each prefix to its integration.
 *
 * Order matters for WHICH suffix a colliding integration gets, but not for
 * uniqueness — uniqueness is the guarantee, the specific suffix is arbitrary.
 * `writeToolCache` deliberately mirrors this first-wins ordering so a warm
 * cache and a cold read never disagree (see its comment).
 */
export function assignIntegrationPrefixes(integrations: PrefixCandidate[]): string[] {
  const usedPrefixes = new Set<string>();
  const assigned: string[] = [];

  for (const integration of integrations) {
    const base = slugifyIntegrationName(integration.name, integration.id);
    // Prefer the base name; on collision, the short-id form; then, if THAT is
    // taken too, a numeric suffix. See below for why the last step is needed.
    let prefix = base;
    if (usedPrefixes.has(prefix)) {
      prefix = `${base}-${integration.id.slice(0, 8)}`;
    }
    // The suffixed form must ITSELF be checked, and the check must loop.
    //
    // A single `if` was not enough, and the gap is reachable without unusual
    // setup: a suffixed prefix was added to `usedPrefixes` without verifying it
    // was free, so an integration *literally named* to collide with a generated
    // suffix steals it:
    //
    //   1. "alpha-api"          (id 11111111-…) -> "alpha-api"
    //   2. "alpha-api-bbbbbbbb"                  -> "alpha-api-bbbbbbbb"  [free]
    //   3. "alpha-api"          (id bbbbbbbb-…) -> "alpha-api" taken, so suffix
    //                                               -> "alpha-api-bbbbbbbb"  [TAKEN]
    //
    // Integrations 2 and 3 then share a prefix, so a tool present in both is
    // emitted twice under one `fullName`: `list_tools` advertises it twice,
    // dispatch reaches only one of the two integrations, `writeToolCache`'s
    // index keeps only one, and one blocklist row suppresses both. Nothing
    // constrains integration names (`0005_add_integrations.sql`'s only unique
    // is `source_site_id`), and a scanned site is named after its URL verbatim
    // (`scan-processing.ts`), so a name matching a generated `-id8` suffix is
    // unusual but entirely reachable.
    //
    // Terminates: the loop runs only while the candidate is taken, and each
    // iteration appends to a strictly growing string, so it cannot cycle.
    let attempt = 0;
    while (usedPrefixes.has(prefix)) {
      attempt += 1;
      prefix = `${base}-${integration.id.slice(0, 8)}-${attempt}`;
    }

    usedPrefixes.add(prefix);
    assigned.push(prefix);
  }

  return assigned;
}

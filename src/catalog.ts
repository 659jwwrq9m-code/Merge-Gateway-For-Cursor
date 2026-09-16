/**
 * Model-catalogue shaping for client pickers.
 *
 * Gateway's OpenAI surface (`/v1/openai/models`) and its native catalogue
 * (`/v1/models`) disagree, and neither is sufficient alone:
 *
 *   - Capability is published only on the **native** catalogue, per vendor, as
 *     `capabilities.supports_tool_calling`.
 *   - The **native** catalogue has 289 models; the OpenAI surface lists 273, so
 *     16 routable models are missing from it.
 *   - 67 OpenAI-family models appear on the surface *unprefixed* (`gpt-5.5`)
 *     while the native catalogue calls them `openai/gpt-5.5`. Those prefixes are
 *     interchangeable at the endpoint — both routable — but an id copied from
 *     one list can be absent from the other, which silently drops models.
 *
 * So the native catalogue is the single source of truth, and entries are
 * rendered into the OpenAI shape a picker expects. That keeps one authoritative
 * list rather than intersecting two that disagree.
 *
 * The filter matters because Cursor's Agent mode and Xcode's chat both send
 * `tools` on the very first turn. A model without tool calling answers that turn
 * and then stalls: it cannot call the tool, so the agent loop has nowhere to go,
 * and the failure only appears after the request has been billed.
 */

/** A model reduced to what a picker needs to decide whether to show it. */
export interface CatalogModel {
  id: string;
  displayName: string;
  provider: string;
  /**
   * Gateway can route it, but the organisation's vendor access has not been
   * granted, so a request would be rejected.
   *
   * Kept in the list and ordered last rather than hidden: it is one dashboard
   * setting away from working, and silently dropping every Claude model would
   * look like a bug in the shim rather than a Gateway permission.
   */
  accessRequired: boolean;
}

/** An entry in the OpenAI `list` shape a model picker parses. */
export interface OpenAIModelEntry {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
}

interface NativeVendor {
  capabilities?: { supports_tool_calling?: boolean } | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Ask for the whole catalogue in one request.
 *
 * The endpoint honours `limit` well above the catalogue size, so a single call
 * returns everything with `has_more: false`. No cursor walk is needed; the
 * request is a fixed, small cost on the model-list path.
 */
export const CATALOG_LIMIT = 500;

/**
 * Read Gateway's native catalogue into the models a client can actually drive.
 *
 * A model counts as tool-capable when *any* vendor serving it supports tool
 * calling. That is the right test because Gateway routes across vendors, so one
 * capable vendor is enough for the request to succeed, and many models are
 * served by more than one.
 *
 * An unrecognisable payload yields an empty list. Callers treat that as "no
 * capability information" rather than "no models", so a Gateway schema change
 * degrades to an unfiltered list instead of an empty picker.
 */
export function readCatalog(payload: unknown): CatalogModel[] {
  const data = isRecord(payload) ? payload.data : undefined;
  if (!Array.isArray(data)) return [];

  const models: CatalogModel[] = [];
  const seen = new Set<string>();

  for (const entry of data) {
    if (!isRecord(entry)) continue;
    if (typeof entry.model !== "string" || entry.model.length === 0) continue;
    if (seen.has(entry.model)) continue;

    const vendors = entry.vendors;
    if (!isRecord(vendors)) continue;

    const capable = Object.values(vendors).some(
      (vendor) => (vendor as NativeVendor | null)?.capabilities?.supports_tool_calling === true,
    );
    if (!capable) continue;

    seen.add(entry.model);
    models.push({
      id: entry.model,
      displayName: typeof entry.display_name === "string" ? entry.display_name : entry.model,
      provider: typeof entry.provider === "string" ? entry.provider : "merge-gateway",
      accessRequired: entry.access_required === true,
    });
  }

  return models;
}

/**
 * Render the catalogue as an OpenAI `list` for a model picker.
 *
 * Ordered so everything usable comes first, alphabetically, then the
 * access-gated models. `access_required` models are not errors to hide — they
 * are just not the ones to reach for by default, and a picker lists in order.
 *
 * `created` is 0 because Gateway publishes no creation time on the native
 * catalogue (`created_at` is null for every record). Pickers treat it as
 * informational and no client has been observed to sort on it; a fabricated
 * timestamp would be worse than an obviously absent one.
 */
export function toOpenAIModelList(catalog: CatalogModel[]): OpenAIModelEntry[] {
  return [...catalog]
    .sort((a, b) => {
      if (a.accessRequired !== b.accessRequired) return a.accessRequired ? 1 : -1;
      return a.id.localeCompare(b.id);
    })
    .map((model) => ({
      id: model.id,
      object: "model" as const,
      created: 0,
      owned_by: model.provider,
    }));
}

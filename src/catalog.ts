/**
 * Model-catalogue shaping for client pickers.
 *
 * Gateway's OpenAI surface advertises everything it can route — 273 models —
 * but Cursor's Agent mode and Xcode's chat both send `tools` on the very first
 * turn. A model without tool calling answers that turn and then stalls: it has
 * no way to call the tool, so the agent loop has nowhere to go. Listing those
 * models is worse than omitting them, because the failure only appears after a
 * request has been billed.
 *
 * Capability is not on the OpenAI surface. It lives on Gateway's *native*
 * `/v1/models`, per vendor, as `capabilities.supports_tool_calling`. So the two
 * lists are joined: the native catalogue decides membership, and the OpenAI
 * surface supplies the entries — it is the only one keyed by `id`, which is the
 * field a picker actually parses.
 */

/** A model reduced to what a picker needs to decide whether to show it. */
export interface CatalogModel {
  id: string;
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

interface NativeVendor {
  capabilities?: { supports_tool_calling?: boolean } | null;
}

interface NativeModel {
  model?: unknown;
  access_required?: unknown;
  vendors?: Record<string, NativeVendor> | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Read Gateway's native `/v1/models` payload into the models a client can
 * actually drive.
 *
 * A model counts as tool-capable when *any* vendor serving it supports tool
 * calling. That is the right test because Gateway routes across vendors, so one
 * capable vendor is enough for the request to succeed, and 26 of the visible
 * models are served by more than one.
 *
 * An unrecognisable payload yields an empty list. Callers treat that as "no
 * capability information" rather than "no models", so a Gateway schema change
 * degrades to an unfiltered list instead of an empty picker.
 */
export function readToolCapable(payload: unknown): CatalogModel[] {
  const data = isRecord(payload) ? payload.data : undefined;
  if (!Array.isArray(data)) return [];

  const models: CatalogModel[] = [];
  for (const entry of data) {
    if (!isRecord(entry)) continue;

    const native = entry as NativeModel;
    if (typeof native.model !== "string" || native.model.length === 0) continue;

    const vendors = native.vendors;
    if (!isRecord(vendors)) continue;

    const capable = Object.values(vendors).some(
      (vendor) => vendor?.capabilities?.supports_tool_calling === true,
    );
    if (!capable) continue;

    models.push({ id: native.model, accessRequired: native.access_required === true });
  }

  return models;
}

/**
 * Drop models that cannot call tools, then order the rest for a picker.
 *
 * Ordering is: everything usable first, alphabetically, then the access-gated
 * models. `access_required` models are not errors to hide — they are just not
 * the ones to reach for by default, and a picker lists in order.
 *
 * Ids absent from `catalog` are dropped. The OpenAI surface and the native
 * catalogue agreed on every tool-capable id when this was written, so a miss
 * means the two drifted, and omitting an unknown-capability model is the
 * conservative choice.
 */
export function orderForPicker<T extends { id: string }>(models: T[], catalog: CatalogModel[]): T[] {
  const byId = new Map(catalog.map((model) => [model.id, model]));

  return models
    .filter((model) => byId.has(model.id))
    .sort((a, b) => {
      const aGated = byId.get(a.id)?.accessRequired === true ? 1 : 0;
      const bGated = byId.get(b.id)?.accessRequired === true ? 1 : 0;
      if (aGated !== bGated) return aGated - bGated;
      return a.id.localeCompare(b.id);
    });
}

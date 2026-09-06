/**
 * Deterministic task-factor vocabulary + extractor (Step 8).
 *
 * Factors are stable snake_case tags used both when reflecting (situation graph)
 * and when retrieving usable lessons for a fresh task (shared-factor traversal).
 *
 * ## Factor list
 *
 * | Factor | Meaning |
 * |--------|---------|
 * | `needs_customer_id` | Task requires a resolved CRM customer_id (name/email alone is not enough) |
 * | `ambiguous_customer_match` | Customer may not be uniquely identified from the task text |
 * | `order_lookup` | Task involves listing or inspecting orders |
 * | `ticket_create` | Task involves opening a support ticket |
 * | `customer_search` | Task implies finding a customer record first |
 * | `missing_customer_id` | Failure/lesson factor: list_orders (or similar) used without customer_id |
 * | `list_orders_before_resolve` | Failure/lesson factor: called list_orders before resolving id |
 * | `bad_list_orders_usage` | Failure/lesson factor: wrong args / unscoped list_orders |
 *
 * Task-side extractor emits the first five (situation cues). Reflection may also
 * attach the last three as lesson/situation factors so shared-factor retrieval
 * connects an unseen wording of "look up orders for X" to the promoted lesson.
 */

/** Canonical factor names (document + validate). */
export const KNOWN_FACTORS = [
  "needs_customer_id",
  "ambiguous_customer_match",
  "order_lookup",
  "ticket_create",
  "customer_search",
  "missing_customer_id",
  "list_orders_before_resolve",
  "bad_list_orders_usage",
] as const;

export type KnownFactor = (typeof KNOWN_FACTORS)[number];

/** Aliases so task cues overlap lesson/failure tags during retrieval. */
export const FACTOR_ALIASES: Record<string, string[]> = {
  needs_customer_id: ["missing_customer_id", "list_orders_before_resolve"],
  order_lookup: ["list_orders_before_resolve", "bad_list_orders_usage"],
  customer_search: ["needs_customer_id", "missing_customer_id"],
  missing_customer_id: ["needs_customer_id"],
  list_orders_before_resolve: ["needs_customer_id", "order_lookup"],
  bad_list_orders_usage: ["order_lookup"],
};

export type FactorExtraction = {
  factors: string[];
  /** How each factor was inferred (for logging). */
  evidence: Record<string, string>;
};

function hasPersonName(text: string): boolean {
  return (
    /\bfor\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/.test(text) ||
    /\bcustomer\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/i.test(text) ||
    /\b[A-Z][a-z]+\s+[A-Z][a-z]+\b/.test(text)
  );
}

function hasExplicitCustomerId(text: string): boolean {
  return /\bcustomer[_ ]?id\b/i.test(text) && /\bcus_[a-z0-9]+\b/i.test(text);
}

/**
 * Expand extracted factors with aliases so retrieval can bridge task cues
 * and lesson/failure tags stored in semantic memory.
 */
export function expandFactors(factors: string[]): string[] {
  const out = new Set<string>();
  for (const f of factors) {
    const key = f.trim().toLowerCase();
    if (!key) continue;
    out.add(key);
    for (const alias of FACTOR_ALIASES[key] || []) {
      out.add(alias);
    }
  }
  return [...out];
}

/**
 * Lightweight deterministic extractor from task text + optional prior episode blurbs.
 */
export function extractFactors(
  task: string,
  priorEpisodeSummaries: string[] = [],
): FactorExtraction {
  const blob = [task, ...priorEpisodeSummaries].join("\n");
  const factors: string[] = [];
  const evidence: Record<string, string> = {};

  const orderCue =
    /\border(s)?\b/i.test(blob) ||
    /\bshipment|shipping|delivery|purchase(s)?\b/i.test(blob);
  if (orderCue) {
    factors.push("order_lookup");
    evidence.order_lookup = "order/shipment language in task or prior episode";
  }

  const ticketCue =
    /\bticket\b/i.test(blob) ||
    /\bsupport\b/i.test(blob) ||
    /\brefund|complaint|late shipment|issue\b/i.test(blob);
  if (ticketCue) {
    factors.push("ticket_create");
    evidence.ticket_create = "ticket/support language in task or prior episode";
  }

  const named = hasPersonName(task);
  const hasId = hasExplicitCustomerId(task);
  if ((orderCue || ticketCue || named) && !hasId) {
    factors.push("needs_customer_id");
    evidence.needs_customer_id =
      "named customer / order-or-ticket task without explicit customer_id";
  }

  if (named && !hasId) {
    factors.push("ambiguous_customer_match");
    evidence.ambiguous_customer_match =
      "display name present without unique customer_id";
  }

  if (
    (named && !hasId) ||
    /\bsearch|find customer|look up customer|resolve customer\b/i.test(blob)
  ) {
    factors.push("customer_search");
    evidence.customer_search =
      "customer must be resolved via search before id-scoped tools";
  }

  // Dedupe while preserving order
  const unique = [...new Set(factors)];
  return { factors: unique, evidence };
}

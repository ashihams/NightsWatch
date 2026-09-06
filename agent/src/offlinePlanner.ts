/**
 * Deterministic offline planner — no LLM credentials required.
 *
 * Default (naive): jumps to list_orders without resolving customer_id first.
 * That failure mode is the teaching signal for later learning loops.
 *
 * When Step 8 injects a usable lesson that advises resolving customer_id first,
 * the offline planner follows it (search → list with id) so demos change without TensorMux.
 */

import type { PlannerAction } from "./llm.js";
import type { ToolCallResult } from "./tools.js";
import {
  getInjectedSemanticLessons,
  lessonAdvisesResolveCustomerId,
  type SemanticLessonInjected,
} from "./strategy.js";

function extractPersonName(task: string): string | null {
  // "Find orders for Jordan Lee and ..." / "customer Sam Rivera"
  const m =
    task.match(/\bfor\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/) ||
    task.match(/\bcustomer\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/i) ||
    task.match(/\b([A-Z][a-z]+\s+[A-Z][a-z]+)\b/);
  return m ? m[1] : null;
}

function searchResults(
  prior: ToolCallResult[],
): Array<{ customer_id?: string }> {
  const search = [...prior].reverse().find((r) => r.name === "search_customers");
  if (
    search &&
    search.body &&
    typeof search.body === "object" &&
    Array.isArray((search.body as { results?: unknown }).results)
  ) {
    return (search.body as { results: Array<{ customer_id?: string }> }).results;
  }
  return [];
}

function firstCustomerId(prior: ToolCallResult[]): string | undefined {
  return searchResults(prior)[0]?.customer_id;
}

/**
 * Learned path: search/resolve customer_id before list_orders.
 */
function offlinePlanWithResolveLesson(
  task: string,
  prior: ToolCallResult[],
): PlannerAction {
  const step = prior.length;
  const name = extractPersonName(task) || "Jordan Lee";
  const wantsTicket = /ticket|support|late|shipment|refund|issue/i.test(task);

  if (step === 0) {
    return {
      type: "tool",
      name: "search_customers",
      args: { query: name },
    };
  }

  if (step === 1) {
    const id = firstCustomerId(prior);
    if (id) {
      return {
        type: "tool",
        name: "list_orders",
        args: { customer_id: id },
      };
    }
    return {
      type: "tool",
      name: "list_orders",
      args: { query: name },
    };
  }

  if (step === 2 && wantsTicket) {
    const id = firstCustomerId(prior);
    return {
      type: "tool",
      name: "create_ticket",
      args: {
        ...(id ? { customer_id: id } : {}),
        subject: "Late shipment",
        body: `Customer reported late shipment. Task: ${task}`,
      },
    };
  }

  const hadMiss = prior.some(
    (r) =>
      r.name === "list_orders" &&
      (!r.ok ||
        (r.body &&
          typeof r.body === "object" &&
          ((r.body as { error?: string }).error === "missing_customer_id" ||
            (r.body as { unscoped?: boolean }).unscoped === true))),
  );

  return {
    type: "finish",
    message: hadMiss
      ? `Offline run finished but still hit a list_orders miss. Task was: ${task}`
      : `Offline planner finished using injected resolve-customer_id lesson. Task was: ${task}`,
  };
}

/**
 * Given task + prior tool results, emit the next naive action.
 * State is derived only from how many tools have already run (deterministic).
 *
 * Optional `injectedContext` (working_runs.injected_context) enables learned behavior.
 */
export function offlinePlanNext(
  task: string,
  prior: ToolCallResult[],
  injectedContext?: unknown[],
): PlannerAction {
  const lessons: SemanticLessonInjected[] = getInjectedSemanticLessons(
    injectedContext ?? [],
  );
  if (lessonAdvisesResolveCustomerId(lessons)) {
    return offlinePlanWithResolveLesson(task, prior);
  }

  const step = prior.length;
  const name = extractPersonName(task) || "Jordan Lee";
  const wantsTicket = /ticket|support|late|shipment|refund|issue/i.test(task);

  // Step 0 — classic failure: list_orders without customer_id
  if (step === 0) {
    return {
      type: "tool",
      name: "list_orders",
      // Naive: pass the display name / empty filter instead of a real customer_id
      args: { query: name },
    };
  }

  // Step 1 — search after the list_orders miss
  if (step === 1) {
    return {
      type: "tool",
      name: "search_customers",
      args: { query: name },
    };
  }

  // Step 2 — still naive: pick first search hit if any, else retry list without id
  if (step === 2) {
    const results = searchResults(prior);
    const firstId = results[0]?.customer_id;
    if (firstId) {
      return {
        type: "tool",
        name: "list_orders",
        args: { customer_id: firstId },
      };
    }
    return {
      type: "tool",
      name: "list_orders",
      args: {},
    };
  }

  // Step 3 — optionally open a ticket (may still use a weak / first id)
  if (step === 3 && wantsTicket) {
    const results = searchResults(prior);
    const firstId = results[0]?.customer_id;

    return {
      type: "tool",
      name: "create_ticket",
      args: {
        ...(firstId ? { customer_id: firstId } : {}),
        subject: "Late shipment",
        body: `Customer reported late shipment. Task: ${task}`,
      },
    };
  }

  const listFail = prior.some(
    (r) =>
      r.name === "list_orders" &&
      (!r.ok ||
        (r.body &&
          typeof r.body === "object" &&
          ((r.body as { error?: string }).error === "missing_customer_id" ||
            (r.body as { unscoped?: boolean }).unscoped === true))),
  );

  return {
    type: "finish",
    message: listFail
      ? `Naive offline run finished with a list_orders miss (missing/unscoped customer_id) — intentional teaching signal. Task was: ${task}`
      : `Offline planner finished. Task was: ${task}`,
  };
}

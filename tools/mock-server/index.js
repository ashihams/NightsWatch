/**
 * Minimal CRM / support webhook mock for Loop.
 * POST JSON endpoints that behave like imperfect third-party tools.
 *
 * Port defaults to 5678 (n8n-like). Override with PORT=...
 * Programmatic: const { server, port, close } = await startMockCrmServer()
 */

const http = require("http");
const { customers, orders, tickets, nextTicketId } = require("./data");

const PORT = Number(process.env.PORT) || 5678;

/** When set, disable flaky quirks so serverless demos stay deterministic. */
function deterministic() {
  return /^(1|true|yes|on)$/i.test(process.env.MOCK_CRM_DETERMINISTIC || "");
}

function chance(p) {
  if (deterministic()) return false;
  return Math.random() < p;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(Object.assign(new Error("Invalid JSON body"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function send(res, status, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(payload);
}

function normalizePath(url) {
  const path = (url || "/").split("?")[0].replace(/\/+$/, "") || "/";
  const m = path.match(/^(?:\/webhook)?\/([a-z_]+)$/);
  return m ? m[1] : null;
}

function searchCustomers(body) {
  const query = (body.query ?? body.q ?? "").toString().trim();
  if (!query) {
    return {
      status: 400,
      body: {
        ok: false,
        error: "missing_query",
        message: "search_customers requires { query }. Empty query returns nothing useful.",
        results: [],
      },
    };
  }

  const q = query.toLowerCase();
  let results = customers.filter((c) => {
    const hay = [c.name, c.email, c.company, c.customer_id, c.phone]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return hay.includes(q) || q.split(/\s+/).every((tok) => hay.includes(tok));
  });

  if (results.length > 2 && chance(0.25)) {
    results = results.slice(0, 2);
    return {
      status: 200,
      body: {
        ok: true,
        query,
        match_count: results.length,
        truncated: true,
        warning: "Result set truncated; refine query or page (paging not implemented).",
        results: results.map(publicCustomer),
      },
    };
  }

  if (results.length === 0 && chance(0.4)) {
    const noise = customers.slice(0, 2).map(publicCustomer);
    return {
      status: 200,
      body: {
        ok: true,
        query,
        match_count: noise.length,
        fuzzy: true,
        warning: "No exact matches; returning possible related records (low confidence).",
        results: noise,
      },
    };
  }

  return {
    status: 200,
    body: {
      ok: true,
      query,
      match_count: results.length,
      results: results.map(publicCustomer),
      ...(results.length > 1
        ? {
            warning:
              "Multiple customers matched. Disambiguate before calling list_orders / create_ticket.",
          }
        : {}),
    },
  };
}

function publicCustomer(c) {
  return {
    customer_id: c.customer_id,
    name: c.name,
    email: c.email,
    phone: c.phone,
    company: c.company,
    status: c.status,
  };
}

function getCustomer(body) {
  const customerId = body.customer_id ?? body.customerId;
  if (!customerId) {
    return {
      status: 400,
      body: {
        ok: false,
        error: "missing_customer_id",
        message: "get_customer requires { customer_id }.",
      },
    };
  }

  const customer = customers.find((c) => c.customer_id === customerId);
  if (!customer) {
    return {
      status: 404,
      body: {
        ok: false,
        error: "customer_not_found",
        message: `No customer with id ${customerId}`,
        customer_id: customerId,
      },
    };
  }

  if (chance(0.15)) {
    return {
      status: 200,
      body: {
        ok: true,
        stale: true,
        warning: "Profile may be cached; some fields omitted.",
        customer: {
          customer_id: customer.customer_id,
          name: customer.name,
          email: customer.email,
        },
      },
    };
  }

  return {
    status: 200,
    body: { ok: true, customer: publicCustomer(customer) },
  };
}

function listOrders(body) {
  const customerId = body.customer_id ?? body.customerId;

  if (!customerId) {
    // Deterministic teaching miss for offline demos.
    if (deterministic() || chance(0.5)) {
      return {
        status: 400,
        body: {
          ok: false,
          error: "missing_customer_id",
          message:
            "list_orders requires { customer_id }. Resolve the customer via search_customers / get_customer first.",
        },
      };
    }
    const randomSlice = orders.slice(0, 3).map((o) => ({
      order_id: o.order_id,
      status: o.status,
      total: o.total,
      ...(chance(0.5) ? { customer_id: o.customer_id } : {}),
    }));
    return {
      status: 200,
      body: {
        ok: true,
        warning:
          "No customer_id provided — returning unscoped recent orders. Do not assume these belong to your user.",
        unscoped: true,
        orders: randomSlice,
      },
    };
  }

  const customer = customers.find((c) => c.customer_id === customerId);
  if (!customer) {
    return {
      status: 404,
      body: {
        ok: false,
        error: "customer_not_found",
        message: `Unknown customer_id ${customerId}; cannot list orders.`,
        customer_id: customerId,
      },
    };
  }

  const list = orders
    .filter((o) => o.customer_id === customerId)
    .map((o) => ({
      order_id: o.order_id,
      customer_id: o.customer_id,
      status: o.status,
      total: o.total,
      currency: o.currency,
      created_at: o.created_at,
    }));

  return {
    status: 200,
    body: {
      ok: true,
      customer_id: customerId,
      order_count: list.length,
      orders: list,
    },
  };
}

async function getOrder(body) {
  const orderId = body.order_id ?? body.orderId;
  if (!orderId) {
    return {
      status: 400,
      body: {
        ok: false,
        error: "missing_order_id",
        message: "get_order requires { order_id }.",
      },
    };
  }

  if (chance(0.3)) {
    const delay = 1800 + Math.floor(Math.random() * 2200);
    await sleep(delay);
  }

  const order = orders.find((o) => o.order_id === orderId);
  if (!order) {
    return {
      status: 404,
      body: {
        ok: false,
        error: "order_not_found",
        message: `No order with id ${orderId}`,
        order_id: orderId,
      },
    };
  }

  return {
    status: 200,
    body: {
      ok: true,
      order: {
        order_id: order.order_id,
        customer_id: order.customer_id,
        status: order.status,
        total: order.total,
        currency: order.currency,
        items: order.items,
        created_at: order.created_at,
        ...(order.note ? { note: order.note } : {}),
      },
    },
  };
}

function createTicket(body) {
  const customerId = body.customer_id ?? body.customerId;
  const subject = (body.subject ?? "").toString().trim();
  const ticketBody = (body.body ?? body.message ?? "").toString().trim();

  if (!customerId) {
    return {
      status: 400,
      body: {
        ok: false,
        error: "missing_customer_id",
        message: "create_ticket requires { customer_id, subject, body }.",
      },
    };
  }

  if (!subject || !ticketBody) {
    return {
      status: 400,
      body: {
        ok: false,
        error: "missing_fields",
        message: "create_ticket requires non-empty subject and body.",
        missing: [
          ...(!subject ? ["subject"] : []),
          ...(!ticketBody ? ["body"] : []),
        ],
      },
    };
  }

  const customer = customers.find((c) => c.customer_id === customerId);
  if (!customer) {
    return {
      status: 404,
      body: {
        ok: false,
        error: "customer_not_found",
        message: `Cannot create ticket for unknown customer_id ${customerId}`,
      },
    };
  }

  if (chance(0.2)) {
    return {
      status: 429,
      body: {
        ok: false,
        error: "rate_limited",
        message: "Too many ticket writes. Retry after a short backoff.",
        retry_after_seconds: 2 + Math.floor(Math.random() * 4),
      },
    };
  }

  const ticket = {
    ticket_id: nextTicketId(),
    customer_id: customerId,
    subject,
    body: ticketBody,
    status: "open",
    created_at: new Date().toISOString(),
  };
  tickets.push(ticket);

  return {
    status: 201,
    body: { ok: true, ticket },
  };
}

const handlers = {
  search_customers: async (body) => searchCustomers(body),
  get_customer: async (body) => getCustomer(body),
  list_orders: async (body) => listOrders(body),
  get_order: async (body) => getOrder(body),
  create_ticket: async (body) => createTicket(body),
};

function createRequestListener() {
  return async (req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
      return;
    }

    if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
      send(res, 200, {
        ok: true,
        service: "loop-mock-crm",
        tools: Object.keys(handlers),
        deterministic: deterministic(),
        hint: "POST JSON to /webhook/<tool_name>",
      });
      return;
    }

    if (req.method !== "POST") {
      send(res, 405, {
        ok: false,
        error: "method_not_allowed",
        message: "Use POST with JSON.",
      });
      return;
    }

    const tool = normalizePath(req.url);
    if (!tool || !handlers[tool]) {
      send(res, 404, {
        ok: false,
        error: "unknown_tool",
        message: `Unknown path ${req.url}. Expected /webhook/{${Object.keys(handlers).join("|")}}`,
      });
      return;
    }

    try {
      const body = await readJson(req);
      const result = await handlers[tool](body);
      send(res, result.status, result.body);
    } catch (err) {
      send(res, err.status || 500, {
        ok: false,
        error: "server_error",
        message: err.message || "Unexpected error",
      });
    }
  };
}

/**
 * @param {{ port?: number, host?: string }} [opts]
 * @returns {Promise<{ server: import('http').Server, port: number, baseUrl: string, close: () => Promise<void> }>}
 */
function startMockCrmServer(opts = {}) {
  const host = opts.host || "127.0.0.1";
  const wantPort = opts.port != null ? Number(opts.port) : 0;
  const server = http.createServer(createRequestListener());

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(wantPort, host, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : wantPort;
      resolve({
        server,
        port,
        baseUrl: `http://${host}:${port}`,
        close: () =>
          new Promise((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          }),
      });
    });
  });
}

module.exports = {
  handlers,
  startMockCrmServer,
  createRequestListener,
};

if (require.main === module) {
  startMockCrmServer({ port: PORT, host: "0.0.0.0" })
    .then(({ port }) => {
      console.log(`Loop mock CRM listening on http://localhost:${port}`);
      console.log("Tools:");
      for (const name of Object.keys(handlers)) {
        console.log(`  POST /webhook/${name}`);
      }
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

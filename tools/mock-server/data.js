/** Seed CRM data — intentionally messy / ambiguous for agent learning. */

const customers = [
  {
    customer_id: "cust_1001",
    name: "Jordan Lee",
    email: "jordan.lee@example.com",
    phone: "+1-555-0101",
    company: "Northwind Labs",
    status: "active",
  },
  {
    customer_id: "cust_1002",
    name: "Jordan Lee",
    email: "jlee@acme.co",
    phone: "+1-555-0199",
    company: "Acme Retail",
    status: "active",
    note: "Different person, same display name — common search ambiguity",
  },
  {
    customer_id: "cust_1003",
    name: "Sam Rivera",
    email: "sam.rivera@example.com",
    phone: "+1-555-0142",
    company: "Rivera Consulting",
    status: "active",
  },
  {
    customer_id: "cust_1004",
    name: "Sam Rivera",
    email: "s.rivera+billing@example.org",
    phone: null,
    company: null,
    status: "inactive",
    note: "Stale duplicate-ish record; phone missing",
  },
  {
    customer_id: "cust_1005",
    name: "Alex Chen",
    email: "alex.chen@globex.io",
    phone: "+1-555-0177",
    company: "Globex",
    status: "active",
  },
  {
    customer_id: "cust_1006",
    name: "Alex Chen",
    email: "achen@example.net",
    phone: "+1-555-0178",
    company: "Freelance",
    status: "active",
  },
  {
    customer_id: "cust_1007",
    name: "Morgan Blake",
    email: "morgan@example.com",
    phone: "+1-555-0110",
    company: "Blake & Co",
    status: "active",
  },
  {
    customer_id: "cust_1008",
    name: "Taylor Kim",
    email: "taylor.kim@example.com",
    phone: "+1-555-0120",
    company: "Kim Ventures",
    status: "churned",
  },
];

const orders = [
  {
    order_id: "ord_5001",
    customer_id: "cust_1001",
    status: "shipped",
    total: 129.99,
    currency: "USD",
    items: ["Pro Plan (annual)"],
    created_at: "2026-01-12T14:22:00Z",
  },
  {
    order_id: "ord_5002",
    customer_id: "cust_1001",
    status: "processing",
    total: 49.0,
    currency: "USD",
    items: ["Support add-on"],
    created_at: "2026-03-01T09:10:00Z",
  },
  {
    order_id: "ord_5003",
    customer_id: "cust_1002",
    status: "delivered",
    total: 899.0,
    currency: "USD",
    items: ["Hardware kit", "Warranty"],
    created_at: "2025-11-20T18:00:00Z",
  },
  {
    order_id: "ord_5004",
    customer_id: "cust_1003",
    status: "cancelled",
    total: 200.0,
    currency: "USD",
    items: ["Consulting block"],
    created_at: "2026-02-05T11:30:00Z",
  },
  {
    order_id: "ord_5005",
    customer_id: "cust_1005",
    status: "shipped",
    total: 59.99,
    currency: "USD",
    items: ["Starter Plan"],
    created_at: "2026-04-18T16:45:00Z",
  },
  {
    order_id: "ord_5006",
    customer_id: "cust_1005",
    status: "refunded",
    total: 59.99,
    currency: "USD",
    items: ["Starter Plan"],
    created_at: "2026-04-20T08:00:00Z",
    note: "Duplicate charge dispute",
  },
  {
    order_id: "ord_5007",
    customer_id: "cust_1006",
    status: "delivered",
    total: 19.99,
    currency: "USD",
    items: ["Credits pack"],
    created_at: "2026-05-02T12:00:00Z",
  },
  {
    order_id: "ord_5008",
    customer_id: "cust_1007",
    status: "processing",
    total: 450.0,
    currency: "USD",
    items: ["Enterprise seat upgrade"],
    created_at: "2026-06-10T07:15:00Z",
  },
];

let ticketSeq = 9000;
const tickets = [];

function nextTicketId() {
  ticketSeq += 1;
  return `tkt_${ticketSeq}`;
}

module.exports = { customers, orders, tickets, nextTicketId };

# Tools layer (CRM / support webhooks)

Third-party-style tools the Nights Watch agent will learn to call. For local demos, run the **mock server** (no n8n cloud required). Optional n8n workflow JSON under `../n8n-workflows/` mirrors the same webhook paths if you prefer n8n.

## Start the mock server

```bash
npm run tools
# or: npm run mock-server
```

Listens on **http://localhost:5678** (`PORT` env overrides).

Health check: `GET http://localhost:5678/health`

All tools are **POST** with `Content-Type: application/json`. Paths work as `/webhook/<tool>` (n8n-style) or `/<tool>`.

---

## Critical dependency: `customer_id`

| Tool | Needs `customer_id`? | Notes |
|------|----------------------|--------|
| `search_customers` | No — finds candidates | May return **multiple / ambiguous** matches (e.g. two "Jordan Lee") |
| `get_customer` | **Yes** | Fails clearly if missing |
| `list_orders` | **Yes** (required) | Without it: hard error **or** unscoped/useless orders — agent must resolve customer first |
| `get_order` | Needs `order_id` | Occasional slow response |
| `create_ticket` | **Yes** | Occasional HTTP 429 rate limit |

Typical flow: `search_customers` → disambiguate → `get_customer` → `list_orders` / `create_ticket`.

---

## Endpoints

### 1. `search_customers`

**POST** `/webhook/search_customers`  
Body: `{ "query": "string" }`

Returns 0–N matches. Same display name can map to different `customer_id`s. Sometimes truncated or fuzzy results.

```bash
curl -s -X POST http://localhost:5678/webhook/search_customers \
  -H "Content-Type: application/json" \
  -d "{\"query\": \"Jordan Lee\"}"
```

### 2. `get_customer`

**POST** `/webhook/get_customer`  
Body: `{ "customer_id": "cust_1001" }`

Fails with `missing_customer_id` if omitted; `customer_not_found` if unknown.

```bash
curl -s -X POST http://localhost:5678/webhook/get_customer \
  -H "Content-Type: application/json" \
  -d "{\"customer_id\": \"cust_1001\"}"
```

### 3. `list_orders`

**POST** `/webhook/list_orders`  
Body: `{ "customer_id": "cust_1001" }`

**Requires** a real `customer_id` from search/get. Calling without it is the classic failure mode the agent must learn.

```bash
# Correct
curl -s -X POST http://localhost:5678/webhook/list_orders \
  -H "Content-Type: application/json" \
  -d "{\"customer_id\": \"cust_1001\"}"

# Wrong — error or unscoped junk
curl -s -X POST http://localhost:5678/webhook/list_orders \
  -H "Content-Type: application/json" \
  -d "{}"
```

### 4. `get_order`

**POST** `/webhook/get_order`  
Body: `{ "order_id": "ord_5001" }`

Fails if `order_id` missing. ~30% of calls add ~2–4s latency.

```bash
curl -s -X POST http://localhost:5678/webhook/get_order \
  -H "Content-Type: application/json" \
  -d "{\"order_id\": \"ord_5001\"}"
```

### 5. `create_ticket`

**POST** `/webhook/create_ticket`  
Body: `{ "customer_id": "cust_1001", "subject": "...", "body": "..." }`

Requires `customer_id` + non-empty `subject`/`body`. ~20% of calls return **429** `rate_limited` with `retry_after_seconds`.

```bash
curl -s -X POST http://localhost:5678/webhook/create_ticket \
  -H "Content-Type: application/json" \
  -d "{\"customer_id\": \"cust_1001\", \"subject\": \"Late shipment\", \"body\": \"Order ord_5001 still not here.\"}"
```

---

## Seed data (cheat sheet)

Ambiguous names: **Jordan Lee** (`cust_1001`, `cust_1002`), **Sam Rivera** (`cust_1003`, `cust_1004`), **Alex Chen** (`cust_1005`, `cust_1006`).

Example orders: `ord_5001`/`ord_5002` → `cust_1001`; `ord_5003` → `cust_1002`.

---

## n8n (optional)

Import JSON from `n8n-workflows/` into n8n. Webhook paths match `/webhook/<tool_name>`. For hackathon demos, prefer `npm run tools` so you are not blocked on n8n cloud.

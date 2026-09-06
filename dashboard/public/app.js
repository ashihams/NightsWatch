/* Loop demo dashboard — cyberpunk UI + live demo runner. */

const POLL_MS = 3000;
const MAX_CONSOLE_LINES = 220;

function el(id) {
  return document.getElementById(id);
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function panelBody(html) {
  return `<div class="panel-body">${html}</div>`;
}

function emptyHtml(hint) {
  return panelBody(
    `<div class="empty"><span class="prompt">&gt;</span> ${esc(hint || "No data yet.")}<br /><br /><span class="prompt">&gt;</span> click <code>RUN DEMO</code> (needs n8n/tools on :5678)</div>`,
  );
}

function badge(ok, label) {
  return `<span class="badge ${ok ? "ok" : "bad"}">${esc(label)}</span>`;
}

function keepTerminalBar(panel) {
  const bar = panel.querySelector(".terminal-bar");
  return bar ? bar.outerHTML : "";
}

function setRunningUi(running, phase) {
  const btn = el("run-demo");
  const chip = el("phase-chip");
  if (btn) {
    btn.disabled = Boolean(running);
    btn.textContent = running ? "RUNNING…" : "RUN DEMO";
  }
  if (chip) {
    chip.textContent = (phase || (running ? "RUNNING" : "IDLE")).toUpperCase();
    chip.classList.toggle("chip-mag", !running);
  }
  document.querySelectorAll(".phase").forEach((node) => {
    const p = node.getAttribute("data-phase");
    node.classList.toggle("active", Boolean(phase) && p === phase);
    const order = ["boot", "seen_a", "seen_b", "unseen", "done"];
    const pi = order.indexOf(phase || "");
    const ni = order.indexOf(p);
    node.classList.toggle("done", pi >= 0 && ni >= 0 && ni < pi);
  });
}

function appendConsole(evt) {
  const box = el("live-console");
  if (!box) return;
  if (box.dataset.waiting === "1") {
    box.textContent = "";
    box.dataset.waiting = "0";
  }
  const parsed = evt.parsed;
  let cls = "";
  if (evt.stream === "system") cls = "line-sys";
  else if (evt.stream === "stderr") cls = "line-err";
  else if (
    parsed &&
    (parsed.type === "replay_row" ||
      parsed.type === "semantic_memory_upsert" ||
      parsed.type === "replay_demo_ok" ||
      parsed.type === "tool_call")
  ) {
    cls = "line-hit";
  }

  let text = evt.line;
  if (parsed?.type === "replay_scenario") {
    text = `▶ scenario ${parsed.label}: ${parsed.task || ""}`;
  } else if (parsed?.type === "replay_row") {
    text = `✓ ${parsed.label} success=${parsed.success} fail=${parsed.failed_tool_calls} lessons=${parsed.lessons_retrieved} first=${parsed.first_tool}`;
  } else if (parsed?.type === "tool_call") {
    text = `  tool ${parsed.name} ok=${parsed.ok} status=${parsed.status}`;
  } else if (parsed?.type === "semantic_memory_upsert") {
    text = `  memory ${parsed.stage} ${parsed.lesson_id} evidence=${parsed.evidence_count} backend=${parsed.backend}`;
  } else if (parsed?.type === "replay_demo_ok") {
    text = `✔ demo ok signals=${JSON.stringify(parsed.signals_passed || [])}`;
  }

  const line = document.createElement("div");
  if (cls) line.className = cls;
  line.textContent = text;
  box.appendChild(line);
  while (box.childNodes.length > MAX_CONSOLE_LINES) {
    box.removeChild(box.firstChild);
  }
  box.scrollTop = box.scrollHeight;
}

function clearConsole() {
  const box = el("live-console");
  if (!box) return;
  box.textContent = "";
  box.dataset.waiting = "0";
  const boot = document.createElement("div");
  boot.className = "line-sys";
  boot.textContent = "> spawning replay:demo…";
  box.appendChild(boot);
}

function renderStack(data) {
  const panel = el("stack-panel");
  const bar = keepTerminalBar(panel);
  if (!data) {
    panel.innerHTML = bar + emptyHtml("Stack status unavailable.");
    return;
  }

  const tools = data.tools_crm || {};
  const neo = data.neo4j || {};
  const emb = data.embeddings || {};
  const epi = data.episodic || {};
  const tm = data.tensormux || {};
  const otel = data.open_telemetry || {};
  const demo = data.demo || {};
  // Prefer authoritative server status for the button (don't leave RUNNING stuck).
  if (typeof demo.running === "boolean") {
    demoRunActive = Boolean(demo.running);
    setRunningUi(demoRunActive, demo.phase || (demoRunActive ? "running" : "idle"));
  }

  panel.innerHTML =
    bar +
    panelBody(`<div class="stack-grid">
    <div class="stack-card">
      <div class="stack-label">Tools / CRM</div>
      <div>${badge(tools.ok, tools.ok ? tools.kind || "up" : "down")}</div>
      <p class="meta mono">${esc(tools.base_url)}</p>
      <p class="meta">${esc(tools.note || "")}</p>
    </div>
    <div class="stack-card">
      <div class="stack-label">Neo4j</div>
      <div>${badge(Boolean(neo.configured && neo.ok !== false), neo.configured ? (neo.ok === false ? "error" : "aura") : "fallback")}</div>
      <p class="meta mono">${esc(neo.uri || neo.fallback_path || "—")}</p>
      <p class="meta">lessons · <span class="mono">${esc(neo.lesson_backend || "—")}</span></p>
    </div>
    <div class="stack-card">
      <div class="stack-label">Embeddings</div>
      <div>${badge(emb.api_configured || emb.ollama_enabled, emb.model || "offline")}</div>
      <p class="meta mono">${esc(emb.base_url || "hash / ollama auto")}</p>
      <p class="meta">episodic rows · <span class="mono">${esc(epi.recent_count)}</span></p>
    </div>
    <div class="stack-card">
      <div class="stack-label">OpenTelemetry</div>
      <div>${badge(otel.configured, otel.configured ? "neatlogs" : "off")}</div>
      <p class="meta mono">${esc(otel.endpoint || "—")}</p>
      <p class="meta">${esc(otel.note || "")}</p>
    </div>
    <div class="stack-card">
      <div class="stack-label">TensorMux</div>
      <div>${badge(tm.configured, tm.configured ? tm.model || "on" : "offline planner")}</div>
      <p class="meta mono">${esc(tm.base_url || "—")}</p>
    </div>
  </div>`);
}

function renderTrajectory(data) {
  const panel = el("trajectory-panel");
  const bar = keepTerminalBar(panel);
  if (!data || data.empty || !data.rows || data.rows.length === 0) {
    panel.innerHTML = bar + emptyHtml(data && data.hint);
    return;
  }

  const rows = data.rows
    .map((r) => {
      const ok = r.success;
      return `<tr>
        <td class="mono">${esc(r.label)}</td>
        <td><span class="badge ${ok ? "ok" : "bad"}">${ok ? "success" : "fail"}</span></td>
        <td class="mono">${esc(r.tool_call_count)}</td>
        <td class="mono">${esc(r.failed_tool_calls)}</td>
        <td class="mono">${esc(r.latency_ms)}</td>
        <td class="mono">${esc(r.lessons_retrieved ?? "—")}</td>
        <td class="mono">${esc(r.run_id)}</td>
        <td class="mono">${esc((r.tool_sequence || []).join(" → ") || "—")}</td>
      </tr>`;
    })
    .join("");

  const updated = data.updated_at
    ? `<p class="meta mono"><span class="prompt">&gt;</span> updated ${esc(data.updated_at)}</p>`
    : "";

  panel.innerHTML =
    bar +
    panelBody(`${updated}<div style="overflow-x:auto"><table>
    <thead>
      <tr>
        <th>label</th>
        <th>success</th>
        <th>tools</th>
        <th>failed</th>
        <th>latency</th>
        <th>lessons</th>
        <th>run_id</th>
        <th>sequence</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table></div>`);
}

function lessonCard(l, pending) {
  const factors = (l.factors || [])
    .map((f) => `<span class="factor">${esc(f)}</span>`)
    .join("");
  const runs = (l.supporting_run_ids || []).map(esc).join(", ") || "—";
  return `<article class="lesson">
    <h3><span class="prompt">&gt;</span> ${esc(l.text)}</h3>
    <p class="meta">
      <span class="badge ${pending ? "pending" : "ok"}">${pending ? "pending" : "usable"}</span>
      <span class="badge ${l.backend === "neo4j" ? "ok" : "pending"}">${esc(l.backend || "?")}</span>
      · tool <span class="mono">${esc(l.tool)}</span>
      · evidence <span class="mono">${esc(l.evidence_count)}</span>
      · conf <span class="mono">${esc(l.confidence)}</span>
      · id <span class="mono">${esc(l.id)}</span>
    </p>
    <p class="meta">runs · <span class="mono">${runs}</span></p>
    <div class="factors">${factors}</div>
  </article>`;
}

function renderLessons(data) {
  const panel = el("lessons-panel");
  if (!data || data.empty) {
    panel.innerHTML = emptyHtml(data && data.hint);
    return;
  }

  const usable = data.usable || [];
  const pending = data.pending || [];
  let html = `<p class="meta"><span class="prompt">&gt;</span> store <span class="mono">${esc(data.backend)}</span>${data.neo4j_configured ? " · neo4j live" : ""}</p>`;

  html += `<div class="group-title">Usable (${usable.length})</div>`;
  if (usable.length === 0) {
    html += `<div class="empty"><span class="prompt">&gt;</span> no usable lessons yet (need evidence ≥ 2)</div>`;
  } else {
    html += usable.map((l) => lessonCard(l, false)).join("");
  }

  html += `<div class="group-title">Pending (${pending.length})</div>`;
  if (pending.length === 0) {
    html += `<div class="empty"><span class="prompt">&gt;</span> no pending candidates</div>`;
  } else {
    html += pending.map((l) => lessonCard(l, true)).join("");
  }

  panel.innerHTML = panelBody(html);
}

let demoRunActive = false;
let eventSource = null;

async function syncDemoStatus() {
  try {
    const res = await fetch("/api/demo/status");
    if (!res.ok) return;
    const s = await res.json();
    demoRunActive = Boolean(s.running);
    setRunningUi(demoRunActive, s.phase || (demoRunActive ? "running" : "idle"));
  } catch {
    // ignore
  }
}

function ensureEventSource() {
  if (eventSource) return;
  eventSource = new EventSource("/api/demo/events");
  eventSource.addEventListener("hello", (msg) => {
    try {
      const s = JSON.parse(msg.data);
      demoRunActive = Boolean(s.running);
      setRunningUi(demoRunActive, s.phase || (demoRunActive ? "running" : "idle"));
    } catch {
      // ignore
    }
  });
  eventSource.onmessage = (msg) => {
    try {
      const evt = JSON.parse(msg.data);
      appendConsole(evt);
      // Only advance phase UI when a run is actually active (ignore SSE history replay).
      if (!demoRunActive) return;
      if (evt.parsed?.type === "replay_scenario" && evt.parsed.label) {
        setRunningUi(true, evt.parsed.label);
      } else if (evt.parsed?.type === "replay_demo_start") {
        setRunningUi(true, "boot");
      } else if (evt.parsed?.type === "replay_demo_ok") {
        setRunningUi(true, "done");
      }
    } catch {
      // ignore
    }
  };
  eventSource.addEventListener("done", (msg) => {
    demoRunActive = false;
    try {
      const data = JSON.parse(msg.data);
      setRunningUi(false, data.phase || (data.exit_code === 0 ? "done" : "failed"));
    } catch {
      setRunningUi(false, "done");
    }
    refresh();
  });
  eventSource.onerror = () => {
    // browser will retry; keep UI usable
  };
}

async function startDemo() {
  clearConsole();
  demoRunActive = true;
  setRunningUi(true, "starting");
  const status = el("status");
  try {
    const res = await fetch("/api/demo/run", { method: "POST" });
    const ctype = res.headers.get("content-type") || "";
    if (ctype.includes("text/event-stream") && res.body) {
      // Vercel / inline offline: stream lives on the POST response.
      await consumeDemoStream(res.body);
      return;
    }
    ensureEventSource();
    const body = await res.json();
    if (!res.ok) {
      demoRunActive = false;
      setRunningUi(false, "idle");
      appendConsole({
        stream: "system",
        line: `> failed: ${body.error || res.status}`,
      });
      if (status) status.textContent = `// err ${body.error || res.status}`;
      return;
    }
    if (status) status.textContent = "// demo running";
  } catch (err) {
    demoRunActive = false;
    setRunningUi(false, "idle");
    appendConsole({
      stream: "system",
      line: `> failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

async function consumeDemoStream(body) {
  const status = el("status");
  if (status) status.textContent = "// demo running (inline)";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop() || "";
    for (const block of parts) {
      handleSseBlock(block);
    }
  }
  if (buf.trim()) handleSseBlock(buf);
  demoRunActive = false;
  refresh();
}

function handleSseBlock(block) {
  const lines = block.split("\n");
  let eventName = "message";
  let data = "";
  for (const line of lines) {
    if (line.startsWith("event:")) eventName = line.slice(6).trim();
    else if (line.startsWith("data:")) data += line.slice(5).trim();
  }
  if (!data) return;
  try {
    const payload = JSON.parse(data);
    if (eventName === "hello") {
      demoRunActive = Boolean(payload.running);
      setRunningUi(demoRunActive, payload.phase || "boot");
      return;
    }
    if (eventName === "done") {
      demoRunActive = false;
      setRunningUi(false, payload.phase || (payload.exit_code === 0 ? "done" : "failed"));
      if (payload.trajectory?.rows) {
        try {
          sessionStorage.setItem(
            "loop_last_trajectory",
            JSON.stringify(payload.trajectory),
          );
        } catch {
          // ignore
        }
        renderTrajectory({
          empty: false,
          hint: null,
          updated_at: payload.trajectory.updated_at,
          rows: payload.trajectory.rows,
        });
      }
      return;
    }
    appendConsole(payload);
    if (!demoRunActive) return;
    if (payload.parsed?.type === "replay_scenario" && payload.parsed.label) {
      setRunningUi(true, payload.parsed.label);
    } else if (payload.parsed?.type === "replay_demo_start") {
      setRunningUi(true, "boot");
    } else if (payload.parsed?.type === "replay_demo_ok") {
      setRunningUi(true, "done");
    }
  } catch {
    // ignore
  }
}

async function refresh() {
  const status = el("status");
  try {
    const [trajRes, lessonsRes, stackRes] = await Promise.all([
      fetch("/api/trajectory"),
      fetch("/api/lessons"),
      fetch("/api/stack"),
    ]);
    if (!trajRes.ok || !lessonsRes.ok || !stackRes.ok) {
      throw new Error(`HTTP ${trajRes.status}/${lessonsRes.status}/${stackRes.status}`);
    }
    const traj = await trajRes.json();
    const lessons = await lessonsRes.json();
    const stack = await stackRes.json();
    renderStack(stack);
    let trajView = traj;
    try {
      const cached = sessionStorage.getItem("loop_last_trajectory");
      if (cached && (traj.empty || !traj.rows?.length)) {
        trajView = { empty: false, hint: null, ...JSON.parse(cached) };
      } else if (cached) {
        const c = JSON.parse(cached);
        if (
          c.updated_at &&
          traj.updated_at &&
          Date.parse(c.updated_at) > Date.parse(traj.updated_at)
        ) {
          trajView = { empty: false, hint: null, ...c };
        }
      }
    } catch {
      // ignore
    }
    renderTrajectory(trajView);
    renderLessons(lessons);
    if (!demoRunActive && status) {
      status.textContent = `// sync ${new Date().toLocaleTimeString()}`;
    }
  } catch (err) {
    if (status) {
      status.textContent = `// err ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

const runBtn = el("run-demo");
if (runBtn) {
  runBtn.addEventListener("click", () => {
    startDemo();
  });
}

const live = el("live-console");
if (live) live.dataset.waiting = "1";

ensureEventSource();
syncDemoStatus();
refresh();
setInterval(refresh, POLL_MS);

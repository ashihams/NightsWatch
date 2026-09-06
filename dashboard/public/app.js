/* Nights Watch demo dashboard — poll read APIs every few seconds. */

const POLL_MS = 3000;

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

function emptyHtml(hint) {
  return `<div class="empty">${esc(hint || "No data yet.")}<br /><br />Hint: run <code>npm run replay:demo</code> (with <code>npm run tools</code> on :5678).</div>`;
}

function renderTrajectory(data) {
  const panel = el("trajectory-panel");
  if (!data || data.empty || !data.rows || data.rows.length === 0) {
    panel.innerHTML = emptyHtml(data && data.hint);
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
        <td class="mono">${esc(r.run_id)}</td>
        <td class="mono">${esc((r.tool_sequence || []).join(" → ") || "—")}</td>
      </tr>`;
    })
    .join("");

  const updated = data.updated_at
    ? `<p class="meta mono">updated ${esc(data.updated_at)}</p>`
    : "";

  panel.innerHTML = `${updated}<table>
    <thead>
      <tr>
        <th>label</th>
        <th>success</th>
        <th>tool_call_count</th>
        <th>failed_tool_calls</th>
        <th>latency_ms</th>
        <th>run_id</th>
        <th>tools</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function lessonCard(l, pending) {
  const factors = (l.factors || [])
    .map((f) => `<span class="factor">${esc(f)}</span>`)
    .join("");
  const runs = (l.supporting_run_ids || []).map(esc).join(", ") || "—";
  return `<article class="lesson">
    <h3>${esc(l.text)}</h3>
    <p class="meta">
      <span class="badge ${pending ? "pending" : "ok"}">${pending ? "pending" : "usable"}</span>
      · tool <span class="mono">${esc(l.tool)}</span>
      · evidence <span class="mono">${esc(l.evidence_count)}</span>
      · confidence <span class="mono">${esc(l.confidence)}</span>
      · id <span class="mono">${esc(l.id)}</span>
    </p>
    <p class="meta">supporting runs: <span class="mono">${runs}</span></p>
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
  let html = "";

  html += `<div class="group-title">Usable (${usable.length})</div>`;
  if (usable.length === 0) {
    html += `<div class="empty">No usable lessons yet (need evidence_count ≥ 2).</div>`;
  } else {
    html += usable.map((l) => lessonCard(l, false)).join("");
  }

  html += `<div class="group-title">Pending (${pending.length})</div>`;
  if (pending.length === 0) {
    html += `<div class="empty">No pending candidates.</div>`;
  } else {
    html += pending.map((l) => lessonCard(l, true)).join("");
  }

  panel.innerHTML = html;
}

async function refresh() {
  const status = el("status");
  try {
    const [trajRes, lessonsRes] = await Promise.all([
      fetch("/api/trajectory"),
      fetch("/api/lessons"),
    ]);
    if (!trajRes.ok || !lessonsRes.ok) {
      throw new Error(`HTTP ${trajRes.status}/${lessonsRes.status}`);
    }
    const traj = await trajRes.json();
    const lessons = await lessonsRes.json();
    renderTrajectory(traj);
    renderLessons(lessons);
    status.textContent = `refreshed ${new Date().toLocaleTimeString()}`;
  } catch (err) {
    status.textContent = `error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

refresh();
setInterval(refresh, POLL_MS);

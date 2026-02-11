function escapeHtmlTS(str: string): string {
  return str.replace(/[&<>"']/g, (m) => {
    switch (m) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case "\"": return "&quot;";
      case "'": return "&#39;";
      default: return m;
    }
  });
}

export function renderViewerHtml(sessionId: string, wsBaseUrl: string): string {
  const safeSessionId = escapeHtmlTS(sessionId);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Live Telemetry Viewer</title>
  <style>
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 16px; }
    .card { border: 1px solid #ddd; border-radius: 10px; padding: 12px; margin-top: 12px; }
    .kv { display: grid; grid-template-columns: 160px 1fr; gap: 6px 10px; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; background: #eee; }
    canvas { width: 100%; height: 260px; border: 1px solid #ddd; border-radius: 10px; background: #fff; }
    .small { color: #555; font-size: 0.9em; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace; }
  </style>
</head>
<body>
  <h1>Live Telemetry Viewer</h1>

  <div class="card">
    <div class="kv">
      <div><strong>Session</strong></div><div class="mono">${safeSessionId}</div>
      <div><strong>Status</strong></div><div><span id="status" class="badge">connecting</span></div>
      <div><strong>Latest GPS UTC</strong></div><div class="mono" id="latestTime">—</div>
      <div><strong>Latest seq</strong></div><div class="mono" id="latestSeq">—</div>
      <div><strong>Viewer settings</strong></div>
      <div class="small">Window: 30s • Playout delay: 0.7s • Charts: Accel (m/s²) & Gyro (rad/s)</div>
    </div>
  </div>

  <div class="card">
    <h2>Acceleration (m/s²)</h2>
    <canvas id="accelCanvas" width="1200" height="300"></canvas>
    <div class="small">Ax, Ay, Az vs time (last 30 seconds, displayed with 0.7s delay)</div>
  </div>

  <div class="card">
    <h2>Gyroscope (rad/s)</h2>
    <canvas id="gyroCanvas" width="1200" height="300"></canvas>
    <div class="small">Gx, Gy, Gz vs time (last 30 seconds, displayed with 0.7s delay)</div>
  </div>

  <script>
    // Fixed parameters
    const SESSION_ID = ${JSON.stringify(sessionId)};
    const WS_URL = ${JSON.stringify(wsBaseUrl)} + "/live/" + encodeURIComponent(SESSION_ID);
    const WINDOW_MS = 30000;
    const PLAYOUT_DELAY_MS = 700;

    // Buffer: { t_gps_utc, seq, accel_mps2:{x,y,z}, gyro_rads:{x,y,z}, t_ms }
    let buffer = [];
    let latestReceivedMs = -Infinity;
    let latestSeq = null;

    const statusEl = document.getElementById("status");
    const latestTimeEl = document.getElementById("latestTime");
    const latestSeqEl = document.getElementById("latestSeq");

    function setStatus(text) { statusEl.textContent = text; }

    function parseAndAppendSamples(samples) {
      for (const s of samples) {
        const t_ms = Date.parse(s.t_gps_utc);
        if (!Number.isFinite(t_ms)) continue;
        buffer.push({ ...s, t_ms });
        if (t_ms > latestReceivedMs) latestReceivedMs = t_ms;
        if (typeof s.seq === "number") latestSeq = s.seq;
      }

      buffer.sort((a, b) => a.t_ms - b.t_ms);

      const cutoff = latestReceivedMs - WINDOW_MS;
      buffer = buffer.filter(s => s.t_ms >= cutoff);

      if (Number.isFinite(latestReceivedMs)) {
        latestTimeEl.textContent = new Date(latestReceivedMs).toISOString();
      }
      if (latestSeq !== null) {
        latestSeqEl.textContent = String(latestSeq);
      }
    }

    // WebSocket connect
    function connect() {
      setStatus("connecting");
      const ws = new WebSocket(WS_URL);

      ws.onopen = () => setStatus("connected");
      ws.onclose = () => { setStatus("disconnected"); setTimeout(connect, 1000); };
      ws.onerror = () => setStatus("error");

      ws.onmessage = (evt) => {
        let msg;
        try { msg = JSON.parse(evt.data); } catch { return; }

        if (msg.type === "replay" && Array.isArray(msg.samples)) {
          parseAndAppendSamples(msg.samples);
        }
        if (msg.type === "samples" && Array.isArray(msg.samples)) {
          parseAndAppendSamples(msg.samples);
        }
      };
    }
    connect();

    // Canvas chart helper
    function drawChart(canvas, seriesDefs, titleRightText) {
      const ctx = canvas.getContext("2d");
      const w = canvas.width, h = canvas.height;

      const playoutNow = latestReceivedMs - PLAYOUT_DELAY_MS;
      if (!Number.isFinite(playoutNow)) {
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = "#000";
        ctx.font = "14px system-ui, sans-serif";
        ctx.fillText("Waiting for data...", 20, 30);
        return;
      }

      const tMin = playoutNow - WINDOW_MS;
      const tMax = playoutNow;

      const windowSamples = buffer.filter(s => s.t_ms >= tMin && s.t_ms <= tMax);

      let yMin = Infinity, yMax = -Infinity;
      for (const s of windowSamples) {
        for (const def of seriesDefs) {
          const v = def.getValue(s);
          if (Number.isFinite(v)) { yMin = Math.min(yMin, v); yMax = Math.max(yMax, v); }
        }
      }

      ctx.clearRect(0, 0, w, h);
      if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) {
        ctx.fillStyle = "#000";
        ctx.font = "14px system-ui, sans-serif";
        ctx.fillText("No samples in window...", 20, 30);
        return;
      }

      const pad = (yMax - yMin) * 0.1 || 1;
      yMin -= pad; yMax += pad;

      const xOf = (t) => ((t - tMin) / (tMax - tMin)) * (w - 60) + 50;
      const yOf = (v) => h - 30 - ((v - yMin) / (yMax - yMin)) * (h - 60);

      // Axes
      ctx.strokeStyle = "#999";
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(50, 20); ctx.lineTo(50, h - 30); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(50, h - 30); ctx.lineTo(w - 10, h - 30); ctx.stroke();

      // Labels
      ctx.fillStyle = "#000";
      ctx.font = "12px system-ui, sans-serif";
      ctx.fillText(yMax.toFixed(2), 5, 24);
      ctx.fillText(yMin.toFixed(2), 5, h - 32);

      ctx.fillStyle = "#333";
      ctx.fillText(titleRightText, w - 360, 16);

      // Series
      for (const def of seriesDefs) {
        ctx.strokeStyle = def.color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        let started = false;
        for (const s of windowSamples) {
          const v = def.getValue(s);
          if (!Number.isFinite(v)) continue;
          const x = xOf(s.t_ms), y = yOf(v);
          if (!started) { ctx.moveTo(x, y); started = true; }
          else ctx.lineTo(x, y);
        }
        ctx.stroke();

        ctx.fillStyle = def.color;
        ctx.fillText(def.label, w - 120, def.legendY);
      }
    }

    const accelCanvas = document.getElementById("accelCanvas");
    const gyroCanvas = document.getElementById("gyroCanvas");

    const accelSeries = [
      { label: "Ax", color: "#d32f2f", legendY: 40, getValue: (s) => s.accel_mps2?.x },
      { label: "Ay", color: "#1976d2", legendY: 58, getValue: (s) => s.accel_mps2?.y },
      { label: "Az", color: "#388e3c", legendY: 76, getValue: (s) => s.accel_mps2?.z }
    ];

    const gyroSeries = [
      { label: "Gx", color: "#d32f2f", legendY: 40, getValue: (s) => s.gyro_rads?.x },
      { label: "Gy", color: "#1976d2", legendY: 58, getValue: (s) => s.gyro_rads?.y },
      { label: "Gz", color: "#388e3c", legendY: 76, getValue: (s) => s.gyro_rads?.z }
    ];

    function loop() {
      const rightText = Number.isFinite(latestReceivedMs)
        ? ("Display time: " + new Date(latestReceivedMs - PLAYOUT_DELAY_MS).toISOString())
        : "Display time: —";

      drawChart(accelCanvas, accelSeries, rightText);
      drawChart(gyroCanvas, gyroSeries, rightText);

      requestAnimationFrame(loop);
    }
    loop();
  </script>
</body>
</html>`;
}

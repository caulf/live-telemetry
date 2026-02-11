import { DurableObject } from "cloudflare:workers";
import { renderHtml } from "./renderHtml";

export interface Env {
  DB: D1Database;
  LIVE_ROOMS: DurableObjectNamespace<LiveRoom>;
  TELEMETRY_BEARER_TOKEN: string;
}

/**
 * Telemetry contract (fixed for this project):
 * - One POST per ~0.7s containing ~14 samples (20 Hz effective).
 * - Each sample has GPS UTC timestamp + seq + accel + gyro.
 */
type TelemetryBatch = {
  session_id: string;
  device_id: string;
  samples: Array<{
    t_gps_utc: string; // ISO 8601 UTC, e.g. 2026-02-11T12:34:56.123Z
    seq: number;
    accel_mps2: { x: number; y: number; z: number };
    gyro_rads: { x: number; y: number; z: number };
  }>;
};

type BufferedSample = TelemetryBatch["samples"][number] & { t_ms: number };

export class LiveRoom extends DurableObject<Env> {
  // In-memory ring buffer (last 30 seconds of samples)
  private buffer: BufferedSample[] = [];

  // Keep sockets in memory for broadcast. On restart, clients reconnect.
  private sockets: Set<WebSocket> = new Set();

  private readonly WINDOW_MS = 30_000;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  private pruneBuffer(latestTsMs: number) {
    const cutoff = latestTsMs - this.WINDOW_MS;
    // buffer is mostly time-ordered; simple filter is fine at this size
    this.buffer = this.buffer.filter((s) => s.t_ms >= cutoff);
  }

  private broadcast(obj: unknown) {
    const msg = JSON.stringify(obj);
    for (const ws of this.sockets) {
      try {
        ws.send(msg);
      } catch {
        // ignore; cleanup happens on close
      }
    }
  }

  private acceptViewerWebSocket(): Response {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    server.accept();
    this.sockets.add(server);

    // Send replay immediately (last 30s)
    server.send(
      JSON.stringify({
        type: "replay",
        window_ms: this.WINDOW_MS,
        samples: this.buffer.map(({ t_ms, ...rest }) => rest),
      })
    );

    server.addEventListener("close", () => {
      this.sockets.delete(server);
    });

    server.addEventListener("error", () => {
      this.sockets.delete(server);
      try {
        server.close();
      } catch {}
    });

    // Viewers don't need to send anything for now; ignore messages.
    server.addEventListener("message", () => {});

    return new Response(null, { status: 101, webSocket: client });
  }

  private async handleIngest(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    let batch: TelemetryBatch;
    try {
      batch = (await request.json()) as TelemetryBatch;
    } catch {
      return new Response("Bad JSON", { status: 400 });
    }

    if (!batch?.samples?.length) {
      return new Response("Missing samples", { status: 400 });
    }

    // Parse and append samples
    let latest = -Infinity;
    const newBuffered: BufferedSample[] = [];
    for (const s of batch.samples) {
      const t_ms = Date.parse(s.t_gps_utc);
      if (!Number.isFinite(t_ms)) continue;
      latest = Math.max(latest, t_ms);
      newBuffered.push({ ...s, t_ms });
    }

    if (!newBuffered.length) {
      return new Response("No valid timestamps", { status: 400 });
    }

    // Append then prune to last 30 seconds (based on latest received time)
    this.buffer.push(...newBuffered);
    this.pruneBuffer(latest);

    // Broadcast new samples to viewers (send only the new samples)
    this.broadcast({
      type: "samples",
      session_id: batch.session_id,
      device_id: batch.device_id,
      samples: newBuffered.map(({ t_ms, ...rest }) => rest),
    });

    return new Response(JSON.stringify({ ok: true, received: newBuffered.length }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Viewer WS: any request with Upgrade: websocket
    const upgrade = request.headers.get("Upgrade");
    if (upgrade && upgrade.toLowerCase() === "websocket") {
      return this.acceptViewerWebSocket();
    }

    // Ingest endpoint inside the DO
    if (url.pathname === "/ingest") {
      return this.handleIngest(request);
    }

    return new Response("Not Found", { status: 404 });
  }
}

function bearerOk(request: Request, token: string): boolean {
  const auth = request.headers.get("Authorization") || "";
  return auth === `Bearer ${token}`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Existing DO wiring test
    if (url.pathname.startsWith("/__do_test/")) {
      const sessionId = url.pathname.split("/")[2] || "demo-session";
      const stub = env.LIVE_ROOMS.getByName(sessionId);
      return stub.fetch("https://do.test/");
    }

    // ✅ Viewer endpoint: WebSocket
    // GET /live/<sessionId>
    if (url.pathname.startsWith("/live/")) {
      const sessionId = url.pathname.split("/")[2] || "demo-session";
      const stub = env.LIVE_ROOMS.getByName(sessionId);
      // forward the request to DO (includes Upgrade headers)
      return stub.fetch(request);
    }

    // ✅ Ingest endpoint: Bearer-protected POST
    // POST /telemetry/<sessionId>
    if (url.pathname.startsWith("/telemetry/")) {
      if (!bearerOk(request, env.TELEMETRY_BEARER_TOKEN)) {
        return new Response("Unauthorized", { status: 401 });
      }

      const sessionId = url.pathname.split("/")[2] || "demo-session";
      const stub = env.LIVE_ROOMS.getByName(sessionId);

      // Forward body into the DO /ingest handler
      const forward = new Request("https://do.room/ingest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: request.body,
      });

      return stub.fetch(forward);
    }

    // Keep your original D1 template page at /
    const stmt = env.DB.prepare("SELECT * FROM comments LIMIT 3");
    const { results } = await stmt.all();

    return new Response(renderHtml(JSON.stringify(results, null, 2)), {
      headers: { "content-type": "text/html" },
    });
  },
} satisfies ExportedHandler<Env>;

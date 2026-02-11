import { DurableObject } from "cloudflare:workers";
import { renderHtml } from "./renderHtml";

export interface Env {
	DB: D1Database;
	LIVE_ROOMS: DurableObjectNamespace<LiveRoom>;
	TELEMETRY_BEARER_TOKEN: string;
}

// Durable Object: one instance per sessionId (room)
export class LiveRoom extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
	}

	// For now: simplest possible response to prove the DO is alive.
	async fetch(_request: Request): Promise<Response> {
		return new Response("LiveRoom OK");
	}
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);

		// ✅ Durable Object wiring test endpoint:
		// Visit: /__do_test/<sessionId>
		if (url.pathname.startsWith("/__do_test/")) {
			const sessionId = url.pathname.split("/")[2] || "demo-session";
			const stub = env.LIVE_ROOMS.getByName(sessionId);
			return stub.fetch("https://do.test/");
		}

		// Existing D1 template behaviour (keep for now)
		const stmt = env.DB.prepare("SELECT * FROM comments LIMIT 3");
		const { results } = await stmt.all();

		return new Response(renderHtml(JSON.stringify(results, null, 2)), {
			headers: { "content-type": "text/html" },
		});
	},
} satisfies ExportedHandler<Env>;

const CATALOG_KEY = "publicCatalog:v1";

function jsonResponse(body, status) {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"access-control-allow-origin": "*",
			"access-control-allow-methods": "GET, OPTIONS",
			"access-control-allow-headers": "content-type",
			"cache-control": "no-store",
		},
	});
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);

		if (request.method === "OPTIONS") {
			return jsonResponse({ ok: true }, 200);
		}

		if (request.method !== "GET") {
			return jsonResponse({ error: "Method not allowed" }, 405);
		}

		if (url.pathname !== "/catalog") {
			return jsonResponse({ error: "Not found" }, 404);
		}

		if (!env.PUBLIC_CATALOG_KV) {
			return jsonResponse({ error: "KV binding is not configured" }, 500);
		}

		const catalog = await env.PUBLIC_CATALOG_KV.get(CATALOG_KEY, "text");
		if (!catalog) {
			return jsonResponse({ error: "Catalog is not published" }, 503);
		}

		try {
			const parsed = JSON.parse(catalog);
			if (!Array.isArray(parsed.products) || !Array.isArray(parsed.schools)) {
				throw new Error("Invalid catalog shape");
			}
		} catch (error) {
			return jsonResponse({ error: "Invalid catalog JSON" }, 502);
		}

		return new Response(catalog, {
			status: 200,
			headers: {
				"content-type": "application/json; charset=utf-8",
				"access-control-allow-origin": "*",
				"access-control-allow-methods": "GET, OPTIONS",
				"access-control-allow-headers": "content-type",
				"cache-control": "no-store",
			},
		});
	},
};

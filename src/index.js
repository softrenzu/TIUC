export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      try {
        const { results } = await env.DB.prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        ).all();
        return Response.json({ ok: true, tables: results.map((r) => r.name) });
      } catch (e) {
        return Response.json({ ok: false, error: e.message }, { status: 500 });
      }
    }

    return new Response("クビアカ通報アプリ:準備中", {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
};
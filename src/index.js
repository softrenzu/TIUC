const TEST_PAGE = `<!doctype html>
<html lang="ja"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>R2アップロードテスト</title>
<body style="font-family:system-ui,sans-serif;padding:16px;max-width:480px">
<h1 style="font-size:18px">R2アップロードテスト</h1>
<p><input id="token" type="password" placeholder="管理トークン" style="width:100%;padding:8px;box-sizing:border-box"></p>
<p><input id="file" type="file" accept="image/*" capture="environment"></p>
<p><button id="go" style="padding:10px 16px">アップロード</button></p>
<pre id="out" style="white-space:pre-wrap;font-size:12px"></pre>
<div id="preview"></div>
<script>
document.getElementById('go').onclick = async () => {
  const f = document.getElementById('file').files[0];
  const out = document.getElementById('out');
  if (!f) { out.textContent = 'ファイルを選んでください'; return; }
  out.textContent = 'アップロード中...';
  const res = await fetch('/api/test-upload', {
    method: 'PUT',
    headers: {
      'x-admin-token': document.getElementById('token').value,
      'content-type': f.type
    },
    body: f
  });
  const j = await res.json().catch(() => ({ error: res.status }));
  out.textContent = JSON.stringify(j, null, 2);
  if (j.url) {
    document.getElementById('preview').innerHTML =
      '<img src="' + j.url + '" style="max-width:100%">';
  }
};
</script>
</body></html>`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // --- D1 疎通確認 ---
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

    // --- 画像の配信(R2から取り出してWorkerが返す) ---
    if (url.pathname.startsWith("/img/")) {
      const key = decodeURIComponent(url.pathname.slice(5));
      const obj = await env.PHOTOS.get(key);
      if (!obj) return new Response("not found", { status: 404 });

      const headers = new Headers();
      obj.writeHttpMetadata(headers);
      headers.set("etag", obj.httpEtag);
      headers.set("cache-control", "private, max-age=3600");
      return new Response(obj.body, { headers });
    }

    // --- アップロード動作確認用(公開前に必ず削除する) ---
    if (url.pathname === "/api/test-upload" && request.method === "PUT") {
      if (request.headers.get("x-admin-token") !== env.ADMIN_TOKEN) {
        return new Response("forbidden", { status: 403 });
      }
      const now = new Date();
      const key = `test/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${crypto.randomUUID()}`;
      await env.PHOTOS.put(key, request.body, {
        httpMetadata: {
          contentType: request.headers.get("content-type") || "application/octet-stream",
        },
      });
      return Response.json({ ok: true, key, url: `/img/${key}` });
    }

    // --- テストページ ---
    if (url.pathname === "/test") {
      return new Response(TEST_PAGE, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    return new Response("クビアカ通報アプリ:準備中", {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
};
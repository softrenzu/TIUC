export default {
  async fetch(request, env, ctx) {
    return new Response("クビアカ通報アプリ:準備中", {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
};
// ============================================================
// Signalynx — TwelveData + Claude proxy (Cloudflare Worker)
// Menyimpan API key TwelveData & Anthropic dengan aman di server,
// supaya tidak pernah muncul di kode frontend/browser.
// ============================================================
//
// CARA PAKAI:
// 1. Buka https://dash.cloudflare.com -> daftar/login (gratis).
// 2. Workers & Pages -> Create application -> tab Workers -> Start with Hello World!
// 3. Kasih nama terserah, mis. "signalynx-proxy" -> Deploy.
// 4. Klik "Edit code", hapus semua isi default, tempel isi file ini, lalu Deploy.
// 5. Buka tab Settings -> Variables and Secrets -> Add.
//    Tambah dua secret:
//      - TWELVEDATA_API_KEY   = API key dari twelvedata.com
//      - ANTHROPIC_API_KEY    = API key dari console.anthropic.com
//    Keduanya wajib di-set sebagai Secret (encrypted), bukan plain text.
// 6. Setelah deploy, kamu akan dapat URL seperti:
//    https://signalynx-proxy.<nama-kamu>.workers.dev
// 7. Tempel URL itu ke kolom "Proxy URL" di aplikasi Signalynx.
//
// Worker ini meneruskan dua jenis permintaan:
//   GET  /time_series  -> data candle dari TwelveData
//   POST /narrate      -> narasi analisis dari Claude (Anthropic)
// dan tidak pernah mengekspos API key ke browser.

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    if (url.pathname === "/time_series" && request.method === "GET") {
      return handleTimeSeries(url, env);
    }

    if (url.pathname === "/narrate" && request.method === "POST") {
      return handleNarrate(request, env);
    }

    return json({ error: "Endpoint tidak dikenal. Gunakan /time_series atau /narrate" }, 404);
  },
};

async function handleTimeSeries(url, env) {
  const symbol = url.searchParams.get("symbol");
  const interval = url.searchParams.get("interval") || "1h";
  const outputsize = url.searchParams.get("outputsize") || "100";

  if (!symbol) return json({ error: "Parameter symbol wajib diisi" }, 400);

  const apiKey = env.TWELVEDATA_API_KEY;
  if (!apiKey) return json({ error: "TWELVEDATA_API_KEY belum diset di environment variable Worker" }, 500);

  const upstream = new URL("https://api.twelvedata.com/time_series");
  upstream.searchParams.set("symbol", symbol);
  upstream.searchParams.set("interval", interval);
  upstream.searchParams.set("outputsize", outputsize);
  upstream.searchParams.set("apikey", apiKey);

  try {
    const res = await fetch(upstream.toString());
    const data = await res.json();
    return json(data, res.status);
  } catch (e) {
    return json({ error: "Gagal menghubungi TwelveData", detail: String(e) }, 502);
  }
}

async function handleNarrate(request, env) {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) return json({ error: "ANTHROPIC_API_KEY belum diset di environment variable Worker" }, 500);

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "Body request tidak valid JSON" }, 400);
  }

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1000,
        system: body.system,
        messages: body.messages,
      }),
    });
    const data = await res.json();
    return json(data, res.status);
  } catch (e) {
    return json({ error: "Gagal menghubungi Anthropic", detail: String(e) }, 502);
  }
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}


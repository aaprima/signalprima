import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";

/* ============================================================
   SIGNALYNX — prototype
   Data harga: SIMULASI (deterministik per instrumen)
   Narasi analisis: AI (Claude) beneran, dari angka indikator asli
   ============================================================ */

// ---------------- utils: rng & math ----------------
function hashString(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h << 5) - h + str.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}
function seededRandom(seed) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return function () {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function generateCandles(instrument, basePrice, count, volatility) {
  const rand = seededRandom(hashString(instrument + "|" + count + "|" + Date.now().toString().slice(0, 6)));
  const candles = [];
  let price = basePrice;
  const regime = (rand() - 0.5) * 2; // overall drift bias for this run
  for (let i = 0; i < count; i++) {
    const wave = Math.sin(i / 11 + rand() * 3) * 0.55 + regime * 0.35;
    const noise = (rand() - 0.5) * 0.9;
    const change = (wave + noise) * volatility * basePrice * 0.5;
    const open = price;
    const close = Math.max(open + change, basePrice * 0.4);
    const high = Math.max(open, close) + rand() * volatility * basePrice * 0.45;
    const low = Math.min(open, close) - rand() * volatility * basePrice * 0.45;
    candles.push({ i, open, high, low, close });
    price = close;
  }
  return candles;
}

function ema(values, period) {
  const k = 2 / (period + 1);
  const out = [];
  let prev;
  values.forEach((v, i) => {
    const e = i === 0 ? v : v * k + prev * (1 - k);
    out.push(e);
    prev = e;
  });
  return out;
}

function rsi(values, period = 14) {
  const out = new Array(Math.min(period, values.length)).fill(50);
  let avgGain = 0,
    avgLoss = 0;
  for (let i = 1; i <= period && i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) avgGain += diff;
    else avgLoss -= diff;
  }
  avgGain /= period;
  avgLoss /= period;
  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    out.push(100 - 100 / (1 + rs));
  }
  return out;
}

function atr(candles, period = 14) {
  const trs = candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const pc = candles[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
  });
  const out = [];
  let prev;
  trs.forEach((tr, i) => {
    const a = i === 0 ? tr : (prev * (period - 1) + tr) / period;
    out.push(a);
    prev = a;
  });
  return out;
}

function fmt(n, dp) {
  return n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

// ---------------- config ----------------
const MARKETS = {
  crypto: {
    label: "Crypto",
    quick: ["BTCUSDT", "ETHUSDT", "SOLUSDT"],
    data: {
      BTCUSDT: { base: 64500, dp: 2, vol: 0.018, td: "BTC/USD" },
      ETHUSDT: { base: 3420, dp: 2, vol: 0.022, td: "ETH/USD" },
      SOLUSDT: { base: 148, dp: 2, vol: 0.03, td: "SOL/USD" },
    },
  },
  forex: {
    label: "Forex",
    quick: ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCHF", "EURJPY"],
    data: {
      EURUSD: { base: 1.0852, dp: 5, vol: 0.006, td: "EUR/USD" },
      GBPUSD: { base: 1.3319, dp: 5, vol: 0.007, td: "GBP/USD" },
      USDJPY: { base: 151.24, dp: 3, vol: 0.006, td: "USD/JPY" },
      AUDUSD: { base: 0.6581, dp: 5, vol: 0.007, td: "AUD/USD" },
      USDCHF: { base: 0.8847, dp: 5, vol: 0.006, td: "USD/CHF" },
      EURJPY: { base: 164.12, dp: 3, vol: 0.007, td: "EUR/JPY" },
    },
  },
  emas: {
    label: "Emas",
    quick: ["XAUUSD", "XAGUSD"],
    data: { XAUUSD: { base: 4061, dp: 2, vol: 0.012, td: "XAU/USD" }, XAGUSD: { base: 28.4, dp: 3, vol: 0.02, td: "XAG/USD" } },
  },
  saham_as: {
    label: "Saham AS",
    quick: ["AAPL", "TSLA", "NVDA"],
    data: {
      AAPL: { base: 226, dp: 2, vol: 0.014, td: "AAPL" },
      TSLA: { base: 248, dp: 2, vol: 0.03, td: "TSLA" },
      NVDA: { base: 129, dp: 2, vol: 0.026, td: "NVDA" },
    },
  },
  saham_id: { label: "Saham ID", quick: [], data: {}, soon: true },
};

const TD_INTERVAL = { M15: "15min", H1: "1h", H4: "4h" };

// Ambil candle live lewat proxy Cloudflare Worker milik user.
// Format respons TwelveData: { values: [{ datetime, open, high, low, close }, ...] } (terbaru duluan)
async function fetchLiveCandles(proxyUrl, tdSymbol, tf, outputsize) {
  const u = new URL(proxyUrl.replace(/\/+$/, "") + "/time_series");
  u.searchParams.set("symbol", tdSymbol);
  u.searchParams.set("interval", TD_INTERVAL[tf] || "1h");
  u.searchParams.set("outputsize", String(outputsize));
  const res = await fetch(u.toString());
  const data = await res.json();
  if (data.status === "error" || data.code) {
    throw new Error(data.message || "TwelveData mengembalikan error");
  }
  if (!data.values || !Array.isArray(data.values)) {
    throw new Error("Format respons tidak dikenali");
  }
  const rows = [...data.values].reverse(); // jadi urutan lama -> baru
  return rows.map((r, i) => ({
    i,
    open: parseFloat(r.open),
    high: parseFloat(r.high),
    low: parseFloat(r.low),
    close: parseFloat(r.close),
  }));
}

const STYLES = [
  { id: "scalping", label: "Scalping", desc: "Tahan 15 menit – 3 jam", tf: "M15", count: 70, volMult: 1.4 },
  { id: "daytrade", label: "Day Trade", desc: "Tahan 2 – 12 jam", tf: "H1", count: 80, volMult: 1.0 },
  { id: "swing", label: "Swing", desc: "Tahan 1 – 5 hari", tf: "H4", count: 90, volMult: 0.75 },
];

const TIMEFRAMES = ["M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1"];

// ---------------- Claude API helper ----------------
// Kalau proxyUrl diisi (mode deploy mandiri) -> lewat /narrate di Worker kamu.
// Kalau kosong (mode preview di dalam chat Claude) -> panggil langsung, ditangani Anthropic.
async function askClaude({ system, userContent }, proxyUrl) {
  const endpoint = proxyUrl ? proxyUrl.replace(/\/+$/, "") + "/narrate" : "https://api.anthropic.com/v1/messages";
  const body = proxyUrl
    ? { system, messages: [{ role: "user", content: userContent }] }
    : { model: "claude-sonnet-4-6", max_tokens: 1000, system, messages: [{ role: "user", content: userContent }] };

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || data.error || "Error dari AI");
  const text = (data.content || [])
    .map((b) => (b.type === "text" ? b.text : ""))
    .filter(Boolean)
    .join("\n");
  const clean = text.replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
}

// ---------------- signal engine ----------------
function computeSignal(instrument, cfg, style, liveCandles) {
  const count = style.count;
  const candles = liveCandles && liveCandles.length >= 30 ? liveCandles : generateCandles(instrument, cfg.base, count, cfg.vol * style.volMult);
  const closes = candles.map((c) => c.close);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const ema100 = ema(closes.length >= 100 ? closes : closes.concat(closes), 100).slice(0, closes.length);
  const rsiArr = rsi(closes, 14);
  const atrArr = atr(candles, 14);

  const last = closes[closes.length - 1];
  const lastEma20 = ema20[ema20.length - 1];
  const lastEma50 = ema50[ema50.length - 1];
  const lastEma100 = ema100[ema100.length - 1];
  const lastRsi = rsiArr[rsiArr.length - 1];
  const lastAtr = atrArr[atrArr.length - 1];

  let bullVotes = 0;
  if (last > lastEma20) bullVotes++; else bullVotes--;
  if (lastEma20 > lastEma50) bullVotes++; else bullVotes--;
  if (lastEma50 > lastEma100) bullVotes++; else bullVotes--;
  if (lastRsi > 50) bullVotes++; else bullVotes--;

  const bias = bullVotes >= 0 ? "buy" : "sell";
  const strength = Math.abs(bullVotes); // 0-4
  const confidence = Math.round(52 + strength * 7.5 + Math.min(8, Math.abs(lastRsi - 50) * 0.25));

  const entry = last;
  const slDist = lastAtr * 1.3;
  const sl = bias === "buy" ? entry - slDist : entry + slDist;
  const dir = bias === "buy" ? 1 : -1;
  const tp1 = entry + dir * slDist * 2;
  const tp2 = entry + dir * slDist * 3;
  const tp3 = entry + dir * slDist * 4;

  // swing low/high reference for narrative
  const swingLow = Math.min(...candles.slice(-30).map((c) => c.low));
  const swingHigh = Math.max(...candles.slice(-30).map((c) => c.high));

  return {
    candles,
    dp: cfg.dp,
    indicators: { ema20: lastEma20, ema50: lastEma50, ema100: lastEma100, rsi: lastRsi, atr: lastAtr, swingLow, swingHigh },
    bias,
    confidence: Math.min(88, confidence),
    entry,
    sl,
    tp1,
    tp2,
    tp3,
  };
}

async function narrateSignal(instrument, style, sig, proxyUrl) {
  const { indicators, bias, dp, entry, sl, tp1, tp3 } = sig;
  const system =
    "Kamu adalah analis teknikal forex/crypto/emas berpengalaman yang menulis ringkasan sinyal trading dalam Bahasa Indonesia. " +
    "Gaya tulisan: padat, teknikal, percaya diri, seperti catatan meja trading — bukan bahasa pemasaran. " +
    "SELALU balas HANYA dengan JSON valid tanpa markdown, format persis: " +
    '{"ringkasan": "2-4 kalimat menjelaskan kondisi EMA/RSI/ATR dan alasan entry", "invalidasi": "1-2 kalimat kondisi yang membatalkan sinyal ini"}. ' +
    "Gunakan angka-angka yang diberikan secara akurat, jangan mengarang angka baru.";
  const userContent =
    `Instrumen: ${instrument} (${style.label}, timeframe ${style.tf})\n` +
    `Bias: ${bias === "buy" ? "BUY / bullish" : "SELL / bearish"}\n` +
    `Harga terkini: ${fmt(entry, dp)}\n` +
    `EMA20: ${fmt(indicators.ema20, dp)} | EMA50: ${fmt(indicators.ema50, dp)} | EMA100: ${fmt(indicators.ema100, dp)}\n` +
    `RSI14: ${indicators.rsi.toFixed(1)}\n` +
    `ATR14: ${fmt(indicators.atr, dp)}\n` +
    `Swing low 30 candle: ${fmt(indicators.swingLow, dp)} | Swing high 30 candle: ${fmt(indicators.swingHigh, dp)}\n` +
    `Entry: ${fmt(entry, dp)} | Stop Loss: ${fmt(sl, dp)} | Take Profit akhir (TP3): ${fmt(tp3, dp)}\n` +
    `Tulis ringkasan teknikal dan kondisi invalidasi sesuai format JSON yang diminta.`;
  return askClaude({ system, userContent }, proxyUrl);
}

// ---------------- Candle chart (SVG) ----------------
function CandleChart({ candles, dp, entry, sl, tp1, tp2, tp3, bias }) {
  const W = 800,
    H = 280,
    PAD_R = 78,
    PAD_Y = 14;
  const chartW = W - PAD_R;
  const allVals = candles.flatMap((c) => [c.high, c.low]).concat([entry, sl, tp1, tp2, tp3]);
  const min = Math.min(...allVals);
  const max = Math.max(...allVals);
  const span = max - min || 1;
  const y = (v) => PAD_Y + (1 - (v - min) / span) * (H - PAD_Y * 2);
  const n = candles.length;
  const cw = chartW / n;

  const levelLine = (v, color, label, dashed = true) => (
    <g key={label}>
      <line x1={0} x2={chartW} y1={y(v)} y2={y(v)} stroke={color} strokeWidth="1" strokeDasharray={dashed ? "4 3" : "0"} opacity="0.85" />
      <text x={chartW + 6} y={y(v) + 3} fill={color} fontSize="10" fontFamily="ui-monospace, monospace">
        {label} {fmt(v, dp)}
      </text>
    </g>
  );

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto select-none" style={{ overflow: "visible" }}>
      {candles.map((c, i) => {
        const x = i * cw + cw / 2;
        const up = c.close >= c.open;
        const color = up ? "#34C77B" : "#F0555C";
        const bodyTop = y(Math.max(c.open, c.close));
        const bodyBot = y(Math.min(c.open, c.close));
        return (
          <g key={i}>
            <line x1={x} x2={x} y1={y(c.high)} y2={y(c.low)} stroke={color} strokeWidth="1" opacity="0.9" />
            <rect x={x - cw * 0.32} y={bodyTop} width={cw * 0.64} height={Math.max(1.2, bodyBot - bodyTop)} fill={color} opacity="0.95" />
          </g>
        );
      })}
      {levelLine(entry, "#C9A45C", "ENTRY", false)}
      {levelLine(sl, "#F0555C", "SL")}
      {levelLine(tp1, "#34C77B", "TP1")}
      {levelLine(tp2, "#34C77B", "TP2")}
      {levelLine(tp3, "#34C77B", "TP3")}
    </svg>
  );
}

// ---------------- Signal Result Card ----------------
function SignalCard({ instrument, style, sig, ai, loadingAi }) {
  const { bias, confidence, entry, sl, tp1, tp2, tp3, dp, candles } = sig;
  const isBuy = bias === "buy";
  return (
    <div className="rounded-xl border border-[#26262C] bg-[#111114] overflow-hidden animate-[fadeIn_0.4s_ease]">
      <div className="flex items-start justify-between p-5 pb-3">
        <div>
          <div className="font-mono text-lg tracking-wide text-[#F1EFE9]">{instrument}</div>
          <div className="text-xs text-[#8D8B93] mt-1">
            {style.label} · {style.tf} · {style.desc}
          </div>
        </div>
        <span
          className={
            "text-xs font-semibold tracking-wide px-2.5 py-1 rounded-full border " +
            (isBuy ? "text-[#34C77B] border-[#34C77B]/40 bg-[#34C77B]/10" : "text-[#F0555C] border-[#F0555C]/40 bg-[#F0555C]/10")
          }
        >
          {isBuy ? "BUY" : "SELL"}
        </span>
      </div>

      <div className="px-5">
        <CandleChart candles={candles} dp={dp} entry={entry} sl={sl} tp1={tp1} tp2={tp2} tp3={tp3} bias={bias} />
      </div>

      <div className="grid grid-cols-2 gap-px bg-[#26262C] mt-4">
        {[
          ["ENTRY", fmt(entry, dp), "#F1EFE9"],
          ["STOP LOSS", fmt(sl, dp), "#F0555C"],
          ["TAKE PROFIT 1 · RR 1:2.0", fmt(tp1, dp), "#34C77B"],
          ["TAKE PROFIT 2 · RR 1:3.0", fmt(tp2, dp), "#34C77B"],
          ["TAKE PROFIT 3 · RR 1:4.0", fmt(tp3, dp), "#34C77B"],
          ["RISK / REWARD", "1:2.0", "#F1EFE9"],
        ].map(([label, val, color]) => (
          <div key={label} className="bg-[#111114] px-5 py-3">
            <div className="text-[10px] tracking-wider text-[#8D8B93]">{label}</div>
            <div className="font-mono text-base mt-0.5" style={{ color }}>
              {val}
            </div>
          </div>
        ))}
      </div>

      <div className="px-5 pt-4">
        <div className="flex items-center justify-between text-[10px] tracking-wider text-[#8D8B93] mb-1.5">
          <span>TINGKAT KEYAKINAN</span>
          <span className="font-mono text-[#F1EFE9]">{confidence}%</span>
        </div>
        <div className="h-1.5 rounded-full bg-[#26262C] overflow-hidden">
          <div
            className="h-full bg-[#C9A45C] rounded-full transition-all duration-700 ease-out"
            style={{ width: loadingAi ? "0%" : confidence + "%" }}
          />
        </div>
      </div>

      <div className="px-5 py-4 mt-2 border-t border-[#26262C]">
        <div className="text-[10px] tracking-wider text-[#8D8B93] mb-1.5">RINGKASAN TEKNIKAL</div>
        {loadingAi ? (
          <SkeletonLines n={3} />
        ) : (
          <p className="text-sm text-[#C9C7CF] leading-relaxed">{ai?.ringkasan || "Analisis tidak tersedia."}</p>
        )}
      </div>

      <div className="px-5 py-4 border-t border-[#26262C]">
        <div className="text-[10px] tracking-wider text-[#8D8B93] mb-1.5">SIGNAL BATAL KALAU</div>
        {loadingAi ? (
          <SkeletonLines n={2} />
        ) : (
          <p className="text-sm text-[#C9C7CF] leading-relaxed">{ai?.invalidasi || "-"}</p>
        )}
      </div>
    </div>
  );
}

function SkeletonLines({ n }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: n }).map((_, i) => (
        <div key={i} className="h-3 rounded bg-[#26262C] animate-pulse" style={{ width: i === n - 1 ? "60%" : "95%" }} />
      ))}
    </div>
  );
}

// ---------------- Main sections ----------------
function AnalisaSendiri({ proxyUrl }) {
  const [market, setMarket] = useState("forex");
  const [instrument, setInstrument] = useState("GBPUSD");
  const [styleId, setStyleId] = useState("daytrade");
  const [sig, setSig] = useState(null);
  const [ai, setAi] = useState(null);
  const [loadingAi, setLoadingAi] = useState(false);
  const [loadingPrice, setLoadingPrice] = useState(false);
  const [dataSource, setDataSource] = useState(null); // "live" | "simulasi"
  const [error, setError] = useState(null);
  const style = STYLES.find((s) => s.id === styleId);
  const marketCfg = MARKETS[market];

  useEffect(() => {
    if (marketCfg.quick.length && !marketCfg.data[instrument]) {
      setInstrument(marketCfg.quick[0]);
    }
  }, [market]);

  const handleGenerate = async () => {
    const cfg = marketCfg.data[instrument];
    if (!cfg) return;
    setError(null);
    setSig(null);
    setAi(null);

    let liveCandles = null;
    let source = "simulasi";
    if (proxyUrl) {
      setLoadingPrice(true);
      try {
        liveCandles = await fetchLiveCandles(proxyUrl, cfg.td, style.tf, style.count);
        source = "live";
      } catch (e) {
        setError("Gagal ambil data live (" + e.message + ") — pakai data simulasi dulu.");
      } finally {
        setLoadingPrice(false);
      }
    }

    const s = computeSignal(instrument, cfg, style, liveCandles);
    setSig(s);
    setDataSource(source);
    setLoadingAi(true);
    try {
      const result = await narrateSignal(instrument, style, s, proxyUrl);
      setAi(result);
    } catch (e) {
      setError("Gagal mengambil narasi AI (" + e.message + ").");
    } finally {
      setLoadingAi(false);
    }
  };

  return (
    <div className="space-y-7">
      <Section num="01" title="Market">
        <div className="grid grid-cols-3 gap-2">
          {Object.entries(MARKETS).map(([key, m]) => (
            <button
              key={key}
              disabled={m.soon}
              onClick={() => setMarket(key)}
              className={
                "rounded-lg border px-3 py-2.5 text-sm text-left transition-colors " +
                (m.soon
                  ? "border-[#26262C] text-[#55545C] cursor-not-allowed"
                  : market === key
                  ? "border-[#C9A45C] text-[#F1EFE9] bg-[#C9A45C]/10"
                  : "border-[#26262C] text-[#8D8B93] hover:border-[#3A3A42] hover:text-[#C9C7CF]")
              }
            >
              {m.label}
              {m.soon && <div className="text-[9px] tracking-wider mt-0.5">SEGERA</div>}
            </button>
          ))}
        </div>
      </Section>

      <Section num="02" title="Instrumen">
        <p className="text-xs text-[#8D8B93] mb-2.5">Pilih dari daftar di bawah, atau tulis sendiri pair yang kamu mau.</p>
        <input
          value={instrument}
          onChange={(e) => setInstrument(e.target.value.toUpperCase())}
          className="w-full rounded-lg bg-[#111114] border border-[#26262C] px-4 py-3 font-mono text-[#F1EFE9] focus:outline-none focus:border-[#C9A45C] mb-2.5"
          placeholder="Ketik pair, mis. XAUUSD"
        />
        <div className="flex flex-wrap gap-2">
          {marketCfg.quick.map((q) => (
            <button
              key={q}
              onClick={() => setInstrument(q)}
              className={
                "px-3 py-1.5 rounded-md text-xs font-mono border transition-colors " +
                (instrument === q ? "border-[#C9A45C] text-[#C9A45C]" : "border-[#26262C] text-[#8D8B93] hover:border-[#3A3A42]")
              }
            >
              {q}
            </button>
          ))}
        </div>
      </Section>

      <Section num="03" title="Gaya Trading">
        <div className="space-y-2.5">
          {STYLES.map((s) => (
            <button
              key={s.id}
              onClick={() => setStyleId(s.id)}
              className={
                "w-full flex items-center justify-between rounded-lg border px-4 py-3.5 text-left transition-colors " +
                (styleId === s.id ? "border-[#C9A45C] bg-[#C9A45C]/10" : "border-[#26262C] hover:border-[#3A3A42]")
              }
            >
              <div>
                <div className={"text-sm " + (styleId === s.id ? "text-[#F1EFE9]" : "text-[#C9C7CF]")}>{s.label}</div>
                <div className="text-xs text-[#8D8B93] mt-0.5">{s.desc}</div>
              </div>
              <span className="font-mono text-[10px] text-[#8D8B93] border border-[#26262C] rounded px-1.5 py-0.5">{s.tf}</span>
            </button>
          ))}
        </div>
      </Section>

      <button
        onClick={handleGenerate}
        disabled={!marketCfg.data[instrument] || loadingPrice}
        className="w-full rounded-lg bg-[#C9A45C] hover:bg-[#D8B36C] disabled:opacity-40 text-[#0A0A0D] font-semibold py-3.5 transition-colors"
      >
        {loadingPrice ? "Mengambil data harga…" : "Buat sinyal"}
      </button>

      {error && <p className="text-xs text-[#F0555C] text-center">{error}</p>}

      {sig && (
        <div>
          <div className="flex justify-end mb-2">
            <span
              className={
                "text-[10px] tracking-wider px-2 py-0.5 rounded-full border " +
                (dataSource === "live" ? "text-[#34C77B] border-[#34C77B]/40" : "text-[#8D8B93] border-[#26262C]")
              }
            >
              {dataSource === "live" ? "● DATA LIVE — TWELVEDATA" : "○ DATA SIMULASI"}
            </span>
          </div>
          <SignalCard instrument={instrument} style={style} sig={sig} ai={ai} loadingAi={loadingAi} />
        </div>
      )}

      <Disclaimer />
    </div>
  );
}

function AnalisaChart({ proxyUrl }) {
  const [imgData, setImgData] = useState(null); // {base64, mediaType}
  const [instrument, setInstrument] = useState("XAUUSD");
  const [tf, setTf] = useState("M15");
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const fileRef = useRef(null);

  const handleFile = (file) => {
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) {
      setError("Ukuran gambar maksimal 4 MB.");
      return;
    }
    setError(null);
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      const base64 = dataUrl.split(",")[1];
      setImgData({ base64, mediaType: file.type, previewUrl: dataUrl });
    };
    reader.readAsDataURL(file);
  };

  const handleAnalyze = async () => {
    if (!imgData) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const system =
        "Kamu adalah analis chart trading. Kamu akan diberi screenshot chart candlestick. " +
        "Baca pola price action, struktur tren, dan level penting yang TERLIHAT di gambar (jangan mengarang angka yang tidak ada di gambar; kalau angka tidak terbaca jelas, perkirakan berdasarkan posisi relatif candle). " +
        "Balas HANYA JSON valid tanpa markdown, format persis: " +
        '{"bias":"buy" atau "sell","ringkasan":"2-4 kalimat pola & alasan","invalidasi":"1-2 kalimat kondisi pembatalan","confidence": angka 50-85}.';
      const userContent = [
        { type: "image", source: { type: "base64", media_type: imgData.mediaType, data: imgData.base64 } },
        { type: "text", text: `Pair: ${instrument}, timeframe chart: ${tf}. Analisa chart ini dan berikan bias, ringkasan teknikal, dan kondisi invalidasi sesuai format JSON.` },
      ];
      const res = await askClaude({ system, userContent }, proxyUrl);
      setResult(res);
    } catch (e) {
      setError("Gagal menganalisis chart (" + e.message + ").");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-7">
      <Section num="01" title="Chart kamu">
        <p className="text-xs text-[#8D8B93] mb-2.5">Unggah screenshot chart kamu. Dipakai untuk membaca pola dan garis yang kamu gambar.</p>
        <div
          onClick={() => fileRef.current?.click()}
          className="rounded-lg border border-dashed border-[#26262C] hover:border-[#3A3A42] cursor-pointer transition-colors overflow-hidden"
        >
          {imgData ? (
            <img src={imgData.previewUrl} alt="chart preview" className="w-full max-h-72 object-contain bg-[#111114]" />
          ) : (
            <div className="py-14 text-center">
              <div className="text-sm text-[#C9C7CF]">Pilih atau tarik gambar ke sini</div>
              <div className="text-xs text-[#8D8B93] mt-1">PNG, JPG, atau WEBP · maksimal 4 MB</div>
            </div>
          )}
        </div>
        <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => handleFile(e.target.files?.[0])} />
        {imgData && (
          <button onClick={() => fileRef.current?.click()} className="mt-2.5 text-xs border border-[#26262C] rounded-md px-3 py-1.5 text-[#8D8B93] hover:border-[#3A3A42]">
            Ganti gambar
          </button>
        )}
      </Section>

      <Section num="02" title="Instrumen">
        <p className="text-xs text-[#8D8B93] mb-2.5">Tulis pair lengkap sesuai chart di atas, contoh BTCUSDT, XAUUSD, atau EURUSD.</p>
        <input
          value={instrument}
          onChange={(e) => setInstrument(e.target.value.toUpperCase())}
          className="w-full rounded-lg bg-[#111114] border border-[#26262C] px-4 py-3 font-mono text-[#F1EFE9] focus:outline-none focus:border-[#C9A45C]"
        />
      </Section>

      <Section num="03" title="Timeframe chart">
        <p className="text-xs text-[#8D8B93] mb-2.5">Pilih timeframe yang sama dengan chart yang kamu unggah.</p>
        <div className="grid grid-cols-4 gap-2">
          {TIMEFRAMES.map((t) => (
            <button
              key={t}
              onClick={() => setTf(t)}
              className={
                "rounded-lg border py-2.5 text-sm font-mono transition-colors " +
                (tf === t ? "border-[#C9A45C] text-[#F1EFE9] bg-[#C9A45C]/10" : "border-[#26262C] text-[#8D8B93] hover:border-[#3A3A42]")
              }
            >
              {t}
            </button>
          ))}
        </div>
      </Section>

      <button
        onClick={handleAnalyze}
        disabled={!imgData || loading}
        className="w-full rounded-lg bg-[#C9A45C] hover:bg-[#D8B36C] disabled:opacity-40 text-[#0A0A0D] font-semibold py-3.5 transition-colors"
      >
        {loading ? "Menganalisis…" : "Analisa chart"}
      </button>

      {error && <p className="text-xs text-[#F0555C] text-center">{error}</p>}

      {loading && (
        <div className="rounded-xl border border-[#26262C] bg-[#111114] p-5 space-y-3">
          <SkeletonLines n={4} />
        </div>
      )}

      {result && (
        <div className="rounded-xl border border-[#26262C] bg-[#111114] p-5 space-y-4 animate-[fadeIn_0.4s_ease]">
          <div className="flex items-center justify-between">
            <div className="font-mono text-lg text-[#F1EFE9]">{instrument}</div>
            <span
              className={
                "text-xs font-semibold tracking-wide px-2.5 py-1 rounded-full border " +
                (result.bias === "buy" ? "text-[#34C77B] border-[#34C77B]/40 bg-[#34C77B]/10" : "text-[#F0555C] border-[#F0555C]/40 bg-[#F0555C]/10")
              }
            >
              {result.bias === "buy" ? "BUY" : "SELL"}
            </span>
          </div>
          <div>
            <div className="text-[10px] tracking-wider text-[#8D8B93] mb-1.5">TINGKAT KEYAKINAN</div>
            <div className="h-1.5 rounded-full bg-[#26262C] overflow-hidden">
              <div className="h-full bg-[#C9A45C] rounded-full" style={{ width: (result.confidence || 60) + "%" }} />
            </div>
          </div>
          <div>
            <div className="text-[10px] tracking-wider text-[#8D8B93] mb-1.5">RINGKASAN TEKNIKAL</div>
            <p className="text-sm text-[#C9C7CF] leading-relaxed">{result.ringkasan}</p>
          </div>
          <div>
            <div className="text-[10px] tracking-wider text-[#8D8B93] mb-1.5">SIGNAL BATAL KALAU</div>
            <p className="text-sm text-[#C9C7CF] leading-relaxed">{result.invalidasi}</p>
          </div>
        </div>
      )}

      <Disclaimer />
    </div>
  );
}

const WATCHLIST = [
  { market: "emas", sym: "XAUUSD" },
  { market: "crypto", sym: "BTCUSDT" },
  { market: "forex", sym: "EURUSD" },
  { market: "forex", sym: "GBPUSD" },
];

function SignalHarian({ proxyUrl }) {
  const [items, setItems] = useState([]);
  const [expanded, setExpanded] = useState(null);
  const [aiMap, setAiMap] = useState({});
  const [loadingKey, setLoadingKey] = useState(null);

  useEffect(() => {
    const style = STYLES[1]; // day trade default
    const computed = WATCHLIST.map((w) => {
      const cfg = MARKETS[w.market].data[w.sym];
      return { ...w, style, sig: computeSignal(w.sym, cfg, style) };
    });
    setItems(computed);
  }, []);

  const toggle = async (key, item) => {
    if (expanded === key) {
      setExpanded(null);
      return;
    }
    setExpanded(key);
    if (!aiMap[key]) {
      setLoadingKey(key);
      try {
        const res = await narrateSignal(item.sym, item.style, item.sig, proxyUrl);
        setAiMap((m) => ({ ...m, [key]: res }));
      } catch (e) {
        setAiMap((m) => ({ ...m, [key]: { ringkasan: "Gagal memuat analisis.", invalidasi: "-" } }));
      } finally {
        setLoadingKey(null);
      }
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-xs text-[#8D8B93]">Sinyal harian untuk watchlist utama, dihitung otomatis dari kondisi pasar simulasi hari ini.</p>
      {items.map((item) => {
        const key = item.sym;
        const isBuy = item.sig.bias === "buy";
        const isOpen = expanded === key;
        return (
          <div key={key} className="rounded-xl border border-[#26262C] bg-[#111114] overflow-hidden">
            <button onClick={() => toggle(key, item)} className="w-full flex items-center justify-between px-5 py-4 text-left">
              <div>
                <div className="font-mono text-[#F1EFE9]">{item.sym}</div>
                <div className="text-xs text-[#8D8B93] mt-0.5">{item.style.label} · {item.style.tf}</div>
              </div>
              <div className="flex items-center gap-3">
                <span
                  className={
                    "text-xs font-semibold tracking-wide px-2.5 py-1 rounded-full border " +
                    (isBuy ? "text-[#34C77B] border-[#34C77B]/40 bg-[#34C77B]/10" : "text-[#F0555C] border-[#F0555C]/40 bg-[#F0555C]/10")
                  }
                >
                  {isBuy ? "BUY" : "SELL"}
                </span>
                <span className="text-[#8D8B93] text-xs">{isOpen ? "−" : "+"}</span>
              </div>
            </button>
            {isOpen && (
              <div className="px-5 pb-5">
                <SignalCard instrument={item.sym} style={item.style} sig={item.sig} ai={aiMap[key]} loadingAi={loadingKey === key} />
              </div>
            )}
          </div>
        );
      })}
      <Disclaimer />
    </div>
  );
}

function Section({ num, title, children }) {
  return (
    <div>
      <div className="flex items-baseline gap-2 mb-3">
        <span className="font-mono text-[11px] text-[#C9A45C]">{num}</span>
        <h2 className="text-[11px] tracking-[0.15em] text-[#8D8B93]">{title.toUpperCase()}</h2>
      </div>
      {children}
    </div>
  );
}

function Disclaimer() {
  return (
    <p className="text-[11px] text-[#55545C] text-center leading-relaxed pt-2">
      Demo — data harga disimulasikan, ringkasan analisis dibuat oleh AI berdasarkan indikator yang dihitung dari data itu.
      <br />
      Bukan nasihat keuangan. Trading berisiko — keputusan ada di tangan kamu.
    </p>
  );
}

function SettingsPanel({ proxyUrl, setProxyUrl }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(proxyUrl);

  return (
    <div className="mb-6">
      <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-1.5 text-xs text-[#8D8B93] hover:text-[#C9C7CF] mx-auto block">
        <span className={"inline-block w-1.5 h-1.5 rounded-full " + (proxyUrl ? "bg-[#34C77B]" : "bg-[#55545C]")} />
        {proxyUrl ? "Data live aktif" : "Pakai data simulasi"} · pengaturan
      </button>
      {open && (
        <div className="mt-3 rounded-lg border border-[#26262C] bg-[#111114] p-4 space-y-2.5">
          <label className="text-[10px] tracking-wider text-[#8D8B93]">PROXY URL (Cloudflare Worker kamu)</label>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="https://signalynx-proxy.namamu.workers.dev"
            className="w-full rounded-md bg-[#0A0A0D] border border-[#26262C] px-3 py-2 text-xs font-mono text-[#F1EFE9] focus:outline-none focus:border-[#C9A45C]"
          />
          <div className="flex gap-2">
            <button onClick={() => setProxyUrl(draft.trim())} className="text-xs rounded-md bg-[#C9A45C] text-[#0A0A0D] px-3 py-1.5 font-medium">
              Simpan
            </button>
            {proxyUrl && (
              <button
                onClick={() => {
                  setDraft("");
                  setProxyUrl("");
                }}
                className="text-xs rounded-md border border-[#26262C] text-[#8D8B93] px-3 py-1.5"
              >
                Hapus, pakai simulasi
              </button>
            )}
          </div>
          <p className="text-[10px] text-[#55545C] leading-relaxed">
            Proxy ini dipakai untuk dua hal: mengambil harga live dari TwelveData, dan meminta narasi analisis dari Claude. Key TwelveData &amp; Anthropic tidak pernah ditaruh di sini — hanya tersimpan di server proxy kamu. Kosongkan untuk kembali ke mode simulasi.
          </p>
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [tab, setTab] = useState("sendiri");
  const [proxyUrl, setProxyUrl] = useState("");
  const tabs = [
    { id: "sendiri", label: "Analisa Sendiri" },
    { id: "chart", label: "Analisa Chart" },
    { id: "harian", label: "Signal Harian" },
  ];

  return (
    <div className="min-h-screen bg-[#0A0A0D] text-[#F1EFE9] flex justify-center py-10 px-4">
      <style>{`
        @keyframes fadeIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
      `}</style>
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="font-serif text-3xl tracking-tight">
            Signal<span className="text-[#C9A45C]">ynx</span>
          </h1>
          <p className="text-[10px] tracking-[0.2em] text-[#8D8B93] mt-1.5">ANALISA TEKNIKAL OTOMATIS</p>
        </div>

        <SettingsPanel proxyUrl={proxyUrl} setProxyUrl={setProxyUrl} />

        <div className="flex border-b border-[#26262C] mb-7">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={"flex-1 text-sm py-3 border-b-2 transition-colors " + (tab === t.id ? "border-[#C9A45C] text-[#F1EFE9]" : "border-transparent text-[#8D8B93] hover:text-[#C9C7CF]")}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === "sendiri" && <AnalisaSendiri proxyUrl={proxyUrl} />}
        {tab === "chart" && <AnalisaChart proxyUrl={proxyUrl} />}
        {tab === "harian" && <SignalHarian proxyUrl={proxyUrl} />}
      </div>
    </div>
  );
}

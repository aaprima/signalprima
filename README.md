# Signalynx (prototype)

Aplikasi generator sinyal trading. Data harga & narasi AI dilewatkan lewat
proxy Cloudflare Worker milikmu sendiri (lihat `twelvedata-proxy-worker.js`
di percakapan Claude, atau minta lagi ke Claude kalau hilang).

## Deploy ke Cloudflare Pages (tanpa install apa pun di HP/laptop)

1. Buat akun GitHub kalau belum punya (github.com).
2. Buat repository baru (New repository), kasih nama `signalynx`, public/private
   bebas.
3. Di halaman repo kosong itu, klik "uploading an existing file" ->
   upload SEMUA file & folder di proyek ini (pertahankan struktur foldernya:
   `src/App.jsx`, `src/main.jsx`, dst) -> Commit changes.
4. Buka dash.cloudflare.com -> Workers & Pages -> Create application ->
   tab **Pages** -> **Connect to Git** -> pilih repo `signalynx` tadi.
5. Build settings:
   - Framework preset: **Vite**
   - Build command: `npm run build`
   - Build output directory: `dist`
6. Deploy. Setelah selesai, kamu dapat URL seperti
   `https://signalynx.pages.dev` — itu website Signalynx kamu, bisa dibuka
   dari HP mana saja.
7. Buka website itu -> klik "pengaturan" -> isi Proxy URL dengan URL Worker
   kamu (`https://signalynx-proxy.xxx.workers.dev`) -> Simpan.

## Yang perlu diingat

- Data harga & narasi AI TIDAK akan muncul kalau Proxy URL belum diisi
  (fallback ke data simulasi, AI narasi akan gagal).
- Worker proxy butuh dua secret: `TWELVEDATA_API_KEY` dan
  `ANTHROPIC_API_KEY`, di-set lewat Settings -> Variables and Secrets di
  Cloudflare dashboard punya Worker itu (bukan punya Pages).
- Ini prototipe demo, bukan produk finansial berlisensi. Selalu tampilkan
  disclaimer risiko ke pengguna.

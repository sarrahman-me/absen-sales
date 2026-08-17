# My Zona — Absensi Sales Lapangan

Aplikasi absensi kunjungan untuk sales lapangan toko bahan bangunan.
Sales memfoto toko yang dikunjungi, foto otomatis distempel GPS + jam + nama sales,
lalu datanya masuk ke pusat data yang bisa dipantau pemilik.

## Isi proyek

| Berkas | Kegunaan |
| --- | --- |
| `index.html` | Aplikasi sales (dibuka di HP). Peta, kamera, form kunjungan, riwayat. |
| `dashboard.html` | Dashboard pemilik. Terkunci kata sandi. Ringkasan, filter, peta sebaran, export. |
| `api/kunjungan.js` | Penghubung ke database & penyimpanan foto. |

Alamat dashboard = alamat aplikasi + `/dashboard.html`
(contoh: `https://absen-sales.vercel.app/dashboard.html`).

## Yang harus disiapkan sekali di Vercel

Kodenya sudah ter-deploy, tapi belum tersambung ke database. Untuk memeriksa
apa yang masih kurang kapan saja, buka alamat ini di peramban:

```
https://absen-sales.vercel.app/api/kunjungan
```

Halaman itu akan menyebutkan persis variabel mana yang belum terisi.
Kalau sudah beres, balasannya berubah menjadi permintaan kata sandi.

Selama tiga langkah di bawah belum selesai, absensi tetap bisa dilakukan —
datanya mengantre di HP dan terkirim sendiri begitu penyiapan rampung.

**1. Penyimpanan foto (Vercel Blob)**
Buka proyek `absen-sales` di Vercel → menu **Storage** → **Create Database** → pilih **Blob** →
beri nama bebas → **Connect** ke proyek ini.
Vercel otomatis mengisi variabel `BLOB_READ_WRITE_TOKEN`.

Store harus bertipe **Private**, dan **hanya boleh ada satu** blob store tersambung ke
proyek ini. Kalau ada dua, hanya satu `BLOB_READ_WRITE_TOKEN` yang aktif dan tidak
bisa dipastikan yang mana — akibatnya penyimpanan foto gagal dengan pesan seperti
"Cannot use private access on a public store".

**2. Database (Neon Postgres)**
Menu **Storage** → **Create Database** → pilih **Neon Postgres** (paket gratis) →
**Connect** ke proyek ini.
Vercel otomatis mengisi variabel `DATABASE_URL`. Tabelnya dibuat sendiri saat data pertama masuk.

**3. Kata sandi pemilik**
Menu **Settings** → **Environment Variables** → tambah:

| Nama | Nilai |
| --- | --- |
| `OWNER_PASSWORD` | kata sandi bebas untuk kakak (jangan yang gampang ditebak) |

Pilih ketiga lingkungan (Production, Preview, Development), lalu **Save**.

**4. Deploy ulang**
Menu **Deployments** → titik tiga pada deployment teratas → **Redeploy**.
Variabel baru hanya terbaca oleh deployment yang dibuat setelah variabel ditambahkan.

## Cara pakai

**Sales** — buka alamat aplikasi di HP, tekan nama di pojok kiri atas untuk mengisi nama sendiri
(cukup sekali), lalu setiap sampai di toko: tekan **Absen Disini** → foto → nama toko → simpan.

**Pemilik** — buka `/dashboard.html`, masukkan kata sandi, lihat semua kunjungan semua sales.

## Kalau sinyal jelek di lapangan

Absensi tetap bisa dilakukan tanpa internet. Data mengantre di HP dan terkirim otomatis
begitu dapat sinyal. Lencana di pojok kanan atas menunjukkan keadaannya:

- **Tersimpan** (hijau) — semua sudah masuk pusat data
- **N belum terkirim** (kuning) — masih mengantre, tekan lencana untuk mencoba kirim sekarang
- **Offline** (abu-abu) — HP sedang tanpa internet
- **N gagal** (merah) — ditolak server, perlu dicek

Sales sebaiknya diingatkan: jangan hapus riwayat yang masih berlencana kuning,
karena data itu belum ada di pusat.

## Catatan penting

- **Sales tidak pakai login.** Nama sales hanya ketikan, jadi belum bisa dipakai sebagai bukti
  yang mengikat secara hukum atau untuk perhitungan komisi yang disengketakan.
  Kalau nanti perlu, tinggal ditambahkan sistem login per sales.
- **Alamat aplikasi bersifat terbuka.** Siapa pun yang tahu alamatnya bisa mengirim data
  kunjungan palsu. Untuk toko kecil ini biasanya bukan masalah, tapi jangan disebar publik.
- **Pin peta bisa digeser manual** (memang perlu, karena GPS sering meleset beberapa puluh meter).
  Karena itu aplikasi merekam koordinat GPS asli perangkat secara terpisah. Kalau pin digeser
  lebih dari 200 meter dari bacaan GPS, dashboard menandainya kuning dan menghitungnya
  di kotak **Perlu Dicek**.
- **Foto dikecilkan** ke lebar maksimal 1280px sebelum dikirim, supaya hemat kuota sales
  dan hemat biaya penyimpanan.
- **Foto bersifat privat.** Tidak ada alamat publik yang bisa dibuka tanpa kata sandi;
  dashboard mengambilnya lewat API yang dijaga `OWNER_PASSWORD`. Karena itu laporan
  WhatsApp dari aplikasi sales berisi teks dan titik peta saja, tanpa lampiran foto.
  Sales tetap melihat sisipan kecil foto di riwayat HP-nya sendiri.

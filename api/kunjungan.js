import { neon } from '@neondatabase/serverless';
import { put, del, get } from '@vercel/blob';

// Dibuat saat dipakai, bukan saat berkas dimuat: neon() melempar galat kalau
// DATABASE_URL belum diatur, dan itu mematikan fungsi sebelum sempat
// mengembalikan pesan yang bisa dibaca.
let _sql = null;
function db() {
  if (!_sql) _sql = neon(process.env.DATABASE_URL);
  return _sql;
}

// Batas ukuran foto setelah dikompres di HP. Aplikasi sales menargetkan ~300 KB,
// jadi 5 MB memberi ruang aman tanpa menembus batas payload Vercel (4.5 MB base64).
const MAX_FOTO_BYTES = 5 * 1024 * 1024;

let schemaReady = null;
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      await db()`
        create table if not exists kunjungan (
          id          text primary key,
          sales_name  text not null,
          nama_toko   text not null,
          kelurahan   text,
          alamat      text,
          lat         double precision not null,
          lng         double precision not null,
          gps_lat     double precision,
          gps_lng     double precision,
          akurasi_m   integer,
          rating      integer,
          deskripsi   text,
          foto_url    text not null,
          waktu       timestamptz not null default now(),
          dibuat_pada timestamptz not null default now()
        )
      `;
      await db()`create index if not exists kunjungan_waktu_idx on kunjungan (waktu desc)`;
    })().catch((err) => {
      schemaReady = null; // biar percobaan berikutnya mencoba lagi
      throw err;
    });
  }
  return schemaReady;
}

function pemilikSah(req) {
  const diberikan = req.headers['x-owner-password'];
  const seharusnya = process.env.OWNER_PASSWORD;
  if (!seharusnya || typeof diberikan !== 'string') return false;
  if (diberikan.length !== seharusnya.length) return false;
  let beda = 0;
  for (let i = 0; i < seharusnya.length; i++) beda |= diberikan.charCodeAt(i) ^ seharusnya.charCodeAt(i);
  return beda === 0;
}

const teks = (v, maks) => (typeof v === 'string' ? v.trim().slice(0, maks) : '');
const angka = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// Bentuk tanggal bawaan Postgres ("2026-08-17 09:58:00+00") tidak dikenali semua
// peramban, jadi selalu dikirim sebagai ISO.
function keIso(v) {
  const d = v instanceof Date ? v : new Date(v);
  return isNaN(d) ? null : d.toISOString();
}

function barisKeObjek(r) {
  return {
    id: r.id,
    salesName: r.sales_name,
    nama: r.nama_toko,
    kelurahan: r.kelurahan,
    alamat: r.alamat,
    lat: r.lat,
    lng: r.lng,
    gpsLat: r.gps_lat,
    gpsLng: r.gps_lng,
    akurasi: r.akurasi_m,
    rating: r.rating,
    deskripsi: r.deskripsi,
    waktu: keIso(r.waktu),
  };
}

export default async function handler(req, res) {
  try {
    // Pesan yang menyebut nama variabelnya persis, supaya penyiapan di Vercel
    // yang belum lengkap langsung ketahuan tanpa perlu membaca log.
    const kurang = [
      !process.env.DATABASE_URL && 'DATABASE_URL (hubungkan Neon Postgres di menu Storage)',
      !process.env.BLOB_READ_WRITE_TOKEN && 'BLOB_READ_WRITE_TOKEN (hubungkan Blob di menu Storage)',
      !process.env.OWNER_PASSWORD && 'OWNER_PASSWORD (isi di Settings > Environment Variables)',
    ].filter(Boolean);

    if (kurang.length) {
      return res.status(503).json({ error: `Penyiapan Vercel belum lengkap. Yang belum ada: ${kurang.join('; ')}.` });
    }

    await ensureSchema();

    if (req.method === 'POST') return await simpanKunjungan(req, res);
    if (req.method === 'GET') return await ambilKunjungan(req, res);
    if (req.method === 'DELETE') return await hapusKunjungan(req, res);

    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).json({ error: 'Metode tidak didukung.' });
  } catch (err) {
    console.error('kunjungan handler gagal:', err);
    return res.status(500).json({ error: 'Terjadi kesalahan di server.' });
  }
}

// --- SALES: kirim satu kunjungan -------------------------------------------
// Aman diulang: kalau HP mengirim ulang id yang sama (karena sinyal putus saat
// menunggu balasan), baris lama dipertahankan dan tetap dibalas sukses.
async function simpanKunjungan(req, res) {
  const b = req.body || {};

  const id = teks(b.id, 80);
  const salesName = teks(b.salesName, 60) || 'Tanpa Nama';
  const nama = teks(b.nama, 120);
  const lat = angka(b.lat);
  const lng = angka(b.lng);

  if (!id) return res.status(400).json({ error: 'id kunjungan wajib ada.' });
  if (!nama) return res.status(400).json({ error: 'Nama toko wajib diisi.' });
  if (lat === null || lng === null) return res.status(400).json({ error: 'Koordinat tidak valid.' });

  const cocok = /^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(b.foto || '');
  if (!cocok) return res.status(400).json({ error: 'Foto tidak valid atau tidak terkirim.' });

  const isiFoto = Buffer.from(cocok[2], 'base64');
  if (isiFoto.length === 0) return res.status(400).json({ error: 'Foto kosong.' });
  if (isiFoto.length > MAX_FOTO_BYTES) return res.status(413).json({ error: 'Ukuran foto terlalu besar.' });

  const sudahAda = await db()`select foto_url from kunjungan where id = ${id}`;
  if (sudahAda.length > 0) {
    return res.status(200).json({ ok: true, duplikat: true, fotoUrl: sudahAda[0].foto_url });
  }

  // Penyimpanan bersifat privat: foto toko dan catatan pesanan pelanggan tidak
  // boleh bisa dibuka siapa pun yang menebak alamatnya. Alamat yang tersimpan di
  // sini tidak pernah dikirim ke peramban; dashboard mengambil foto lewat
  // ?foto=<id> yang dijaga kata sandi pemilik.
  const { url: fotoUrl } = await put(`kunjungan/${id}.jpg`, isiFoto, {
    access: 'private',
    contentType: 'image/jpeg',
    addRandomSuffix: false,
    allowOverwrite: true, // percobaan ulang menulis ke jalur yang sama
  });

  const waktu = Number.isFinite(Date.parse(b.waktu)) ? new Date(b.waktu) : new Date();
  const rating = Number.isInteger(b.rating) && b.rating >= 1 && b.rating <= 5 ? b.rating : null;
  const akurasi = Number.isFinite(b.akurasi) ? Math.round(b.akurasi) : null;

  await db()`
    insert into kunjungan
      (id, sales_name, nama_toko, kelurahan, alamat, lat, lng, gps_lat, gps_lng, akurasi_m, rating, deskripsi, foto_url, waktu)
    values
      (${id}, ${salesName}, ${nama}, ${teks(b.kelurahan, 120)}, ${teks(b.alamat, 400)},
       ${lat}, ${lng}, ${angka(b.gpsLat)}, ${angka(b.gpsLng)}, ${akurasi}, ${rating},
       ${teks(b.deskripsi, 2000)}, ${fotoUrl}, ${waktu})
    on conflict (id) do nothing
  `;

  return res.status(201).json({ ok: true, fotoUrl });
}

// --- PEMILIK: ambil satu foto ----------------------------------------------
// Foto tidak punya alamat publik, jadi disalurkan lewat sini supaya kata sandi
// pemilik tetap menjadi satu-satunya pintu masuk.
async function ambilFoto(req, res, id) {
  const baris = await db()`select foto_url from kunjungan where id = ${id}`;
  if (baris.length === 0) return res.status(404).json({ error: 'Foto tidak ditemukan.' });

  const hasil = await get(baris[0].foto_url, { access: 'private' });
  if (!hasil || !hasil.stream) return res.status(404).json({ error: 'Foto tidak ditemukan.' });

  const potongan = [];
  for await (const p of hasil.stream) potongan.push(p);

  res.setHeader('Content-Type', hasil.blob.contentType || 'image/jpeg');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  return res.status(200).end(Buffer.concat(potongan.map((p) => Buffer.from(p))));
}

// --- PEMILIK: lihat semua kunjungan ----------------------------------------
async function ambilKunjungan(req, res) {
  if (!pemilikSah(req)) return res.status(401).json({ error: 'Kata sandi pemilik salah.' });

  const foto = teks(req.query?.foto, 80);
  if (foto) return await ambilFoto(req, res, foto);

  const { dari, sampai, sales } = req.query || {};
  const filterSales = teks(sales, 60);

  // Tanggal dikirim sebagai YYYY-MM-DD dari zona waktu pengguna; "sampai"
  // dinaikkan satu hari supaya kunjungan di hari itu ikut terambil.
  const mulai = dari && Number.isFinite(Date.parse(dari)) ? new Date(dari) : null;
  let akhir = null;
  if (sampai && Number.isFinite(Date.parse(sampai))) {
    akhir = new Date(sampai);
    akhir.setDate(akhir.getDate() + 1);
  }

  const baris = await db()`
    select * from kunjungan
    where (${mulai}::timestamptz is null or waktu >= ${mulai})
      and (${akhir}::timestamptz is null or waktu < ${akhir})
      and (${filterSales || null}::text is null or sales_name = ${filterSales || null})
    order by waktu desc
    limit 1000
  `;

  const daftarSales = await db()`select distinct sales_name from kunjungan order by sales_name`;

  return res.status(200).json({
    kunjungan: baris.map(barisKeObjek),
    daftarSales: daftarSales.map((r) => r.sales_name),
  });
}

// --- PEMILIK: hapus satu kunjungan -----------------------------------------
async function hapusKunjungan(req, res) {
  if (!pemilikSah(req)) return res.status(401).json({ error: 'Kata sandi pemilik salah.' });

  const id = teks(req.query?.id, 80);
  if (!id) return res.status(400).json({ error: 'id wajib diisi.' });

  const dihapus = await db()`delete from kunjungan where id = ${id} returning foto_url`;
  if (dihapus.length === 0) return res.status(404).json({ error: 'Data tidak ditemukan.' });

  // Foto ikut dibuang supaya tidak menumpuk sebagai file yatim di penyimpanan.
  try {
    await del(dihapus[0].foto_url);
  } catch (err) {
    console.error('gagal menghapus foto blob:', err);
  }

  return res.status(200).json({ ok: true });
}

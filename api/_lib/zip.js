// Minimal, dependency-free ZIP writer (store-only — no compression).
//
// We deliberately avoid an npm dependency here: installs in this environment hit
// a corporate-cert issue, and PDFs/images (the only things we bundle — director
// expense invoices) barely compress anyway, so storing them verbatim is fine.
//
// Produces a standard .zip: a local file header + raw bytes per entry, then a
// central directory and end-of-central-directory record. Buffer-based (the whole
// archive is held in memory) which is appropriate for the modest sizes here
// (≤ 20 MB per file, a handful of files per month).

// CRC-32 (IEEE 802.3) — table built once on first use.
let CRC_TABLE = null;
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  CRC_TABLE = t;
  return t;
}
function crc32(buf) {
  const t = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// DOS date/time encoding for the (single) timestamp stamped on every entry.
function dosDateTime(date) {
  const d = date || new Date();
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f);
  const day = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
  return { time: time & 0xffff, date: day & 0xffff };
}

// De-duplicate entry names so two invoices that sanitise to the same filename
// don't collide inside the archive.
function uniqueName(name, used) {
  let n = name;
  if (used.has(n)) {
    const dot = n.lastIndexOf('.');
    const base = dot > 0 ? n.slice(0, dot) : n;
    const ext = dot > 0 ? n.slice(dot) : '';
    let i = 2;
    while (used.has(`${base}-${i}${ext}`)) i += 1;
    n = `${base}-${i}${ext}`;
  }
  used.add(n);
  return n;
}

// Build a ZIP from `[{ name, data }]` where `data` is a Buffer. Returns a Buffer.
export function zipStore(files) {
  const { time, date } = dosDateTime(new Date());
  const used = new Set();
  const locals = [];   // local header + data chunks, in order
  const centrals = []; // central directory records
  let offset = 0;

  for (const f of files) {
    const name = uniqueName(String(f.name || 'file'), used);
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data || []);
    const crc = crc32(data);
    const size = data.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);     // local file header signature
    local.writeUInt16LE(20, 4);             // version needed
    local.writeUInt16LE(0x0800, 6);         // flags: bit 11 = UTF-8 filename
    local.writeUInt16LE(0, 8);              // compression: 0 = store
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);          // compressed size (== uncompressed for store)
    local.writeUInt32LE(size, 22);          // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);             // extra field length
    locals.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);   // central directory header signature
    central.writeUInt16LE(20, 4);           // version made by
    central.writeUInt16LE(20, 6);           // version needed
    central.writeUInt16LE(0x0800, 8);       // flags
    central.writeUInt16LE(0, 10);           // compression
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);           // extra length
    central.writeUInt16LE(0, 32);           // comment length
    central.writeUInt16LE(0, 34);           // disk number
    central.writeUInt16LE(0, 36);           // internal attrs
    central.writeUInt32LE(0, 38);           // external attrs
    central.writeUInt32LE(offset, 42);      // offset of local header
    centrals.push(Buffer.concat([central, nameBuf]));

    offset += local.length + nameBuf.length + data.length;
  }

  const centralDir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);         // end of central directory signature
  end.writeUInt16LE(0, 4);                  // disk number
  end.writeUInt16LE(0, 6);                  // disk with central dir
  end.writeUInt16LE(centrals.length, 8);    // entries on this disk
  end.writeUInt16LE(centrals.length, 10);   // total entries
  end.writeUInt32LE(centralDir.length, 12); // central directory size
  end.writeUInt32LE(offset, 16);            // central directory offset
  end.writeUInt16LE(0, 20);                 // comment length

  return Buffer.concat([...locals, centralDir, end]);
}

// WhatsApp only plays voice notes (PTT) in OGG/Opus. MP3/M4A/WAV sent as a voice note arrive
// broken on the receiver's phone ("algo errado com o arquivo"). This converts any audio the
// browser can decode into OGG/Opus, entirely in the browser (Web Audio + WebCodecs).
const VoiceNote = (() => {
  const RATE = 48000;
  const PRE_SKIP = 312; // libopus encoder delay at 48 kHz

  const isOggOpus = (dataUrl) => /^data:audio\/ogg/i.test(dataUrl) && atob(dataUrl.split(',')[1].slice(0, 8)).startsWith('OggS');

  function dataUrlToBytes(dataUrl) {
    const bin = atob(dataUrl.split(',')[1]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function bytesToDataUrl(bytes, mime) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return `data:${mime};base64,` + btoa(bin);
  }

  // Decodes and resamples to mono 48 kHz
  async function decodeMono48k(bytes) {
    const ctx = new OfflineAudioContext(1, 1, RATE);
    const decoded = await ctx.decodeAudioData(bytes.buffer.slice(0));
    const length = Math.ceil(decoded.duration * RATE);
    const render = new OfflineAudioContext(1, Math.max(1, length), RATE);
    const src = render.createBufferSource();
    src.buffer = decoded;
    src.connect(render.destination);
    src.start();
    return (await render.startRendering()).getChannelData(0);
  }

  async function encodeOpus(pcm) {
    const packets = [];
    let failure = null;
    const encoder = new AudioEncoder({
      output: (chunk) => {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        packets.push({ data, samples: Math.round((chunk.duration * RATE) / 1e6) || 960 });
      },
      error: (e) => (failure = e),
    });
    encoder.configure({ codec: 'opus', sampleRate: RATE, numberOfChannels: 1, bitrate: 32000 });
    const FRAME = 960 * 50; // feed 1 s at a time
    for (let i = 0; i < pcm.length; i += FRAME) {
      const slice = pcm.subarray(i, Math.min(pcm.length, i + FRAME));
      encoder.encode(new AudioData({ format: 'f32-planar', sampleRate: RATE, numberOfFrames: slice.length, numberOfChannels: 1, timestamp: Math.round((i / RATE) * 1e6), data: slice }));
    }
    await encoder.flush();
    encoder.close();
    if (failure) throw failure;
    return packets;
  }

  // ---- Ogg container (RFC 3533 / RFC 7845) ----
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let r = i << 24;
      for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
      t[i] = r >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let crc = 0;
    for (let i = 0; i < bytes.length; i++) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ bytes[i]) & 0xff]) >>> 0;
    return crc;
  }

  function oggPage(packets, granule, serial, sequence, flags) {
    const lacing = [];
    for (const p of packets) {
      let n = p.length;
      while (n >= 255) (lacing.push(255), (n -= 255));
      lacing.push(n);
    }
    const bodyLength = packets.reduce((a, p) => a + p.length, 0);
    const page = new Uint8Array(27 + lacing.length + bodyLength);
    const view = new DataView(page.buffer);
    page.set([0x4f, 0x67, 0x67, 0x53]); // "OggS"
    page[5] = flags;
    view.setUint32(6, granule % 0x100000000, true);
    view.setUint32(10, Math.floor(granule / 0x100000000), true);
    view.setUint32(14, serial, true);
    view.setUint32(18, sequence, true);
    page[26] = lacing.length;
    page.set(lacing, 27);
    let off = 27 + lacing.length;
    for (const p of packets) (page.set(p, off), (off += p.length));
    view.setUint32(22, crc32(page), true);
    return page;
  }

  // totalSamples: real audio length; the last page's granule trims the encoder's end padding (RFC 7845 §4.4)
  function muxOgg(packets, totalSamples) {
    const serial = (Math.random() * 0xffffffff) >>> 0;
    const head = new Uint8Array(19);
    head.set([...'OpusHead'].map((c) => c.charCodeAt(0)));
    const hv = new DataView(head.buffer);
    head[8] = 1; // version
    head[9] = 1; // channels
    hv.setUint16(10, PRE_SKIP, true);
    hv.setUint32(12, RATE, true);
    const vendor = new TextEncoder().encode('GoSeller');
    const tags = new Uint8Array(8 + 4 + vendor.length + 4);
    tags.set([...'OpusTags'].map((c) => c.charCodeAt(0)));
    new DataView(tags.buffer).setUint32(8, vendor.length, true);
    tags.set(vendor, 12);

    const pages = [oggPage([head], 0, serial, 0, 0x02), oggPage([tags], 0, serial, 1, 0)];
    let granule = PRE_SKIP;
    let seq = 2;
    const PER_PAGE = 50; // ~1 s of audio per page
    for (let i = 0; i < packets.length; i += PER_PAGE) {
      const group = packets.slice(i, i + PER_PAGE);
      granule += group.reduce((a, p) => a + p.samples, 0);
      const last = i + PER_PAGE >= packets.length;
      if (last) granule = Math.min(granule, PRE_SKIP + totalSamples);
      pages.push(oggPage(group.map((p) => p.data), granule, serial, seq++, last ? 0x04 : 0));
    }
    const total = pages.reduce((a, p) => a + p.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of pages) (out.set(p, off), (off += p.length));
    return out;
  }

  // Returns { dataUrl, duration } in OGG/Opus
  async function convert(dataUrl) {
    const pcm = await decodeMono48k(dataUrlToBytes(dataUrl));
    const packets = await encodeOpus(pcm);
    if (!packets.length) throw new Error('Áudio vazio');
    return { dataUrl: bytesToDataUrl(muxOgg(packets, pcm.length), 'audio/ogg; codecs=opus'), duration: pcm.length / RATE };
  }

  return { isOggOpus, convert, MIME: 'audio/ogg; codecs=opus' };
})();

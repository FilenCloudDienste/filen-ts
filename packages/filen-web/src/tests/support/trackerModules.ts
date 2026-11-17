// Tracker modules generated in code: one square-wave sample struck on the first row of a 64-row pattern, as a
// 31-sample ProTracker MOD ("M.K.", 7.68 s at speed 6 and 125 BPM) or a signature-less 15-sample one. The square
// sounds once (a one-word loop is none, in MOD), or with `looped` for as long as the song.
export function tinyMod(samples: 31 | 15 = 31, looped = false): Uint8Array {
	const header = samples === 31 ? 1084 : 600
	const bytes = new Uint8Array(header + 1024 + 64)
	const encoder = new TextEncoder()
	const sample = 20
	const orders = samples === 31 ? 950 : 470

	bytes.set(encoder.encode("tiny"), 0)
	bytes.set(encoder.encode("square"), sample)
	// 32 words long, volume 64, a one-word loop.
	bytes[sample + 23] = 32
	bytes[sample + 25] = 64
	bytes[sample + 29] = looped ? 32 : 1
	bytes[orders] = 1
	bytes[orders + 1] = 127

	if (samples === 31) {
		bytes.set(encoder.encode("M.K."), 1080)
	}

	// Row 0, channel 0: sample 1 at period 428 (C-3).
	bytes.set([0x01, 0xac, 0x10, 0x00], header)

	for (let i = 0; i < 64; i++) {
		bytes[header + 1024 + i] = i < 32 ? 0x40 : 0xc0
	}

	return bytes
}

// A FastTracker 2 module of one instrument whose one 8-bit sample is `sampleBytes` long, struck on the first row of a
// one-row pattern: the size a module at the cap reaches with its samples alone.
export function largeXm(sampleBytes: number): Uint8Array {
	const encoder = new TextEncoder()
	const header = new Uint8Array(60 + 276)
	const view = new DataView(header.buffer)

	header.set(encoder.encode("Extended Module: "), 0)
	header.set(encoder.encode("large"), 17)
	header[37] = 0x1a
	header.set(encoder.encode("filen"), 38)
	view.setUint16(58, 0x0104, true)
	view.setUint32(60, 276, true)
	// One order, one channel, one pattern, one instrument, linear periods, speed 6 at 125 BPM.
	view.setUint16(64, 1, true)
	view.setUint16(68, 1, true)
	view.setUint16(70, 1, true)
	view.setUint16(72, 1, true)
	view.setUint16(74, 1, true)
	view.setUint16(76, 6, true)
	view.setUint16(78, 125, true)

	// Row 0: C-4 on instrument 1.
	const pattern = Uint8Array.of(9, 0, 0, 0, 0, 1, 0, 5, 0, 49, 1, 0, 0, 0)
	const instrument = new Uint8Array(263 + 40)
	const instrumentView = new DataView(instrument.buffer)

	instrumentView.setUint32(0, 263, true)
	instrument.set(encoder.encode("big"), 4)
	instrumentView.setUint16(27, 1, true)
	instrumentView.setUint32(29, 40, true)
	// The sample: its length, no loop, full volume, centred.
	instrumentView.setUint32(263, sampleBytes, true)
	instrument[263 + 12] = 64
	instrument[263 + 15] = 128

	const bytes = new Uint8Array(header.length + pattern.length + instrument.length + sampleBytes)

	bytes.set(header, 0)
	bytes.set(pattern, header.length)
	bytes.set(instrument, header.length + pattern.length)

	// Delta-coded: a square wave of period 64, a step every 32 bytes.
	const data = header.length + pattern.length + instrument.length

	for (let i = 0; i < sampleBytes; i += 32) {
		bytes[data + i] = (i / 32) % 2 === 0 ? 0x40 : 0xc0
	}

	return bytes
}

// `inner` packed as MMCMP (ziRCONia) in one stored, uncompressed block, as the format allows.
export function mmcmpPacked(inner: Uint8Array): Uint8Array {
	const blockAt = 28
	const dataAt = blockAt + 20 + 8
	const bytes = new Uint8Array(dataAt + inner.length)
	const view = new DataView(bytes.buffer)

	bytes.set(new TextEncoder().encode("ziRCONia"), 0)
	view.setUint16(8, 14, true)
	view.setUint16(10, 0x1300, true)
	view.setUint16(12, 1, true)
	view.setUint32(14, inner.length, true)
	view.setUint32(18, 24, true)
	view.setUint32(24, blockAt, true)
	// The block: its unpacked and packed sizes, the checksum (the XOR of its little-endian words), one sub-block, stored.
	view.setUint32(blockAt, inner.length, true)
	view.setUint32(blockAt + 4, inner.length, true)

	let checksum = 0

	for (let i = 0; i < inner.length; i += 4) {
		checksum ^= (inner[i] ?? 0) | ((inner[i + 1] ?? 0) << 8) | ((inner[i + 2] ?? 0) << 16) | ((inner[i + 3] ?? 0) << 24)
	}

	view.setUint32(blockAt + 8, checksum >>> 0, true)
	view.setUint16(blockAt + 12, 1, true)
	view.setUint32(blockAt + 20, 0, true)
	view.setUint32(blockAt + 24, inner.length, true)
	bytes.set(inner, dataAt)

	return bytes
}

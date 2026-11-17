// Tracker modules generated in code: one square-wave sample struck on the first row of a 64-row pattern, as a
// 31-sample ProTracker MOD ("M.K.", 7.68 s at speed 6 and 125 BPM) or a signature-less 15-sample one.
export function tinyMod(samples: 31 | 15 = 31): Uint8Array {
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
	bytes[sample + 29] = 1
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

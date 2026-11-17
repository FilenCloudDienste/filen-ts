// A QOI encoder after the specification's reference (qoiformat.org, qoi.h): every op the decoder reads, for fixtures.

function signed8(value: number): number {
	return ((value + 128) & 0xff) - 128
}

// `rgba`: width × height pixels, four bytes each. `channels` 3 writes an RGB header (alpha still encoded where it
// changes, as the reference does).
export function encodeQoi(rgba: Uint8Array, width: number, height: number, channels: 3 | 4 = 4): Uint8Array {
	const out: number[] = [0x71, 0x6f, 0x69, 0x66]
	const push32 = (value: number): void => {
		out.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff)
	}

	push32(width)
	push32(height)
	out.push(channels, 0)

	const index = new Uint8Array(64 * 4)
	let pr = 0
	let pg = 0
	let pb = 0
	let pa = 255
	let run = 0
	const last = width * height - 1

	for (let i = 0; i <= last; i++) {
		const r = rgba[i * 4] ?? 0
		const g = rgba[i * 4 + 1] ?? 0
		const b = rgba[i * 4 + 2] ?? 0
		const a = rgba[i * 4 + 3] ?? 0

		if (r === pr && g === pg && b === pb && a === pa) {
			run++

			if (run === 62 || i === last) {
				out.push(0xc0 | (run - 1))
				run = 0
			}

			continue
		}

		if (run > 0) {
			out.push(0xc0 | (run - 1))
			run = 0
		}

		const slot = ((r * 3 + g * 5 + b * 7 + a * 11) % 64) * 4

		if (index[slot] === r && index[slot + 1] === g && index[slot + 2] === b && index[slot + 3] === a) {
			out.push(slot / 4)
		} else {
			index[slot] = r
			index[slot + 1] = g
			index[slot + 2] = b
			index[slot + 3] = a

			if (a === pa) {
				const vr = signed8(r - pr)
				const vg = signed8(g - pg)
				const vb = signed8(b - pb)
				const vgr = vr - vg
				const vgb = vb - vg

				if (vr >= -2 && vr <= 1 && vg >= -2 && vg <= 1 && vb >= -2 && vb <= 1) {
					out.push(0x40 | ((vr + 2) << 4) | ((vg + 2) << 2) | (vb + 2))
				} else if (vgr >= -8 && vgr <= 7 && vg >= -32 && vg <= 31 && vgb >= -8 && vgb <= 7) {
					out.push(0x80 | (vg + 32), ((vgr + 8) << 4) | (vgb + 8))
				} else {
					out.push(0xfe, r, g, b)
				}
			} else {
				out.push(0xff, r, g, b, a)
			}
		}

		pr = r
		pg = g
		pb = b
		pa = a
	}

	out.push(0, 0, 0, 0, 0, 0, 0, 1)

	return Uint8Array.from(out)
}

// A width × height gradient with a translucent band and a flat run: every op of the format.
export function qoiTestPixels(width: number, height: number): Uint8Array {
	const rgba = new Uint8Array(width * height * 4)

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const at = (y * width + x) * 4
			const flat = y === 0

			rgba[at] = flat ? 10 : (x * 7 + y * 3) & 0xff
			rgba[at + 1] = flat ? 20 : (x * 2 + (y % 5)) & 0xff
			rgba[at + 2] = flat ? 30 : (x * 13) & 0xff
			rgba[at + 3] = y === height - 1 ? (x * 31) & 0xff : 255
		}
	}

	return rgba
}

// A minimal JBIG2 encoder (ITU-T T.88) for test fixtures: one page holding one immediate lossless generic region,
// arithmetic coded with template 0 and the nominal adaptive pixels, as an embedded stream (no file header) for a PDF's
// JBIG2Decode filter. Written from the standard: the MQ coder of Annex E and the template 0 context of 6.2.5.3.

// Annex E, Table E.1: Qe, NMPS, NLPS, SWITCH per state.
const QE: readonly (readonly [number, number, number, number])[] = [
	[0x5601, 1, 1, 1],
	[0x3401, 2, 6, 0],
	[0x1801, 3, 9, 0],
	[0x0ac1, 4, 12, 0],
	[0x0521, 5, 29, 0],
	[0x0221, 38, 33, 0],
	[0x5601, 7, 6, 1],
	[0x5401, 8, 14, 0],
	[0x4801, 9, 14, 0],
	[0x3801, 10, 14, 0],
	[0x3001, 11, 17, 0],
	[0x2401, 12, 18, 0],
	[0x1c01, 13, 20, 0],
	[0x1601, 29, 21, 0],
	[0x5601, 15, 14, 1],
	[0x5401, 16, 14, 0],
	[0x5101, 17, 15, 0],
	[0x4801, 18, 16, 0],
	[0x3801, 19, 17, 0],
	[0x3401, 20, 18, 0],
	[0x3001, 21, 19, 0],
	[0x2801, 22, 19, 0],
	[0x2401, 23, 20, 0],
	[0x2201, 24, 21, 0],
	[0x1c01, 25, 22, 0],
	[0x1801, 26, 23, 0],
	[0x1601, 27, 24, 0],
	[0x1401, 28, 25, 0],
	[0x1201, 29, 26, 0],
	[0x1101, 30, 27, 0],
	[0x0ac1, 31, 28, 0],
	[0x09c1, 32, 29, 0],
	[0x08a1, 33, 30, 0],
	[0x0521, 34, 31, 0],
	[0x0441, 35, 32, 0],
	[0x02a1, 36, 33, 0],
	[0x0221, 37, 34, 0],
	[0x0141, 38, 35, 0],
	[0x0111, 39, 36, 0],
	[0x0085, 40, 37, 0],
	[0x0049, 41, 38, 0],
	[0x0025, 42, 39, 0],
	[0x0015, 43, 40, 0],
	[0x0009, 44, 41, 0],
	[0x0005, 45, 42, 0],
	[0x0001, 45, 43, 0],
	[0x5601, 46, 46, 0]
]

function state(index: number): readonly [number, number, number, number] {
	const entry = QE[index]

	if (entry === undefined) throw new Error(`MQ state ${String(index)}`)

	return entry
}

class MqEncoder {
	private a = 0x8000
	private c = 0
	private ct = 12
	// out[0] is the byte before the first one written (Annex E's BPST - 1); never emitted.
	private readonly out: number[] = [0]
	private readonly index = new Uint8Array(1 << 16)
	private readonly mps = new Uint8Array(1 << 16)

	private get b(): number {
		return this.out[this.out.length - 1] ?? 0
	}

	private set b(value: number) {
		this.out[this.out.length - 1] = value
	}

	private byteOut(): void {
		if (this.b === 0xff) {
			this.out.push(this.c >>> 20)
			this.c &= 0xfffff
			this.ct = 7
		} else if (this.c < 0x8000000) {
			this.out.push(this.c >>> 19)
			this.c &= 0x7ffff
			this.ct = 8
		} else {
			this.b = this.b + 1

			if (this.b === 0xff) {
				this.c &= 0x7ffffff
				this.out.push(this.c >>> 20)
				this.c &= 0xfffff
				this.ct = 7
			} else {
				this.out.push(this.c >>> 19)
				this.c &= 0x7ffff
				this.ct = 8
			}
		}
	}

	private renormalise(): void {
		do {
			this.a = (this.a << 1) & 0xffff
			this.c = this.c * 2
			this.ct--

			if (this.ct === 0) this.byteOut()
		} while ((this.a & 0x8000) === 0)
	}

	encode(bit: number, context: number): void {
		const [qe, nmps, nlps, swap] = state(this.index[context] ?? 0)

		this.a -= qe

		if (bit === this.mps[context]) {
			if ((this.a & 0x8000) === 0) {
				if (this.a < qe) this.a = qe
				else this.c += qe

				this.index[context] = nmps
				this.renormalise()
			} else {
				this.c += qe
			}
		} else {
			if (this.a < qe) this.c += qe
			else this.a = qe

			if (swap === 1) this.mps[context] = 1 - (this.mps[context] ?? 0)

			this.index[context] = nlps
			this.renormalise()
		}
	}

	flush(): Uint8Array {
		const temp = this.c + this.a

		this.c |= 0xffff

		if (this.c >= temp) this.c -= 0x8000

		this.c = this.c * 2 ** this.ct
		this.byteOut()
		this.c = this.c * 2 ** this.ct
		this.byteOut()

		if (this.b !== 0xff) this.out.push(0xff)

		this.out.push(0xac)

		return Uint8Array.from(this.out.slice(1))
	}
}

// A 1-bit image, 1 = black, rows top to bottom.
export interface Bitmap {
	readonly width: number
	readonly height: number
	readonly pixel: (x: number, y: number) => boolean
}

// The nominal adaptive pixels of template 0: A1..A4.
const AT: readonly number[] = [3, -1, -3, -1, 2, -2, -2, -2]

function generic(bitmap: Bitmap): Uint8Array {
	const { width, height } = bitmap
	const bits = new Uint8Array(width * height)

	for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) bits[y * width + x] = bitmap.pixel(x, y) ? 1 : 0

	const at = (x: number, y: number): number => (x < 0 || y < 0 || x >= width || y >= height ? 0 : (bits[y * width + x] ?? 0))
	const atPixel = (x: number, y: number, k: number): number => at(x + (AT[k * 2] ?? 0), y + (AT[k * 2 + 1] ?? 0))
	const coder = new MqEncoder()

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const context =
				at(x - 1, y) |
				(at(x - 2, y) << 1) |
				(at(x - 3, y) << 2) |
				(at(x - 4, y) << 3) |
				(atPixel(x, y, 0) << 4) |
				(at(x + 2, y - 1) << 5) |
				(at(x + 1, y - 1) << 6) |
				(at(x, y - 1) << 7) |
				(at(x - 1, y - 1) << 8) |
				(at(x - 2, y - 1) << 9) |
				(atPixel(x, y, 1) << 10) |
				(atPixel(x, y, 2) << 11) |
				(at(x + 1, y - 2) << 12) |
				(at(x, y - 2) << 13) |
				(at(x - 1, y - 2) << 14) |
				(atPixel(x, y, 3) << 15)

			coder.encode(bits[y * width + x] ?? 0, context)
		}
	}

	return coder.flush()
}

function u32(value: number): number[] {
	return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]
}

// Segment header (7.2): number, flags (type; one-byte page association), no referred-to segments, page 1, length.
function segment(number: number, type: number, data: readonly number[] | Uint8Array): number[] {
	return [...u32(number), type & 0x3f, 0x00, 0x01, ...u32(data.length), ...data]
}

export function jbig2Embedded(bitmap: Bitmap): Uint8Array {
	const { width, height } = bitmap
	// 7.4.8: page information, width, height, no resolution, flags 0 (default pixel 0, OR), no striping.
	const page = [...u32(width), ...u32(height), ...u32(0), ...u32(0), 0x00, 0x00, 0x00]
	// 7.4.1 region info (width, height, x, y, OR) + 7.4.6.2 flags (arithmetic, template 0, no TPGDON) + AT pixels.
	const region = [...u32(width), ...u32(height), ...u32(0), ...u32(0), 0x00, 0x00, ...AT.map(value => value & 0xff), ...generic(bitmap)]

	return Uint8Array.from([...segment(0, 48, page), ...segment(1, 38, region), ...segment(2, 49, [])])
}

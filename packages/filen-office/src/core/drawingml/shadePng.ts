import { Zlib } from "fflate"
import { crc32 } from "../opc/crc32"

// A PNG of top-down RGBA pixels (colour type 6, Sub-filtered rows: a shaded raster's smooth gradients deflate well)
// encoded in steps, so the page's thread encodes a large raster in slices; each deflate output is an IDAT chunk of
// its own (ISO/IEC 15948 §11.2.4 allows any number). A browser's own canvas encoder runs on the page's thread in some
// engines, for hundreds of milliseconds at once on a large raster.

const SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
// Rows filtered and deflated between two looks at the clock.
const STEP_ROWS = 16

function chunk(type: string, body: Uint8Array): Uint8Array {
	const out = new Uint8Array(12 + body.length)
	const view = new DataView(out.buffer)

	view.setUint32(0, body.length)

	for (let k = 0; k < 4; k++) out[4 + k] = type.charCodeAt(k)

	out.set(body, 8)
	view.setUint32(8 + body.length, crc32(body, crc32(out.subarray(4, 8))) >>> 0)

	return out
}

export class PngSteps {
	private readonly parts: Uint8Array<ArrayBuffer>[] = []
	private readonly zlib: Zlib
	private y = 0
	private ended = false

	private readonly rgba: Uint8Array
	private readonly width: number
	private readonly height: number

	constructor(rgba: Uint8Array, width: number, height: number) {
		this.rgba = rgba
		this.width = width
		this.height = height

		const header = new Uint8Array(13)
		const view = new DataView(header.buffer)

		view.setUint32(0, width)
		view.setUint32(4, height)
		header[8] = 8
		header[9] = 6
		this.parts.push(SIGNATURE.slice(), chunk("IHDR", header) as Uint8Array<ArrayBuffer>)
		this.zlib = new Zlib({ level: 2 }, data => {
			if (data.length > 0) this.parts.push(chunk("IDAT", data) as Uint8Array<ArrayBuffer>)
		})
	}

	// Encodes rows until done or `stop()` says to; whether it is done.
	step(stop: () => boolean = () => false): boolean {
		const stride = this.width * 4
		const rgba = this.rgba

		while (this.y < this.height) {
			const rows = Math.min(STEP_ROWS, this.height - this.y)
			const band = new Uint8Array((stride + 1) * rows)

			for (let r = 0; r < rows; r++, this.y++) {
				const from = this.y * stride
				const to = r * (stride + 1)

				// Filter type 1 (Sub): each byte less the byte one pixel to its left.
				band[to] = 1

				for (let k = 0; k < 4; k++) band[to + 1 + k] = rgba[from + k] ?? 0
				for (let k = 4; k < stride; k++) band[to + 1 + k] = ((rgba[from + k] ?? 0) - (rgba[from + k - 4] ?? 0)) & 255
			}

			this.zlib.push(band, false)

			if (this.y < this.height && stop()) return false
		}

		if (!this.ended) {
			this.ended = true
			this.zlib.push(new Uint8Array(0), true)
			this.parts.push(chunk("IEND", new Uint8Array(0)) as Uint8Array<ArrayBuffer>)
		}

		return true
	}

	// The file's parts, in order (for a Blob).
	result(): readonly Uint8Array<ArrayBuffer>[] {
		return this.parts
	}
}

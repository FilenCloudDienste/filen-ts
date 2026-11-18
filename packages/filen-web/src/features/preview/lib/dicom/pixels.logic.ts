// From a frame's decoded samples to the RGBA drawn (PS3.3 C.7.6.3, C.11): stored values masked to Bits Stored below
// High Bit and sign-extended for Pixel Representation 1, the modality rescale, the VOI window, MONOCHROME1's inversion;
// colour as RGB, YBR_FULL, YBR_FULL_422 or through the palette. Grey levels go through a lookup table indexed by the
// stored bit pattern (at most 2^16 entries), rebuilt when the window changes, so a frame is never copied to wider
// numbers. A frame larger than the canvas is sampled down while it is converted, never after.

export type VoiFunction = "LINEAR" | "LINEAR_EXACT" | "SIGMOID"

export interface Window {
	readonly center: number
	readonly width: number
}

// How the samples in hand read: their colour model as decoded (a decoder may have converted a YBR codestream), and
// where Bits Stored sits in each sample's container.
// "rgba": a browser decode's RGBA, as it came (alpha ignored).
export type SampleColor = "gray" | "rgb" | "rgba" | "ybrFull" | "ybrFull422" | "palette"

export interface FrameSamples {
	readonly data: Uint8Array | Uint16Array | Uint32Array
	readonly rows: number
	readonly columns: number
	readonly samplesPerPixel: number
	readonly color: SampleColor
	// Colour planes one after another rather than pixel-interleaved.
	readonly planar: boolean
	// Bits below the stored value (High Bit + 1 − Bits Stored for native and RLE data; decoders right-align).
	readonly shift: number
}

export interface GrayModel {
	readonly bitsStored: number
	readonly signed: boolean
	readonly slope: number
	readonly intercept: number
	readonly voiFunction: VoiFunction
	// MONOCHROME1: low values are white.
	readonly inverted: boolean
}

export interface Palette {
	readonly entries: number
	// The first stored value the table maps.
	readonly first: number
	// Per channel, 8-bit levels.
	readonly red: Uint8Array
	readonly green: Uint8Array
	readonly blue: Uint8Array
}

const MAX_LUT_BITS = 16

// The stored value of `raw`: Bits Stored bits above `shift`, sign-extended when signed.
export function storedValue(raw: number, bitsStored: number, shift: number, signed: boolean): number {
	const pattern = bitsStored >= 32 ? raw >>> shift : (raw >>> shift) & (2 ** bitsStored - 1)

	return signed && pattern >= 2 ** (bitsStored - 1) ? pattern - 2 ** bitsStored : pattern
}

// The display level (0–255) of modality value `x` under `window` (PS3.3 C.11.2.1.2).
export function voi(x: number, window: Window, fn: VoiFunction): number {
	const { center, width } = window

	if (fn === "SIGMOID") {
		return 255 / (1 + Math.exp((-4 * (x - center)) / Math.max(width, Number.EPSILON)))
	}

	if (fn === "LINEAR_EXACT") {
		if (width <= 0) return x <= center ? 0 : 255
		if (x <= center - width / 2) return 0
		if (x > center + width / 2) return 255

		return ((x - center) / width + 0.5) * 255
	}

	const w = Math.max(width, 1)

	if (x <= center - 0.5 - (w - 1) / 2) return 0
	if (x > center - 0.5 + (w - 1) / 2) return 255

	return ((x - (center - 0.5)) / (w - 1) + 0.5) * 255
}

// Whether grey levels go through a table (Bits Stored ≤ 16) rather than per pixel.
export function lutFits(model: GrayModel): boolean {
	return model.bitsStored <= MAX_LUT_BITS
}

// Bit pattern → display level, for every pattern Bits Stored can hold; `invert` flips it once more (the viewer's own
// Invert, on top of MONOCHROME1).
export function grayLut(model: GrayModel, window: Window, invert: boolean): Uint8Array {
	const size = 2 ** model.bitsStored
	const lut = new Uint8Array(size)
	const flip = model.inverted !== invert

	for (let pattern = 0; pattern < size; pattern++) {
		const stored = model.signed && pattern >= size / 2 ? pattern - size : pattern
		const level = Math.round(voi(stored * model.slope + model.intercept, window, model.voiFunction))

		lut[pattern] = flip ? 255 - level : level
	}

	return lut
}

// The smallest and largest modality values in the frame.
export function modalityRange(samples: FrameSamples, model: GrayModel): { min: number; max: number } {
	const { data, shift } = samples
	let min = Number.POSITIVE_INFINITY
	let max = Number.NEGATIVE_INFINITY

	for (const raw of data) {
		const value = storedValue(raw, model.bitsStored, shift, model.signed)

		if (value < min) min = value
		if (value > max) max = value
	}

	if (min > max) return { min: 0, max: 0 }

	const a = min * model.slope + model.intercept
	const b = max * model.slope + model.intercept

	return { min: Math.min(a, b), max: Math.max(a, b) }
}

// The window that spans the whole range.
export function rangeWindow(range: { min: number; max: number }): Window {
	return { center: (range.min + range.max) / 2, width: Math.max(1, range.max - range.min + 1) }
}

// Every `step`th pixel each way: the size drawn of a frame larger than the canvas allows.
export function downsampleStep(rows: number, columns: number, maxSide: number): number {
	return Math.max(1, Math.ceil(Math.max(rows, columns) / Math.max(1, maxSide)))
}

export interface Drawn {
	readonly width: number
	readonly height: number
	readonly step: number
}

export function drawnSize(samples: Pick<FrameSamples, "rows" | "columns">, maxSide: number): Drawn {
	const step = downsampleStep(samples.rows, samples.columns, maxSide)

	return { width: Math.ceil(samples.columns / step), height: Math.ceil(samples.rows / step), step }
}

// Grey samples into `out` (RGBA, `drawn` size) through `lut` (grayLut), or per pixel when Bits Stored is too wide for one.
export function renderGray(
	samples: FrameSamples,
	model: GrayModel,
	window: Window,
	invert: boolean,
	lut: Uint8Array | null,
	drawn: Drawn,
	out: Uint8ClampedArray
): void {
	const { data, columns, shift } = samples
	const { width, height, step } = drawn
	const mask = model.bitsStored >= 32 ? 0xffffffff : 2 ** model.bitsStored - 1
	const flip = model.inverted !== invert

	const level = (raw: number): number => {
		const value = storedValue(raw, model.bitsStored, shift, model.signed)
		const shown = Math.round(voi(value * model.slope + model.intercept, window, model.voiFunction))

		return flip ? 255 - shown : shown
	}
	let at = 0

	for (let y = 0; y < height; y++) {
		const row = y * step * columns

		for (let x = 0; x < width; x++, at += 4) {
			const raw = data[row + x * step] ?? 0
			const shown = lut === null ? level(raw) : (lut[(raw >>> shift) & mask] ?? 0)

			out[at] = shown
			out[at + 1] = shown
			out[at + 2] = shown
			out[at + 3] = 255
		}
	}
}

// One channel as an 8-bit level: wider samples keep their top 8 stored bits.
function channelLevel(raw: number, shift: number, bitsStored: number): number {
	const value = bitsStored >= 32 ? raw >>> shift : (raw >>> shift) & (2 ** bitsStored - 1)

	return bitsStored > 8 ? Math.floor(value / 2 ** (bitsStored - 8)) : value
}

function clampByte(value: number): number {
	return value < 0 ? 0 : value > 255 ? 255 : Math.round(value)
}

// YBR_FULL (PS3.3 C.7.6.3.1.2) to RGB, into `out` at `at`.
function ybrToRgb(y: number, cb: number, cr: number, out: Uint8ClampedArray, at: number): void {
	out[at] = clampByte(y + 1.402 * (cr - 128))
	out[at + 1] = clampByte(y - 0.344136 * (cb - 128) - 0.714136 * (cr - 128))
	out[at + 2] = clampByte(y + 1.772 * (cb - 128))
}

// Colour samples (RGB, a decoder's RGBA, YBR_FULL or YBR_FULL_422) into `out`; `invert` flips every channel.
export function renderColor(samples: FrameSamples, bitsStored: number, invert: boolean, drawn: Drawn, out: Uint8ClampedArray): void {
	const { data, rows, columns, color, planar, shift } = samples
	const { width, height, step } = drawn
	const plane = rows * columns

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const pixel = y * step * columns + x * step
			const at = (y * width + x) * 4

			if (color === "ybrFull422") {
				// Y1 Y2 Cb Cr for each pair of pixels.
				const pair = Math.floor(pixel / 2) * 4

				ybrToRgb(data[pair + (pixel % 2)] ?? 0, data[pair + 2] ?? 0, data[pair + 3] ?? 0, out, at)
			} else if (color === "rgba") {
				out[at] = data[pixel * 4] ?? 0
				out[at + 1] = data[pixel * 4 + 1] ?? 0
				out[at + 2] = data[pixel * 4 + 2] ?? 0
			} else {
				const a = channelLevel(data[planar ? pixel : pixel * 3] ?? 0, shift, bitsStored)
				const b = channelLevel(data[planar ? plane + pixel : pixel * 3 + 1] ?? 0, shift, bitsStored)
				const c = channelLevel(data[planar ? plane * 2 + pixel : pixel * 3 + 2] ?? 0, shift, bitsStored)

				if (color === "ybrFull") {
					ybrToRgb(a, b, c, out, at)
				} else {
					out[at] = a
					out[at + 1] = b
					out[at + 2] = c
				}
			}

			if (invert) {
				out[at] = 255 - (out[at] ?? 0)
				out[at + 1] = 255 - (out[at + 1] ?? 0)
				out[at + 2] = 255 - (out[at + 2] ?? 0)
			}

			out[at + 3] = 255
		}
	}
}

// PALETTE COLOR samples through `palette`; values outside the table take its first or last entry.
export function renderPalette(
	samples: FrameSamples,
	bitsStored: number,
	signed: boolean,
	palette: Palette,
	invert: boolean,
	drawn: Drawn,
	out: Uint8ClampedArray
): void {
	const { data, columns, shift } = samples
	const { width, height, step } = drawn
	const last = palette.entries - 1

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const value = storedValue(data[y * step * columns + x * step] ?? 0, bitsStored, shift, signed)
			const index = Math.min(last, Math.max(0, value - palette.first))
			const at = (y * width + x) * 4
			const red = palette.red[index] ?? 0
			const green = palette.green[index] ?? 0
			const blue = palette.blue[index] ?? 0

			out[at] = invert ? 255 - red : red
			out[at + 1] = invert ? 255 - green : green
			out[at + 2] = invert ? 255 - blue : blue
			out[at + 3] = 255
		}
	}
}

// A palette channel from its descriptor (entries, first mapped value, bits per entry) and data: 8-bit levels. The data is
// one 16-bit word per entry (the top byte kept for 16-bit entries), or one byte per entry where 8-bit entries were
// packed that way.
export function paletteChannel(descriptor: readonly number[], data: Uint8Array, littleEndian: boolean): Uint8Array | null {
	const [declared, , bits] = descriptor

	if (declared === undefined || bits === undefined) return null

	const entries = declared === 0 ? 65_536 : declared
	const channel = new Uint8Array(entries)

	if (bits === 8 && data.length === entries) {
		channel.set(data)

		return channel
	}

	if (data.length < entries * 2) return null

	const view = new DataView(data.buffer, data.byteOffset, data.byteLength)

	for (let i = 0; i < entries; i++) {
		const word = view.getUint16(i * 2, littleEndian)

		channel[i] = bits === 8 ? word & 0xff : word >> 8
	}

	return channel
}

// The palette's first mapped value, read as the descriptor's VR says: signed when the pixels are.
export function paletteFirst(raw: number, signed: boolean): number {
	return signed && raw >= 0x8000 ? raw - 0x10000 : raw
}

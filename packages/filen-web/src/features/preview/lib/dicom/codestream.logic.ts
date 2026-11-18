// The size a compressed frame's codestream declares, read from its first bytes before any decoder is called, the way
// that frame's decoder reads it: a JPEG's SOFn (P, Y, X, Nf) as libjpeg finds it, a lossless JPEG's frame and first scan
// as jpeg-lossless-decoder-js walks to them, JPEG-LS's SOF55 (refusing LSE's oversize dimensions, which would replace
// it), and JPEG 2000's SIZ (with COD's decomposition levels). The frame is refused when the header does not match the
// tags, and the larger of the two is what the pixel budget sees.

export interface CodestreamHeader {
	readonly rows: number
	readonly columns: number
	readonly components: number
	// Sample precision in bits.
	readonly bits: number
	// JPEG 2000: decomposition levels (COD), the reductions a decode can ask for.
	readonly levels: number
	// JPEG 2000: the image's origin on the reference grid (XOsiz, YOsiz), which a reduced resolution's size depends on;
	// 0 for the other codestreams.
	readonly x0: number
	readonly y0: number
}

function u16(bytes: Uint8Array, at: number): number | null {
	const high = bytes[at]
	const low = bytes[at + 1]

	return high === undefined || low === undefined ? null : (high << 8) | low
}

function u32(bytes: Uint8Array, at: number): number | null {
	const high = u16(bytes, at)
	const low = u16(bytes, at + 2)

	return high === null || low === null ? null : high * 0x10000 + low
}

// SOF0–SOF15 but DHT (C4), JPG (C8) and DAC (CC).
function isSof(marker: number): boolean {
	return marker >= 0xffc0 && marker <= 0xffcf && marker !== 0xffc4 && marker !== 0xffc8 && marker !== 0xffcc
}

// A JPEG's frame header as libjpeg reads it (the browser's decoder): SOI, then marker segments by their lengths (fill
// bytes 0xFF allowed before a marker), until the first SOFn.
export function jpegFrameHeader(bytes: Uint8Array): CodestreamHeader | null {
	if (u16(bytes, 0) !== 0xffd8) return null

	let at = 2

	for (;;) {
		if (bytes[at] !== 0xff) return null

		while (bytes[at] === 0xff) at++

		const code = bytes[at]

		if (code === undefined) return null

		const marker = 0xff00 | code

		at++

		// Markers without a segment.
		if (marker === 0xffd8 || marker === 0xff01 || (marker >= 0xffd0 && marker <= 0xffd7)) continue

		const length = u16(bytes, at)

		if (length === null || length < 2) return null

		if (isSof(marker)) {
			const precision = bytes[at + 2]
			const rows = u16(bytes, at + 3)
			const columns = u16(bytes, at + 5)
			const components = bytes[at + 7]

			if (precision === undefined || rows === null || columns === null || components === undefined) return null

			return { rows, columns, components, bits: precision, levels: 0, x0: 0, y0: 0 }
		}

		if (marker === 0xffda || marker === 0xffd9) return null

		at += length
	}
}

// A lossless JPEG's frame and its first scan, walked exactly as jpeg-lossless-decoder-js 2.1.2's Decoder.decode does
// (its readers consume what their segments declare, APPn and COM their length, DRI four bytes, any other 0xFFxx only
// itself), since the decoder allocates X × Y × the first scan's component count before decoding. `components` is the
// scan's; a frame declaring another count is refused.
export function losslessJpegHeader(bytes: Uint8Array): CodestreamHeader | null {
	let at = 0
	const next = (): number | null => {
		const value = u16(bytes, at)

		at += 2

		return value
	}
	// The segment at `at` (its length first) that a reader consumes whole, as the library's do once they don't throw.
	const skipSegment = (): boolean => {
		const length = u16(bytes, at)

		if (length === null) return false

		at += Math.max(2, length)

		return true
	}
	// A marker the walk handles the library's way: false to refuse the stream.
	const handle = (marker: number): boolean => {
		if (marker === 0xffcc) return false
		if (marker === 0xffc4 || marker === 0xffdb || (marker >= 0xffe0 && marker <= 0xffef) || marker === 0xfffe) return skipSegment()

		if (marker === 0xffdd) {
			const length = next()

			at += 2

			return length === 4
		}

		return marker >> 8 === 0xff
	}

	if (next() !== 0xffd8) return null

	let marker = next()

	while (marker !== null && (marker >> 4 !== 0x0ffc || marker === 0xffc4)) {
		if (!handle(marker)) return null

		marker = next()
	}

	if (marker === null || marker < 0xffc0 || marker > 0xffc7) return null

	const frameLength = u16(bytes, at)
	const precision = bytes[at + 2]
	const rows = u16(bytes, at + 3)
	const columns = u16(bytes, at + 5)
	const frameComponents = bytes[at + 7]

	if (frameLength === null || precision === undefined || rows === null || columns === null || frameComponents === undefined) return null
	if (frameLength !== 8 + frameComponents * 3) return null

	at += frameLength
	marker = next()

	while (marker !== null && marker !== 0xffda) {
		if (!handle(marker)) return null

		marker = next()
	}

	const scanComponents = bytes[at + 2]

	if (marker === null || scanComponents === undefined || scanComponents !== frameComponents) return null

	return { rows, columns, components: scanComponents, bits: precision, levels: 0, x0: 0, y0: 0 }
}

// JPEG-LS (ITU-T T.87): SOF55's dimensions, read by segment length from SOI to SOS. An LSE segment of type 4 (oversize
// dimensions) would replace them, so a stream carrying one is refused.
export function jpegLsHeader(bytes: Uint8Array): CodestreamHeader | null {
	if (u16(bytes, 0) !== 0xffd8) return null

	let at = 2
	let header: CodestreamHeader | null = null

	for (;;) {
		const marker = u16(bytes, at)
		const length = u16(bytes, at + 2)

		if (marker === null || length === null || length < 2 || marker >> 8 !== 0xff) return null

		if (marker === 0xffda) return header

		if (marker === 0xfff7) {
			const precision = bytes[at + 4]
			const rows = u16(bytes, at + 5)
			const columns = u16(bytes, at + 7)
			const components = bytes[at + 9]

			if (precision === undefined || rows === null || columns === null || components === undefined) return null

			header = { rows, columns, components, bits: precision, levels: 0, x0: 0, y0: 0 }
		} else if (marker === 0xfff8 && bytes[at + 4] === 4) {
			return null
		}

		at += 2 + length
	}
}

// JPEG 2000 Part 1 / HTJ2K (Part 15): a raw codestream, SOC then SIZ, every component at full resolution and of one
// depth, at most 65,535 tiles; COD's decomposition levels from the main header (up to the first tile part).
export function jpeg2000Header(bytes: Uint8Array): CodestreamHeader | null {
	if (u16(bytes, 0) !== 0xff4f || u16(bytes, 2) !== 0xff51) return null

	const sizLength = u16(bytes, 4)
	const xsiz = u32(bytes, 8)
	const ysiz = u32(bytes, 12)
	const xosiz = u32(bytes, 16)
	const yosiz = u32(bytes, 20)
	const xtsiz = u32(bytes, 24)
	const ytsiz = u32(bytes, 28)
	const xtosiz = u32(bytes, 32)
	const ytosiz = u32(bytes, 36)
	const components = u16(bytes, 40)

	if (sizLength === null || xsiz === null || ysiz === null || xosiz === null || yosiz === null || components === null) return null
	if (xtsiz === null || ytsiz === null || xtosiz === null || ytosiz === null) return null
	if (components < 1 || sizLength !== 38 + components * 3 || xosiz >= xsiz || yosiz >= ysiz) return null
	// A tile part's index is 16 bits: the decoders refuse more tiles (OpenJPEG before allocating its tile array).
	if (xtsiz < 1 || ytsiz < 1 || Math.ceil((xsiz - xtosiz) / xtsiz) * Math.ceil((ysiz - ytosiz) / ytsiz) > 65_535) return null

	let bits = 0

	for (let c = 0; c < components; c++) {
		const ssiz = bytes[42 + c * 3]
		const xr = bytes[43 + c * 3]
		const yr = bytes[44 + c * 3]

		if (ssiz === undefined || xr !== 1 || yr !== 1) return null

		const depth = (ssiz & 0x7f) + 1

		if (c > 0 && depth !== bits) return null

		bits = depth
	}

	let at = 4 + sizLength
	let levels = -1

	for (;;) {
		const marker = u16(bytes, at)

		if (marker === null || marker === 0xff90 || marker === 0xff93) break

		const length = u16(bytes, at + 2)

		if (length === null || length < 2) break

		if (marker === 0xff52) levels = bytes[at + 9] ?? -1

		at += 2 + length
	}

	if (levels < 0) return null

	return { rows: ysiz - yosiz, columns: xsiz - xosiz, components, bits, levels, x0: xosiz, y0: yosiz }
}

// Whether a JPEG 2000 codestream ends with its EOC marker (FFD9), allowing the one byte a fragment is padded with.
export function endsCodestream(bytes: Uint8Array): boolean {
	const end = bytes.length
	const at = (from: number): boolean => bytes[from - 2] === 0xff && bytes[from - 1] === 0xd9

	return at(end) || (end > 2 && (bytes[end - 1] === 0x00 || bytes[end - 1] === 0xff) && at(end - 1))
}

export interface FrameTags {
	readonly rows: number
	readonly columns: number
	readonly samplesPerPixel: number
	readonly bitsAllocated: number
	readonly bitsStored: number
}

// Whether the codestream declares the frame the tags do. Its precision may exceed Bits Stored, as PS3.5 8.2 allows
// (the samples still hold Bits Stored's values, which is what the pipeline masks to), up to the Bits Allocated the
// decoded samples are held in; the size and the components must be the tags' own.
export function matchesTags(header: CodestreamHeader, tags: FrameTags): boolean {
	return (
		header.rows === tags.rows &&
		header.columns === tags.columns &&
		header.components === tags.samplesPerPixel &&
		header.bits >= tags.bitsStored &&
		header.bits <= tags.bitsAllocated
	)
}

// The larger of the two declarations, in pixels.
export function declaredPixels(header: CodestreamHeader, tags: FrameTags): number {
	return Math.max(header.rows * header.columns, tags.rows * tags.columns)
}

// A JPEG 2000 resolution's size `level` reductions down, as the decoders size it (ISO/IEC 15444-1 B.5): the image's
// extent on the reference grid divided by 2^level, rounding up at both its edges, so an image whose origin is not on
// that grid loses or keeps a row the plain halving would not.
export function reducedSize(
	header: Pick<CodestreamHeader, "rows" | "columns" | "x0" | "y0">,
	level: number
): { rows: number; columns: number } {
	const scale = 2 ** level
	const edge = (from: number, extent: number): number => Math.ceil((from + extent) / scale) - Math.ceil(from / scale)

	return { rows: edge(header.y0, header.rows), columns: edge(header.x0, header.columns) }
}

// The fewest reductions that bring the frame within `pixels`, or null when even the most the stream has do not.
export function reductionWithin(header: CodestreamHeader, pixels: number): number | null {
	for (let level = 0; level <= header.levels; level++) {
		const size = reducedSize(header, level)

		if (size.rows * size.columns <= pixels) return level
	}

	return null
}

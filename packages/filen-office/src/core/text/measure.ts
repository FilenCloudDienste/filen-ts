// Text measurement: the platform measures (canvas measureText in a worker on web), the core caches.
// Widths are cached per (font, string) in open-addressing tables whose keys are copied into a UTF-16
// arena (never kept as slices of paragraph strings), looked up straight from text ranges so a hit
// allocates nothing. Misses can be queued and measured font by font, since switching the canvas font
// costs more than measuring (most of all in Firefox).

export interface FontExtents {
	// Pixels above and below the baseline.
	readonly ascent: number
	readonly descent: number
}

export interface TextMeasurer {
	// Whether measure() honours kerning: false. Without it (WebKit's canvas always kerns) unkerned widths
	// are summed per character, which equals the font's advance widths.
	readonly kerningControl: boolean
	// Advance widths in px of texts[0, count) drawn with `font` (CSS font shorthand), written to widths.
	measure(font: string, kerning: boolean, texts: readonly string[], count: number, widths: Float64Array): void
	// Ascent and descent of the font, for faces whose vertical metrics are unknown.
	fontExtents(font: string): FontExtents
}

const EMPTY = -1
// Entries per generation; two generations are kept.
const DEFAULT_LIMIT = 1 << 16
// Longer strings are measured but not cached: words are short, and long runs are measured once.
export const MAX_CACHED_LENGTH = 64

function hashRange(font: number, text: string, start: number, end: number): number {
	let hash = Math.imul(0x811c9dc5 ^ font, 0x01000193)

	for (let i = start; i < end; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193)

	return hash | 0
}

// One hash table with its key arena.
class Generation {
	size = 0
	widths: Float64Array
	private mask: number
	private fonts: Int32Array
	private hashes: Int32Array
	private keyStart: Int32Array
	private keyLength: Uint8Array
	private chars: Uint16Array
	private used = 0

	constructor(capacity: number) {
		this.mask = capacity - 1
		this.fonts = new Int32Array(capacity).fill(EMPTY)
		this.hashes = new Int32Array(capacity)
		this.keyStart = new Int32Array(capacity)
		this.keyLength = new Uint8Array(capacity)
		this.widths = new Float64Array(capacity)
		this.chars = new Uint16Array(capacity * 8)
	}

	find(font: number, hash: number, text: string, start: number, end: number): number {
		const length = end - start

		for (let slot = hash & this.mask; ; slot = (slot + 1) & this.mask) {
			const slotFont = this.fonts[slot] ?? EMPTY

			if (slotFont === EMPTY) return -1
			if (slotFont !== font || this.hashes[slot] !== hash || this.keyLength[slot] !== length) continue

			const at = this.keyStart[slot] ?? 0
			let equal = true

			for (let i = 0; i < length; i++) {
				if (this.chars[at + i] !== text.charCodeAt(start + i)) {
					equal = false
					break
				}
			}

			if (equal) return slot
		}
	}

	insert(font: number, hash: number, text: string, start: number, end: number, width: number): void {
		const length = end - start

		if ((this.size + 1) * 2 > this.mask + 1) this.grow()

		if (this.used + length > this.chars.length) {
			const chars = new Uint16Array(Math.max(this.chars.length * 2, this.used + length))

			chars.set(this.chars.subarray(0, this.used))
			this.chars = chars
		}

		let slot = hash & this.mask

		while ((this.fonts[slot] ?? EMPTY) !== EMPTY) slot = (slot + 1) & this.mask

		for (let i = 0; i < length; i++) this.chars[this.used + i] = text.charCodeAt(start + i)

		this.fonts[slot] = font
		this.hashes[slot] = hash
		this.keyStart[slot] = this.used
		this.keyLength[slot] = length
		this.widths[slot] = width
		this.used += length
		this.size++
	}

	private grow(): void {
		const fonts = this.fonts
		const hashes = this.hashes
		const keyStart = this.keyStart
		const keyLength = this.keyLength
		const widths = this.widths
		const capacity = (this.mask + 1) * 2

		this.mask = capacity - 1
		this.fonts = new Int32Array(capacity).fill(EMPTY)
		this.hashes = new Int32Array(capacity)
		this.keyStart = new Int32Array(capacity)
		this.keyLength = new Uint8Array(capacity)
		this.widths = new Float64Array(capacity)

		for (let i = 0; i < fonts.length; i++) {
			if ((fonts[i] ?? EMPTY) === EMPTY) continue

			let slot = (hashes[i] ?? 0) & this.mask

			while ((this.fonts[slot] ?? EMPTY) !== EMPTY) slot = (slot + 1) & this.mask

			this.fonts[slot] = fonts[i] ?? EMPTY
			this.hashes[slot] = hashes[i] ?? 0
			this.keyStart[slot] = keyStart[i] ?? 0
			this.keyLength[slot] = keyLength[i] ?? 0
			this.widths[slot] = widths[i] ?? 0
		}
	}
}

export class MeasureCache {
	readonly measurer: TextMeasurer
	private readonly limit: number

	private readonly fontIds = new Map<string, number>()
	private fontNames: string[] = []
	private fontKerning: boolean[] = []
	// Per font: sum per-character widths instead of measuring whole strings.
	private fontSummed: boolean[] = []

	// Lookups try the current generation, then the previous one (hits are promoted); a full current
	// generation becomes the previous one, so a working set larger than one generation does not thrash.
	private current = new Generation(1024)
	private previous: Generation | null = null

	private pendingTexts: string[] = []
	private pendingFonts = new Int32Array(64)
	private pendingCached = new Uint8Array(64)
	private pendingCount = 0
	private batchTexts: string[] = []
	private batchIndex = new Int32Array(64)
	private batchWidths = new Float64Array(64)
	private results = new Float64Array(64)
	private readonly single: string[] = [""]
	private readonly singleWidth = new Float64Array(1)

	// After request() returns NaN: the queue position whose width result() reports after flush(), or -1
	// when the width needs another request() after the flush (already queued, or summed per character).
	ticket = -1

	// `limit` caps the cached strings per generation.
	constructor(measurer: TextMeasurer, limit = DEFAULT_LIMIT) {
		this.measurer = measurer
		this.limit = limit
	}

	// A small integer for (CSS font, kerning), the font argument of the other methods.
	font(css: string, kerning: boolean): number {
		const key = kerning ? css : `${css}\u0000`
		let id = this.fontIds.get(key)

		if (id === undefined) {
			id = this.fontNames.length
			this.fontIds.set(key, id)
			this.fontNames.push(css)
			this.fontKerning.push(kerning)
			this.fontSummed.push(!kerning && !this.measurer.kerningControl)
		}

		return id
	}

	css(font: number): string {
		return this.fontNames[font] ?? ""
	}

	// Whether `font` is measured with kerning.
	kerning(font: number): boolean {
		return this.fontKerning[font] ?? true
	}

	get entries(): number {
		return this.current.size + (this.previous?.size ?? 0)
	}

	// Width of text[start, end) in `font`, measured now on a miss.
	width(font: number, text: string, start: number, end: number): number {
		const width = this.request(font, text, start, end)

		if (!Number.isNaN(width)) return width

		const ticket = this.ticket

		this.flush()

		return ticket >= 0 ? this.result(ticket) : this.request(font, text, start, end)
	}

	// Width of text[start, end) measured now and not cached, for prefixes probed while fitting or hit
	// testing. Per-character sums still use the character cache.
	measure(font: number, text: string, start: number, end: number): number {
		if (start >= end) return 0
		if (this.fontSummed[font] === true) return this.width(font, text, start, end)

		this.single[0] = text.slice(start, end)
		this.measurer.measure(this.fontNames[font] ?? "", this.fontKerning[font] ?? true, this.single, 1, this.singleWidth)
		this.single[0] = ""

		return this.singleWidth[0] ?? 0
	}

	// Width of text[start, end), or NaN with what is missing queued for flush() (see `ticket`).
	request(font: number, text: string, start: number, end: number): number {
		this.ticket = -1

		if (start >= end) return 0
		if (this.fontSummed[font] !== true) return this.lookupOrQueue(font, text, start, end)

		let sum = 0

		for (let i = start; i < end;) {
			const step = i + 1 < end && isLead(text.charCodeAt(i)) && isTrail(text.charCodeAt(i + 1)) ? 2 : 1

			sum += this.lookupOrQueue(font, text, i, i + step)
			i += step
		}

		this.ticket = -1

		return sum
	}

	// A width queued by request(), valid until the next flush().
	result(ticket: number): number {
		return this.results[ticket] ?? Number.NaN
	}

	// Measures everything request() queued, one measurer call per font. Never drops cached entries.
	flush(): void {
		const count = this.pendingCount

		if (count === 0) return

		const fonts = this.pendingFonts
		const texts = this.pendingTexts

		// Generations turn over only here, before results are stored: a request() between flushes never
		// loses an entry it was promised (a generation may overrun the limit by one batch).
		if (this.current.size >= this.limit) this.rotate()

		if (this.results.length < count) this.results = new Float64Array(Math.max(count, this.results.length * 2))

		if (this.batchWidths.length < count) {
			this.batchWidths = new Float64Array(this.results.length)
			this.batchIndex = new Int32Array(this.results.length)
		}

		// Queues are short and mostly one font; a selection pass per distinct font keeps them in order.
		for (let first = 0; first < count; first++) {
			const font = fonts[first] ?? EMPTY

			if (font === EMPTY) continue

			const batch = this.batchTexts
			let n = 0

			for (let i = first; i < count; i++) {
				if (fonts[i] !== font) continue

				batch[n] = texts[i] ?? ""
				this.batchIndex[n++] = i
				fonts[i] = EMPTY
			}

			this.measurer.measure(this.fontNames[font] ?? "", this.fontKerning[font] ?? true, batch, n, this.batchWidths)

			for (let k = 0; k < n; k++) {
				const at = this.batchIndex[k] ?? 0
				const width = this.batchWidths[k] ?? 0

				this.results[at] = width

				if (this.pendingCached[at] === 1) this.store(font, batch[k] ?? "", width)
			}

			batch.length = 0
		}

		this.pendingCount = 0
		this.pendingTexts.length = 0
	}

	clear(): void {
		this.current = new Generation(1024)
		this.previous = null
	}

	private rotate(): void {
		this.previous = this.current
		this.current = new Generation(1024)
	}

	private lookupOrQueue(font: number, text: string, start: number, end: number): number {
		const cached = end - start <= MAX_CACHED_LENGTH

		if (cached) {
			const hash = hashRange(font, text, start, end)
			let slot = this.current.find(font, hash, text, start, end)

			if (slot >= 0) return this.current.widths[slot] ?? 0

			const previous = this.previous

			if (previous !== null) {
				slot = previous.find(font, hash, text, start, end)

				if (slot >= 0) {
					const width = previous.widths[slot] ?? 0

					// NaN: queued before a rotation; the flush stores it there.
					if (!Number.isNaN(width)) this.current.insert(font, hash, text, start, end, width)

					return width
				}
			}

			// A placeholder keeps a string queued once however often it is requested before the flush.
			this.current.insert(font, hash, text, start, end, Number.NaN)
		}

		this.queue(font, text.slice(start, end), cached)

		return Number.NaN
	}

	private queue(font: number, text: string, cached: boolean): void {
		if (this.pendingCount === this.pendingFonts.length) {
			const fonts = new Int32Array(this.pendingFonts.length * 2)
			const flags = new Uint8Array(fonts.length)

			fonts.set(this.pendingFonts)
			flags.set(this.pendingCached)
			this.pendingFonts = fonts
			this.pendingCached = flags
		}

		this.ticket = this.pendingCount
		this.pendingFonts[this.pendingCount] = font
		this.pendingCached[this.pendingCount++] = cached ? 1 : 0
		this.pendingTexts.push(text)
	}

	private store(font: number, text: string, width: number): void {
		const hash = hashRange(font, text, 0, text.length)
		const slot = this.current.find(font, hash, text, 0, text.length)

		if (slot >= 0) {
			this.current.widths[slot] = width

			return
		}

		const previous = this.previous
		const old = previous === null ? -1 : previous.find(font, hash, text, 0, text.length)

		if (previous !== null && old >= 0) previous.widths[old] = width
		else this.current.insert(font, hash, text, 0, text.length, width)
	}
}

function isLead(unit: number): boolean {
	return unit >= 0xd800 && unit < 0xdc00
}

function isTrail(unit: number): boolean {
	return unit >= 0xdc00 && unit < 0xe000
}

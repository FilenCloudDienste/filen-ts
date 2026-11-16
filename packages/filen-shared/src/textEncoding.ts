import { normalizeLanguage } from "./videos/languages"
import { MAX_SUBTITLE_CHARS } from "./videos/subtitles/cues"

// How a text file's bytes become text, and whether they can be written back unchanged.

interface TextDecoderLike {
	readonly encoding: string
	decode(input?: Uint8Array, options?: { stream?: boolean }): string
}

type TextDecoderCtor = new (label: string, options?: { fatal?: boolean; ignoreBOM?: boolean }) => TextDecoderLike

// "convert": shown read-only; only an explicit conversion makes it UTF-8.
export type TextWritable = "yes" | "convert"

export interface DecodedText {
	text: string
	// Canonical WHATWG name of the encoding used ("utf-32le"/"utf-32be" for the two the platform cannot decode).
	encoding: string
	// A byte order mark was found and is not part of `text`.
	bom: boolean
	// false when the encoding was assumed (legacy fallback, a guess, a forced label, malformed Unicode).
	confident: boolean
	// Whether encoding `text` back with `encoding` gives the original bytes.
	writable: TextWritable
	// Some input became U+FFFD.
	lossy: boolean
}

export interface DecodeTextOptions {
	// Forced label (a manual choice); skips detection.
	encoding?: string | null
	// A detector's label, used when the bytes are not Unicode.
	guess?: string | null
	// BCP 47 tag, 639 code or English name: picks the legacy codepage when there is no guess.
	languageHint?: string | null
	// The bytes are a prefix of the file: a sequence cut at the end is not an error.
	prefix?: boolean
}

// The encodings the subtitle picker offers (label = WHATWG name).
export const SUBTITLE_ENCODINGS: readonly { label: string; name: string }[] = [
	{ label: "utf-8", name: "Unicode (UTF-8)" },
	{ label: "utf-16le", name: "Unicode (UTF-16 LE)" },
	{ label: "utf-16be", name: "Unicode (UTF-16 BE)" },
	{ label: "windows-1250", name: "Central European (Windows-1250)" },
	{ label: "windows-1251", name: "Cyrillic (Windows-1251)" },
	{ label: "windows-1252", name: "Western European (Windows-1252)" },
	{ label: "windows-1253", name: "Greek (Windows-1253)" },
	{ label: "windows-1254", name: "Turkish (Windows-1254)" },
	{ label: "windows-1255", name: "Hebrew (Windows-1255)" },
	{ label: "windows-1256", name: "Arabic (Windows-1256)" },
	{ label: "windows-1257", name: "Baltic (Windows-1257)" },
	{ label: "windows-1258", name: "Vietnamese (Windows-1258)" },
	{ label: "windows-874", name: "Thai (Windows-874)" },
	{ label: "koi8-r", name: "Cyrillic (KOI8-R)" },
	{ label: "gb18030", name: "Chinese Simplified (GB18030)" },
	{ label: "big5", name: "Chinese Traditional (Big5)" },
	{ label: "shift_jis", name: "Japanese (Shift JIS)" },
	{ label: "euc-jp", name: "Japanese (EUC-JP)" },
	{ label: "euc-kr", name: "Korean (EUC-KR)" }
]

// Every encoding a text file may be read with.
export const TEXT_ENCODINGS: readonly { label: string; name: string }[] = [
	...SUBTITLE_ENCODINGS,
	{ label: "koi8-u", name: "Cyrillic (KOI8-U)" },
	{ label: "ibm866", name: "Cyrillic (IBM 866)" },
	{ label: "iso-8859-2", name: "Central European (ISO 8859-2)" },
	{ label: "iso-8859-4", name: "Baltic (ISO 8859-4)" },
	{ label: "iso-8859-5", name: "Cyrillic (ISO 8859-5)" },
	{ label: "iso-8859-7", name: "Greek (ISO 8859-7)" },
	{ label: "iso-8859-8", name: "Hebrew (ISO 8859-8)" },
	{ label: "iso-8859-10", name: "Nordic (ISO 8859-10)" },
	{ label: "iso-8859-13", name: "Baltic (ISO 8859-13)" },
	{ label: "iso-8859-15", name: "Western European (ISO 8859-15)" },
	{ label: "macintosh", name: "Western European (Mac OS Roman)" }
]

const KNOWN_LABELS: ReadonlySet<string> = new Set(TEXT_ENCODINGS.map(encoding => encoding.label))

// Legacy encodings with multi-byte sequences: never written back as-is.
const MULTI_BYTE_LEGACY: ReadonlySet<string> = new Set(["gb18030", "gbk", "big5", "shift_jis", "euc-jp", "euc-kr", "iso-2022-jp"])

// A Map, so a language code never resolves an inherited object key.
const LEGACY_BY_LANGUAGE: ReadonlyMap<string, string> = new Map([
	["ru", "windows-1251"],
	["uk", "windows-1251"],
	["bg", "windows-1251"],
	["sr", "windows-1251"],
	["mk", "windows-1251"],
	["be", "windows-1251"],
	["kk", "windows-1251"],
	["mn", "windows-1251"],
	["el", "windows-1253"],
	["tr", "windows-1254"],
	["az", "windows-1254"],
	["he", "windows-1255"],
	["yi", "windows-1255"],
	["ar", "windows-1256"],
	["fa", "windows-1256"],
	["ur", "windows-1256"],
	["et", "windows-1257"],
	["lv", "windows-1257"],
	["lt", "windows-1257"],
	["pl", "windows-1250"],
	["cs", "windows-1250"],
	["sk", "windows-1250"],
	["hu", "windows-1250"],
	["hr", "windows-1250"],
	["sl", "windows-1250"],
	["ro", "windows-1250"],
	["sq", "windows-1250"],
	["bs", "windows-1250"],
	["vi", "windows-1258"],
	["th", "windows-874"],
	["zh", "gb18030"],
	["yue", "big5"],
	["ja", "shift_jis"],
	["ko", "euc-kr"]
])

const TRADITIONAL_HINT = /traditional|(?:^|[-_ (])(?:tw|hk|mo|hant)(?:$|[-_ )])/

// Legacy codepage most likely for a language hint (BCP 47 tag, 639 code or English name); windows-1252 when unknown.
export function legacyEncodingForLanguage(hint: string | null | undefined): string {
	if (hint === null || hint === undefined || hint.length > 64) {
		return "windows-1252"
	}

	const lowered = hint.trim().toLowerCase()

	if (lowered === "zht" || lowered === "cht") {
		return "big5"
	}

	const lang = normalizeLanguage(lowered)

	if (lang === "zh" && TRADITIONAL_HINT.test(lowered)) {
		return "big5"
	}

	if (lang === "sr" && /(?:^|[-_ (])latn(?:$|[-_ )])|latin/.test(lowered)) {
		return "windows-1250"
	}

	return lang === null ? "windows-1252" : (LEGACY_BY_LANGUAGE.get(lang) ?? "windows-1252")
}

function decoderFor(label: string, fatal: boolean): TextDecoderLike | null {
	const Decoder = (globalThis as unknown as { TextDecoder: TextDecoderCtor }).TextDecoder

	try {
		// ignoreBOM: a mark is stripped here, by bytes; a second U+FEFF is text.
		return new Decoder(label, { fatal, ignoreBOM: true })
	} catch {
		return null
	}
}

// null when the label is unknown, or (strict) the bytes are malformed. A prefix leaves a cut sequence undecoded.
function decodeWith(label: string, bytes: Uint8Array, strict: boolean, prefix: boolean): { text: string; encoding: string } | null {
	const decoder = decoderFor(label, strict)

	if (decoder === null) {
		return null
	}

	try {
		return { text: decoder.decode(bytes, { stream: prefix }), encoding: decoder.encoding }
	} catch {
		return null
	}
}

type Bom = { label: "utf-8" | "utf-16le" | "utf-16be" | "utf-32le" | "utf-32be"; length: number }

// UTF-32 LE is checked before UTF-16 LE: its mark starts with UTF-16 LE's.
function readBom(bytes: Uint8Array): Bom | null {
	const [b0, b1, b2, b3] = bytes

	if (b0 === 0xef && b1 === 0xbb && b2 === 0xbf) {
		return { label: "utf-8", length: 3 }
	}

	if (b0 === 0xff && b1 === 0xfe && b2 === 0 && b3 === 0) {
		return { label: "utf-32le", length: 4 }
	}

	if (b0 === 0 && b1 === 0 && b2 === 0xfe && b3 === 0xff) {
		return { label: "utf-32be", length: 4 }
	}

	if (b0 === 0xff && b1 === 0xfe) {
		return { label: "utf-16le", length: 2 }
	}

	if (b0 === 0xfe && b1 === 0xff) {
		return { label: "utf-16be", length: 2 }
	}

	return null
}

// UTF-16 without a BOM: ASCII-heavy text leaves every other byte zero.
function sniffUtf16(bytes: Uint8Array): "utf-16le" | "utf-16be" | null {
	const sample = Math.min(bytes.length, 512) & ~1

	if (sample < 16) {
		return null
	}

	let even = 0
	let odd = 0

	for (let i = 0; i < sample; i += 2) {
		if (bytes[i] === 0) {
			even++
		}

		if (bytes[i + 1] === 0) {
			odd++
		}
	}

	const half = sample / 2

	if (odd > half * 0.3 && even <= half * 0.05) {
		return "utf-16le"
	}

	if (even > half * 0.3 && odd <= half * 0.05) {
		return "utf-16be"
	}

	return null
}

const UTF32_CHUNK = 1 << 16

// The platform has no UTF-32 decoder: code points become UTF-16 units, decoded by the platform per chunk.
function decodeUtf32(bytes: Uint8Array, littleEndian: boolean, prefix: boolean): { text: string; lossy: boolean } {
	const whole = bytes.length & ~3
	const view = new DataView(bytes.buffer, bytes.byteOffset, whole)
	const units = new Uint16Array(Math.min(whole / 2, UTF32_CHUNK * 2))
	// A cut last unit is an error unless the bytes are a prefix.
	const truncated = !prefix && whole !== bytes.length
	let text = ""
	let lossy = truncated

	for (let chunk = 0; chunk < whole; chunk += UTF32_CHUNK * 4) {
		const end = Math.min(whole, chunk + UTF32_CHUNK * 4)
		let length = 0

		for (let offset = chunk; offset < end; offset += 4) {
			const point = view.getUint32(offset, littleEndian)

			if (point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) {
				units[length++] = 0xfffd
				lossy = true
			} else if (point > 0xffff) {
				units[length++] = 0xd800 + ((point - 0x10000) >> 10)
				units[length++] = 0xdc00 + ((point - 0x10000) & 0x3ff)
			} else {
				units[length++] = point
			}
		}

		const unitBytes = new Uint8Array(units.buffer, 0, length * 2)

		text += decodeWith("utf-16le", unitBytes, false, false)?.text ?? ""
	}

	return { text: truncated ? text + "\ufffd" : text, lossy }
}

const ERROR_SCAN_BYTES = 1 << 20

// Over the first 1 MiB: valid multi-byte sequences and bytes that start no valid sequence. A prefix's cut tail is
// neither.
function scanUtf8(bytes: Uint8Array, prefix: boolean): { multibyte: number; invalid: number } {
	const end = Math.min(bytes.length, ERROR_SCAN_BYTES)
	const cut = prefix || end < bytes.length
	let multibyte = 0
	let invalid = 0
	let i = 0

	while (i < end) {
		const lead = bytes[i] ?? 0

		if (lead < 0x80) {
			i++
			continue
		}

		const length = lead >= 0xc2 && lead <= 0xdf ? 2 : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xf0 && lead <= 0xf4 ? 4 : 0

		if (length === 0) {
			invalid++
			i++
			continue
		}

		if (i + length > end) {
			if (!cut) {
				invalid++
			}

			break
		}

		const second = bytes[i + 1] ?? 0
		const low = lead === 0xe0 ? 0xa0 : lead === 0xf0 ? 0x90 : 0x80
		const high = lead === 0xed ? 0x9f : lead === 0xf4 ? 0x8f : 0xbf
		let valid = second >= low && second <= high

		for (let k = 2; valid && k < length; k++) {
			const next = bytes[i + k] ?? 0

			valid = next >= 0x80 && next <= 0xbf
		}

		if (valid) {
			multibyte++
			i += length
		} else {
			invalid++
			i++
		}
	}

	return { multibyte, invalid }
}

// UTF-8 with a few stray bytes: valid multi-byte sequences outnumber the errors, which stay within
// max(8, multibyte / 16).
function mostlyUtf8(bytes: Uint8Array, prefix: boolean): boolean {
	const { multibyte, invalid } = scanUtf8(bytes, prefix)

	return invalid <= multibyte && invalid <= Math.max(8, multibyte / 16)
}

function isSingleByte(encoding: string): boolean {
	return !encoding.startsWith("utf-") && !MULTI_BYTE_LEGACY.has(encoding)
}

// Decoded with a codepage that is not Unicode: writable only from a single-byte one that lost nothing.
function legacy(text: string, encoding: string, bom: boolean): DecodedText {
	const lossy = text.includes("\ufffd")

	return { text, encoding, bom, confident: false, writable: !lossy && isSingleByte(encoding) ? "yes" : "convert", lossy }
}

function unicode(text: string, encoding: string, bom: boolean, strict: boolean): DecodedText {
	return { text, encoding, bom, confident: strict, writable: strict ? "yes" : "convert", lossy: !strict }
}

type Unicode = { decoded: DecodedText } | { body: Uint8Array; bom: boolean }

// BOM, then the UTF-16 sniff, then strict UTF-8, then UTF-8 with a few errors. Otherwise the body for a legacy codepage.
function decodeUnicode(bytes: Uint8Array, prefix: boolean): Unicode {
	const bom = readBom(bytes)
	const body = bom === null ? bytes : bytes.subarray(bom.length)

	if (bom !== null && bom.label.startsWith("utf-32")) {
		const { text, lossy } = decodeUtf32(body, bom.label === "utf-32le", prefix)

		return { decoded: unicode(text, bom.label, true, !lossy) }
	}

	if (bom !== null && bom.label !== "utf-8") {
		const strict = decodeWith(bom.label, body, true, prefix)

		// The BOM promised UTF-16 but the payload is malformed: what decodes, flagged.
		return {
			decoded:
				strict === null
					? unicode(decodeWith(bom.label, body, false, prefix)?.text ?? "", bom.label, true, false)
					: unicode(strict.text, bom.label, true, true)
		}
	}

	const utf16 = bom === null ? sniffUtf16(bytes) : null

	if (utf16 !== null) {
		const strict = decodeWith(utf16, bytes, true, prefix)

		return {
			decoded:
				strict === null
					? unicode(decodeWith(utf16, bytes, false, prefix)?.text ?? "", utf16, false, false)
					: unicode(strict.text, utf16, false, true)
		}
	}

	const strict = decodeWith("utf-8", body, true, prefix)

	if (strict !== null) {
		return { decoded: unicode(strict.text, "utf-8", bom !== null, true) }
	}

	if (mostlyUtf8(body, prefix)) {
		return { decoded: unicode(decodeWith("utf-8", body, false, prefix)?.text ?? "", "utf-8", bom !== null, false) }
	}

	return { body, bom: bom !== null }
}

// Forced label, BOM, UTF-16 sniff, strict UTF-8, UTF-8 with a few errors, the guess, the language's codepage,
// windows-1252.
export function decodeTextBytes(bytes: Uint8Array, options?: DecodeTextOptions): DecodedText {
	const prefix = options?.prefix === true
	const forced = options?.encoding?.toLowerCase()

	if (forced !== undefined && KNOWN_LABELS.has(forced)) {
		const bom = readBom(bytes)
		// A mark of another encoding is a marker, not text.
		const body = bom === null ? bytes : bytes.subarray(bom.length)
		const decoded = decodeWith(forced, body, false, prefix)

		if (decoded !== null) {
			const lossy = decoded.text.includes("\ufffd")
			// A stripped mark of another encoding would not be written back.
			const writable =
				!lossy && !MULTI_BYTE_LEGACY.has(decoded.encoding) && (bom === null || bom.label === decoded.encoding) ? "yes" : "convert"

			return { text: decoded.text, encoding: decoded.encoding, bom: bom !== null, confident: false, writable, lossy }
		}
	}

	const result = decodeUnicode(bytes, prefix)

	if ("decoded" in result) {
		return result.decoded
	}

	for (const label of [options?.guess, legacyEncodingForLanguage(options?.languageHint), "windows-1252"]) {
		const decoded = label === null || label === undefined ? null : decodeWith(label, result.body, false, prefix)

		if (decoded !== null) {
			return legacy(decoded.text, decoded.encoding, result.bom)
		}
	}

	return legacy("", "windows-1252", result.bom)
}

// No Unicode reading fits (BOM, UTF-16, UTF-8 even with a few errors): a legacy codepage has to be picked.
export function needsLegacyGuess(bytes: Uint8Array, options?: { prefix?: boolean }): boolean {
	return !("decoded" in decodeUnicode(bytes, options?.prefix === true))
}

// A NUL byte near the start marks a binary file, unless a BOM or the UTF-16 sniff says the zeros are Unicode.
const BINARY_PROBE_BYTES = 8192

export function looksLikeText(bytes: Uint8Array): boolean {
	const bom = readBom(bytes)

	if ((bom !== null && bom.label !== "utf-8") || sniffUtf16(bytes) !== null) {
		return true
	}

	return !bytes.subarray(0, BINARY_PROBE_BYTES).includes(0)
}

// Whether today's save path (UTF-8, its mark kept) writes the text back as the bytes it came from.
export function editableAsIs(decoded: DecodedText): boolean {
	return decoded.writable === "yes" && decoded.encoding === "utf-8"
}

export interface DecodeSubtitleOptions {
	// Language of the track (sidecar name token), picks the legacy codepage fallback.
	languageHint?: string | null
	// Manual picker choice (a label from `SUBTITLE_ENCODINGS`); skips detection.
	encoding?: string | null
}

// decodeTextBytes within the subtitle cap. null when the bytes exceed 8 MiB.
export function decodeSubtitleBytes(bytes: Uint8Array, options: DecodeSubtitleOptions = {}): DecodedText | null {
	if (bytes.length > MAX_SUBTITLE_CHARS) {
		return null
	}

	return decodeTextBytes(bytes, options)
}

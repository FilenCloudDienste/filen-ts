// Text values as Specific Character Set (0008,0005) declares them (PS3.3 C.12.1.1.2, PS3.5 6.1): one character set for
// the whole value, or ISO 2022 code extensions, whose escape sequences switch the sets G0 and G1 within a value and
// which return to the first value's sets at each delimiter. Every set is decoded by the platform's own decoders (the
// WHATWG encodings); Latin-1 is read only when nothing declared can be, and a value that is valid UTF-8 has failed first.

const NO_EXTENSIONS: Readonly<Record<string, string>> = {
	"ISO_IR 100": "iso-8859-1",
	"ISO_IR 101": "iso-8859-2",
	"ISO_IR 109": "iso-8859-3",
	"ISO_IR 110": "iso-8859-4",
	"ISO_IR 144": "iso-8859-5",
	"ISO_IR 127": "iso-8859-6",
	"ISO_IR 126": "iso-8859-7",
	"ISO_IR 138": "iso-8859-8",
	"ISO_IR 148": "iso-8859-9",
	"ISO_IR 203": "iso-8859-15",
	"ISO_IR 13": "shift_jis",
	"ISO_IR 166": "windows-874",
	"ISO_IR 192": "utf-8",
	GB18030: "gb18030",
	GBK: "gbk"
}

// A code element: how its bytes read. "single": one byte a character through `label` (GR bytes, or GL for G0);
// "jis0208"/"jis0212": two 7-bit bytes a character in G0; "euc": two 8-bit bytes a character in G1, through `label`.
type CodeSet =
	| { readonly kind: "single"; readonly label: string }
	| { readonly kind: "jis0208" }
	| { readonly kind: "jis0212" }
	| { readonly kind: "euc"; readonly label: string }

const ASCII: CodeSet = { kind: "single", label: "windows-1252" }
const KATAKANA: CodeSet = { kind: "single", label: "shift_jis" }

// The single-byte sets an ISO 2022 term (or ESC - F) designates to G1, by their final byte.
const LATIN_G1: Readonly<Record<string, { readonly term: string; readonly label: string }>> = {
	A: { term: "ISO 2022 IR 100", label: "iso-8859-1" },
	B: { term: "ISO 2022 IR 101", label: "iso-8859-2" },
	C: { term: "ISO 2022 IR 109", label: "iso-8859-3" },
	D: { term: "ISO 2022 IR 110", label: "iso-8859-4" },
	L: { term: "ISO 2022 IR 144", label: "iso-8859-5" },
	G: { term: "ISO 2022 IR 127", label: "iso-8859-6" },
	F: { term: "ISO 2022 IR 126", label: "iso-8859-7" },
	H: { term: "ISO 2022 IR 138", label: "iso-8859-8" },
	M: { term: "ISO 2022 IR 148", label: "iso-8859-9" },
	b: { term: "ISO 2022 IR 203", label: "iso-8859-15" },
	T: { term: "ISO 2022 IR 166", label: "windows-874" }
}

interface Sets {
	readonly g0: CodeSet
	readonly g1: CodeSet | null
}

// The sets a value starts in (and returns to at a delimiter): ASCII in G0, and in G1 the first term's single-byte or
// two-byte set (none when the term is empty or ISO 2022 IR 6). A two-byte G0 set is only ever escaped into.
function initialSets(first: string): Sets {
	if (first === "ISO 2022 IR 13") return { g0: ASCII, g1: KATAKANA }
	if (first === "ISO 2022 IR 149") return { g0: ASCII, g1: { kind: "euc", label: "euc-kr" } }
	if (first === "ISO 2022 IR 58") return { g0: ASCII, g1: { kind: "euc", label: "gb18030" } }

	const latin = Object.values(LATIN_G1).find(set => set.term === first)

	return { g0: ASCII, g1: latin === undefined ? null : { kind: "single", label: latin.label } }
}

const ESC = 0x1b
// CR, LF, FF, TAB, backslash (between values), and a person name's ^ and = (its components and groups).
const DELIMITERS = new Set([0x0d, 0x0a, 0x0c, 0x09, 0x5c, 0x5e, 0x3d])

// The set an escape sequence at `at` designates, and how many bytes it takes; null for one this reader does not know
// (its ESC is then read as a character).
function escape(bytes: Uint8Array, at: number): { readonly g0?: CodeSet; readonly g1?: CodeSet; readonly length: number } | null {
	const a = String.fromCharCode(bytes[at + 1] ?? 0)
	const b = String.fromCharCode(bytes[at + 2] ?? 0)
	const c = String.fromCharCode(bytes[at + 3] ?? 0)

	if (a === "(" && (b === "B" || b === "J")) return { g0: ASCII, length: 3 }
	if (a === ")" && b === "I") return { g1: KATAKANA, length: 3 }
	if (a === "-") {
		const latin = LATIN_G1[b]

		return latin === undefined ? null : { g1: { kind: "single", label: latin.label }, length: 3 }
	}
	if (a === "$" && b === "B") return { g0: { kind: "jis0208" }, length: 3 }
	if (a === "$" && b === "(" && c === "D") return { g0: { kind: "jis0212" }, length: 4 }
	if (a === "$" && b === ")" && c === "C") return { g1: { kind: "euc", label: "euc-kr" }, length: 4 }
	if (a === "$" && b === ")" && c === "A") return { g1: { kind: "euc", label: "gb18030" }, length: 4 }

	return null
}

const decoders = new Map<string, TextDecoder | null>()

function decoderFor(label: string): TextDecoder | null {
	let decoder = decoders.get(label)

	if (decoder === undefined) {
		try {
			decoder = new TextDecoder(label)
		} catch {
			decoder = null
		}

		decoders.set(label, decoder)
	}

	return decoder
}

function latin1(bytes: Uint8Array): string {
	return (decoderFor("iso-8859-1") ?? new TextDecoder()).decode(bytes)
}

// One run of bytes in one set, as text.
function decodeRun(set: CodeSet, run: number[]): string {
	switch (set.kind) {
		case "single":
			return (decoderFor(set.label) ?? decoderFor("iso-8859-1"))?.decode(Uint8Array.from(run)) ?? ""
		case "euc":
			return decoderFor(set.label)?.decode(Uint8Array.from(run)) ?? ""
		case "jis0208":
			// ISO-2022-JP's own escape into JIS X 0208 and back.
			return decoderFor("iso-2022-jp")?.decode(Uint8Array.from([ESC, 0x24, 0x42, ...run, ESC, 0x28, 0x42])) ?? ""
		case "jis0212": {
			// EUC-JP reads JIS X 0212 as 0x8F and the pair with its high bits set.
			const euc: number[] = []

			for (let i = 0; i + 1 < run.length; i += 2) euc.push(0x8f, (run[i] ?? 0) | 0x80, (run[i + 1] ?? 0) | 0x80)

			return decoderFor("euc-jp")?.decode(Uint8Array.from(euc)) ?? ""
		}
	}
}

function decodeExtended(bytes: Uint8Array, initial: Sets): string {
	let { g0, g1 } = initial
	let text = ""
	let run: number[] = []
	let runSet: CodeSet | null = null
	const flush = (): void => {
		if (runSet !== null && run.length > 0) text += decodeRun(runSet, run)

		run = []
	}
	const push = (set: CodeSet, ...values: number[]): void => {
		if (runSet !== set) flush()

		runSet = set
		run.push(...values)
	}

	for (let at = 0; at < bytes.length;) {
		const byte = bytes[at] ?? 0

		if (byte === ESC) {
			const designation = escape(bytes, at)

			if (designation !== null) {
				g0 = designation.g0 ?? g0
				g1 = designation.g1 ?? g1
				at += designation.length

				continue
			}
		}

		if (byte < 0x80) {
			if ((g0.kind === "jis0208" || g0.kind === "jis0212") && byte >= 0x21 && byte <= 0x7e) {
				push(g0, byte, bytes[at + 1] ?? 0)
				at += 2

				continue
			}

			// A single-byte G0 reads as ASCII; a delimiter returns both sets to the value's first.
			push(ASCII, byte)

			if (DELIMITERS.has(byte)) {
				g0 = initial.g0
				g1 = initial.g1
			}

			at++

			continue
		}

		if (g1?.kind === "euc") {
			push(g1, byte, bytes[at + 1] ?? 0)
			at += 2
		} else {
			push(g1 ?? { kind: "single", label: "iso-8859-1" }, byte)
			at++
		}
	}

	flush()

	return text
}

// Value representations whose text Specific Character Set applies to (PS3.5 6.1.2.3); every other one is the default
// repertoire.
const EXTENDED_VRS = new Set(["SH", "LO", "ST", "LT", "UC", "UT", "PN"])

export interface DicomText {
	decode(bytes: Uint8Array, vr: string): string
}

// The text of a data set (or a sequence item) declaring `declared` as its Specific Character Set.
export function dicomText(declared: string | undefined): DicomText {
	const terms = (declared ?? "").split("\\").map(term => term.trim())
	const [first = ""] = terms
	const extended = terms.some(term => term.startsWith("ISO 2022"))
	const initial = initialSets(first)
	// Without code extensions one set reads the whole value: the first term this platform decodes.
	const whole = extended ? null : terms.map(term => NO_EXTENSIONS[term]).find(label => label !== undefined && decoderFor(label) !== null)
	const declaredNothing = terms.every(term => term === "")

	return {
		decode: (bytes, vr) => {
			if (!EXTENDED_VRS.has(vr)) return latin1(bytes)
			if (extended) return decodeExtended(bytes, initial)
			if (whole !== undefined && whole !== null && !declaredNothing) return decoderFor(whole)?.decode(bytes) ?? latin1(bytes)

			// Nothing declared, or nothing declared that this platform reads: UTF-8 when the value is valid UTF-8, else
			// Latin-1.
			try {
				return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
			} catch {
				return latin1(bytes)
			}
		}
	}
}

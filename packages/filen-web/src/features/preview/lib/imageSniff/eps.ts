import { startsWith, viewOf, type ByteSpan } from "@/features/preview/lib/imageSniff/bytes"

// Encapsulated PostScript (Adobe EPSF 3.0, Technical Note 5002). A DOS EPS binary header (C5 D0 D3 C6, then the
// PostScript, WMF and TIFF sections' offsets and lengths as 32-bit little endian) carries an optional preview picture;
// a plain EPS may carry an EPSI preview in its comments: "%%BeginPreview: width height depth lines", then that many
// lines of hex, each at most 255 characters.

export interface EpsiPreview {
	readonly width: number
	readonly height: number
	readonly depth: 1 | 2 | 4 | 8
	readonly lines: number
	// The first byte after the %%BeginPreview line.
	readonly dataStart: number
}

export type EpsHeader =
	| {
			readonly kind: "dos"
			// Each null when absent or outside the file.
			readonly postScript: ByteSpan | null
			readonly wmf: ByteSpan | null
			readonly tiff: ByteSpan | null
	  }
	| { readonly kind: "epsi"; readonly preview: EpsiPreview }
	| { readonly kind: "plain" }

// 16 MiB of hex at 256 bytes a line (255 characters and the line end).
export const MAX_EPSI_LINES = 65_536

const DOS_EPS_MAGIC = [0xc5, 0xd0, 0xd3, 0xc6]
const DOS_EPS_HEADER_BYTES = 30
const PS_MAGIC = [...new TextEncoder().encode("%!PS-Adobe-")]
const BEGIN_PREVIEW = [...new TextEncoder().encode("%%BeginPreview:")]

function span(view: DataView, at: number, fileSize: number): ByteSpan | null {
	const offset = view.getUint32(at, true)
	const length = view.getUint32(at + 4, true)

	return length > 0 && offset >= DOS_EPS_HEADER_BYTES && offset + length <= fileSize ? { offset, length } : null
}

function indexOf(head: Uint8Array, needle: readonly number[], from: number): number {
	const first = needle[0]

	for (let at = head.indexOf(first ?? 0, from); at >= 0; at = head.indexOf(first ?? 0, at + 1)) {
		if (startsWith(head, needle, at)) {
			return at
		}
	}

	return -1
}

function isDepth(value: number): value is 1 | 2 | 4 | 8 {
	return value === 1 || value === 2 || value === 4 || value === 8
}

// The preview a %%BeginPreview line declares, or null.
function readPreview(head: Uint8Array, at: number): EpsiPreview | null {
	let lineEnd = at

	while (lineEnd < head.length && head[lineEnd] !== 0x0a && head[lineEnd] !== 0x0d) {
		lineEnd++
	}

	if (lineEnd === head.length) {
		return null
	}

	const fields = new TextDecoder("latin1").decode(head.subarray(at, lineEnd)).trim().split(/\s+/)

	if (fields.length !== 4 || !fields.every(field => /^\d{1,9}$/.test(field))) {
		return null
	}

	const [width = 0, height = 0, depth = 0, lines = 0] = fields.map(Number)
	// CR LF ends a line as one.
	const dataStart = lineEnd + (head[lineEnd] === 0x0d && head[lineEnd + 1] === 0x0a ? 2 : 1)

	if (width === 0 || height === 0 || lines === 0 || lines > MAX_EPSI_LINES || !isDepth(depth)) {
		return null
	}

	return { width, height, depth, lines, dataStart }
}

export function sniffEps(head: Uint8Array, fileSize: number): EpsHeader | null {
	if (startsWith(head, DOS_EPS_MAGIC)) {
		if (head.length < DOS_EPS_HEADER_BYTES) {
			return null
		}

		const view = viewOf(head)

		return { kind: "dos", postScript: span(view, 4, fileSize), wmf: span(view, 12, fileSize), tiff: span(view, 20, fileSize) }
	}

	if (!startsWith(head, PS_MAGIC)) {
		return null
	}

	const marker = indexOf(head, BEGIN_PREVIEW, 0)
	const preview = marker < 0 ? null : readPreview(head, marker + BEGIN_PREVIEW.length)

	return preview === null ? { kind: "plain" } : { kind: "epsi", preview }
}

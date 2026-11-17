// EPS files for fixtures (Adobe EPSF 3.0, Technical Note 5002): a DOS EPS binary header in front of its PostScript and a
// TIFF preview, an EPSI preview in a plain EPS's comments, or plain PostScript.

const POSTSCRIPT = "%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 8 8\n%%EndComments\nshowpage\n%%EOF\n"

export function plainEps(): Uint8Array {
	return new TextEncoder().encode(POSTSCRIPT)
}

// A DOS EPS: the 30-byte header (magic, then the PostScript, WMF and TIFF sections' offsets and lengths, little
// endian, and a checksum of 0xFFFF), the PostScript, then the TIFF.
export function dosEps(tiff: Uint8Array | null): Uint8Array {
	const postScript = plainEps()
	const header = new Uint8Array(30)
	const view = new DataView(header.buffer)

	header.set([0xc5, 0xd0, 0xd3, 0xc6])
	view.setUint32(4, 30, true)
	view.setUint32(8, postScript.length, true)

	if (tiff !== null) {
		view.setUint32(20, 30 + postScript.length, true)
		view.setUint32(24, tiff.length, true)
	}

	view.setUint16(28, 0xffff, true)

	const out = new Uint8Array(30 + postScript.length + (tiff?.length ?? 0))

	out.set(header)
	out.set(postScript, 30)

	if (tiff !== null) {
		out.set(tiff, 30 + postScript.length)
	}

	return out
}

// A plain EPS whose comments carry an EPSI preview of `rows` (one hex string per row, `depth` bits a sample).
export function epsiEps(width: number, depth: 1 | 2 | 4 | 8, rows: readonly string[]): Uint8Array {
	const lines = rows.map(row => `%${row}`).join("\n")

	return new TextEncoder().encode(
		`%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 ${String(width)} ${String(rows.length)}\n` +
			`%%BeginPreview: ${String(width)} ${String(rows.length)} ${String(depth)} ${String(rows.length)}\n${lines}\n%%EndPreview\n` +
			"%%EndComments\nshowpage\n%%EOF\n"
	)
}

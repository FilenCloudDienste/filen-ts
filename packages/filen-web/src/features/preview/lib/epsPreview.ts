import { MAX_EPSI_LINES, sniffEps } from "@/features/preview/lib/imageSniff/eps"

// The preview picture an EPS file carries, read by range from its head: a DOS EPS's TIFF section, or the hex of an EPSI
// preview (handed on with its %%BeginPreview line, which its decoder reads the size from). Its PostScript is never read.

export type EpsPreview =
	| { readonly kind: "tiff"; readonly bytes: Uint8Array }
	| { readonly kind: "epsi"; readonly bytes: Uint8Array }
	// A WMF preview (nothing here draws one), or none.
	| { readonly kind: "none" }
	// A TIFF section larger than the reader holds whole.
	| { readonly kind: "tooLarge" }
	// Not an EPS file.
	| { readonly kind: "unreadable" }

export interface EpsRangeReader {
	readonly size: number
	read(offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array>
}

// Where the binary header, an EPSI preview's line and (usually) its start sit.
const EPS_HEAD_BYTES = 64 * 1024
// The most of a TIFF section read; the engine holds it whole.
export const EPS_TIFF_MAX_BYTES = 64 * 1024 * 1024
// An EPSI preview line: at most 255 characters and its line end.
const EPSI_LINE_BYTES = 257

export async function epsPreview(reader: EpsRangeReader, signal: AbortSignal, maxTiffBytes = EPS_TIFF_MAX_BYTES): Promise<EpsPreview> {
	const head = await reader.read(0, EPS_HEAD_BYTES, signal)
	const eps = sniffEps(head, reader.size)

	if (eps === null) {
		return { kind: "unreadable" }
	}

	switch (eps.kind) {
		case "dos":
			if (eps.tiff === null) {
				return { kind: "none" }
			}

			return eps.tiff.length > maxTiffBytes
				? { kind: "tooLarge" }
				: { kind: "tiff", bytes: (await reader.read(eps.tiff.offset, eps.tiff.length, signal)).slice() }
		case "epsi": {
			const { preview } = eps
			const line = new TextEncoder().encode(
				`%%BeginPreview: ${String(preview.width)} ${String(preview.height)} ${String(preview.depth)} ${String(preview.lines)}\n`
			)
			const length = Math.min(Math.min(preview.lines, MAX_EPSI_LINES) * EPSI_LINE_BYTES, reader.size - preview.dataStart)
			const hex = await reader.read(preview.dataStart, length, signal)
			const bytes = new Uint8Array(line.length + hex.length)

			bytes.set(line)
			bytes.set(hex, line.length)

			return { kind: "epsi", bytes }
		}
		case "plain":
			return { kind: "none" }
	}
}

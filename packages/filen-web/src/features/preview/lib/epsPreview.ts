import { sniffEps } from "@/features/preview/lib/imageSniff/eps"
import { EPSI_MAX_HEX_DIGITS, epsiHexDigits, packEpsi } from "@/features/preview/lib/rasterCodecs/epsi"

// The preview picture an EPS file carries, read by range from its head: a DOS EPS's TIFF section, or the lines of an
// EPSI preview (packed with the size its %%BeginPreview line declares). Its PostScript is never read.

export type EpsPreview =
	| { readonly kind: "tiff"; readonly bytes: Uint8Array }
	| { readonly kind: "epsi"; readonly bytes: Uint8Array }
	// A WMF preview (nothing here draws one), or none.
	| { readonly kind: "none" }
	// A TIFF section larger than the reader holds whole, or an EPSI preview with more hex than one may hold.
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
// What an EPSI preview line adds to its hex: its "%", a space and a CR LF.
const EPSI_LINE_OVERHEAD = 4

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
				: { kind: "tiff", bytes: await reader.read(eps.tiff.offset, eps.tiff.length, signal) }
		case "epsi": {
			const { preview } = eps
			const digits = epsiHexDigits(preview)

			if (digits > EPSI_MAX_HEX_DIGITS) {
				return { kind: "tooLarge" }
			}

			// What the rows' hex needs and no more: the PostScript after the preview is never read.
			const length = Math.min(digits + preview.lines * EPSI_LINE_OVERHEAD, reader.size - preview.dataStart)

			return { kind: "epsi", bytes: packEpsi(preview, await reader.read(preview.dataStart, length, signal)) }
		}
		case "plain":
			return { kind: "none" }
	}
}

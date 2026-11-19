import { readFileSync } from "node:fs"
import { webcrypto } from "node:crypto"
import * as mupdf from "mupdf"
import type { PdfSignatureReport, PdfSubtle } from "../core/pdfsign"
import { createPdfDigest } from "../dom/pdfedit/digest"
import { verifyPdfSignatures, type VerifyPdfSignaturesOptions } from "../dom/pdfedit/verify"

// Node's WebCrypto, structurally the verifier's subset.
export const nodeSubtle: PdfSubtle = webcrypto.subtle

// Fixtures from src/scripts/pdfSignFixtures.ts: hand-written PDF structure, signed by OpenSSL.
export const signedFixture = (name: string): Uint8Array =>
	new Uint8Array(readFileSync(new URL(`fixtures/pdfsign/${name}`, import.meta.url)))

export async function verifyBytes(bytes: Uint8Array, options: Partial<VerifyPdfSignaturesOptions> = {}): Promise<PdfSignatureReport> {
	const document = new mupdf.PDFDocument(bytes)
	const report = await verifyPdfSignatures(
		document,
		{
			length: bytes.length,
			read: (offset, length) => Promise.resolve(bytes.slice(offset, offset + length))
		},
		{
			subtle: nodeSubtle,
			createDigest: createPdfDigest,
			openRevision: length => new mupdf.PDFDocument(bytes.slice(0, length)),
			now: Date.UTC(2026, 6, 1),
			...options
		}
	)

	document.destroy()

	return report
}

// The file with its /Contents re-encoded as BouncyCastle writes CMS: the ContentInfo, its [0] and the SignedData with
// indefinite lengths, the rest untouched, zero-padded to the gap's size. The gap is outside the signed bytes.
export function withIndefiniteContents(bytes: Uint8Array): Uint8Array {
	const text = new TextDecoder("latin1").decode(bytes)
	const start = text.indexOf("/Contents <") + "/Contents <".length
	const end = text.indexOf(">", start)
	const hex = text.slice(start, end)
	const der = Uint8Array.from(hex.match(/../g) ?? [], pair => Number.parseInt(pair, 16))
	const ber = indefinite(der.subarray(0, tlvLength(der, 0)), 3)
	const out = bytes.slice()
	const encoded = new TextEncoder().encode(
		[...ber]
			.map(byte => byte.toString(16).padStart(2, "0"))
			.join("")
			.padEnd(hex.length, "0")
	)

	if (encoded.length !== hex.length) throw new Error("re-encoded /Contents does not fit the gap")

	out.set(encoded, start)

	return out
}

function tlvHeader(der: Uint8Array, at: number): { readonly header: number; readonly length: number } {
	const first = der[at + 1] ?? 0

	if (first < 0x80) return { header: 2, length: first }

	let length = 0

	for (let i = 0; i < (first & 0x7f); i++) length = length * 256 + (der[at + 2 + i] ?? 0)

	return { header: 2 + (first & 0x7f), length }
}

function tlvLength(der: Uint8Array, at: number): number {
	const { header, length } = tlvHeader(der, at)

	return header + length
}

// `tlv` with an indefinite length, and its last child too down to `levels` objects.
function indefinite(tlv: Uint8Array, levels: number): Uint8Array {
	const { header } = tlvHeader(tlv, 0)
	let content = tlv.subarray(header)

	if (levels > 1) {
		let last = 0

		while (last + tlvLength(content, last) < content.length) last += tlvLength(content, last)

		content = Uint8Array.from([...content.subarray(0, last), ...indefinite(content.subarray(last), levels - 1)])
	}

	return Uint8Array.from([tlv[0] ?? 0, 0x80, ...content, 0, 0])
}

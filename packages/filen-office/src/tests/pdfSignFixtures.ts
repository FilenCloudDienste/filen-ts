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

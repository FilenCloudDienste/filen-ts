import { readFileSync } from "node:fs"
import { webcrypto } from "node:crypto"
import * as mupdf from "mupdf"
import forge from "node-forge"
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs"
import { buildPdfCms, importPkcs12, type PdfSignatureReport, type PdfSigningIdentity, type PdfSigningSubtle } from "../core/pdfsign"
import { cmsCapacity } from "../core/pdfsign/cmsBuild"
import { pdfSignatureFields } from "../dom/pdf/signatureFields"
import { createPdfDigest } from "../dom/pdfedit/digest"
import { addPdfSignatureField, signPdfDocument, type PdfSignatureFieldRequest } from "../dom/pdfedit/sign"
import { verifyPdfSignatures } from "../dom/pdfedit/verify"
import { nodeSubtle } from "./pdfSignFixtures"

// The certificate signer's test kit: the PKCS#12 fixtures of src/scripts/pdfSignP12Fixtures.ts, Node's WebCrypto,
// node-forge's legacy ciphers, and a full sign of a PDF verified by our verifier with pdf.js's view of the fields.

export const P12_PASSWORD = "fixture-password"
export const P12_UNICODE_PASSWORD = "Pässwörd-密码"

export const signingSubtle: PdfSigningSubtle = webcrypto.subtle

export const p12Fixture = (name: string): Uint8Array =>
	new Uint8Array(readFileSync(new URL(`fixtures/pdfsign/p12/${name}.p12`, import.meta.url)))

export function loadIdentity(name: string, password = P12_PASSWORD): Promise<PdfSigningIdentity> {
	return importPkcs12(p12Fixture(name), password, { subtle: signingSubtle, legacy: forge })
}

export function signRequest(overrides: Partial<PdfSignatureFieldRequest> = {}): PdfSignatureFieldRequest {
	return {
		placement: { kind: "rect", page: 0, rect: [320, 100, 520, 160] },
		visual: {
			kind: "strokes",
			width: 100,
			height: 40,
			strokes: [
				[
					[5, 30],
					[30, 5],
					[60, 35],
					[95, 10]
				]
			],
			lineWidth: 2,
			color: [0, 0, 0.5]
		},
		lines: ["Digitally signed by Fixture", "Date: 2026-11-14"],
		name: "Fixture Signer",
		reason: "Approval",
		location: "Berlin",
		time: new Date(Date.UTC(2026, 10, 14, 12)),
		certify: null,
		capacity: 0,
		...overrides
	}
}

export interface SignOptions {
	readonly password?: string
	readonly capacity?: number
}

// Signs `bytes` as `identity` and returns the signed file.
export async function signBytes(
	bytes: Uint8Array,
	identity: PdfSigningIdentity,
	request: Partial<PdfSignatureFieldRequest> = {},
	options: SignOptions = {}
): Promise<Uint8Array> {
	const document = new mupdf.PDFDocument(bytes.slice())

	if (options.password !== undefined) document.authenticatePassword(options.password)

	const capacity = options.capacity ?? cmsCapacity(identity)
	const draft = addPdfSignatureField(mupdf, document, signRequest({ capacity, ...request }))
	const revision = await signPdfDocument(mupdf, document, draft, {
		baseLength: bytes.length,
		password: options.password ?? null,
		capacity,
		digest: identity.scheme.digest,
		createDigest: createPdfDigest,
		sign: digest => buildPdfCms(identity, digest, signingSubtle)
	})
	const out = revision.bytes.slice()

	revision.destroy()
	document.destroy()

	return out
}

// Our verifier over `bytes`, cross-checked against the signature fields pdf.js reads (pdf.js must open the file).
export async function verifySigned(bytes: Uint8Array, password?: string): Promise<PdfSignatureReport> {
	const task = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0, ...(password === undefined ? {} : { password }) })
	const pdf = await task.promise
	const expectedFields = pdfSignatureFields(await pdf.getSignatures())

	await task.destroy()

	const open = (data: Uint8Array): mupdf.PDFDocument => {
		const document = new mupdf.PDFDocument(data)

		if (password !== undefined) document.authenticatePassword(password)

		return document
	}
	const document = open(bytes.slice())
	const report = await verifyPdfSignatures(
		document,
		{ length: bytes.length, read: (offset, length) => Promise.resolve(bytes.slice(offset, offset + length)) },
		{
			subtle: nodeSubtle,
			createDigest: createPdfDigest,
			openRevision: length => open(bytes.slice(0, length)),
			expectedFields,
			now: Date.UTC(2026, 10, 14)
		}
	)

	document.destroy()

	return report
}

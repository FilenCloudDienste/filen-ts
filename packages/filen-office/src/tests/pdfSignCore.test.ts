import * as mupdf from "mupdf"
import { describe, expect, it } from "vitest"
import {
	changeAllowed,
	certificationLevel,
	fieldLocked,
	parseByteRange,
	readXrefChain,
	signatureSummary,
	trimDer,
	type PdfSignatureInfo
} from "../core/pdfsign"
import { pdfSignatureFields } from "../dom/pdf/signatureFields"
import { signedFixture as fixture, verifyBytes } from "./pdfSignFixtures"

const source = (bytes: Uint8Array) => ({
	length: bytes.length,
	read: (offset: number, length: number) => Promise.resolve(bytes.slice(offset, offset + length))
})

describe("parseByteRange", () => {
	it("accepts four integers from 0 that fit the file", () => {
		expect(parseByteRange([0, 10, 20, 5], 25)).toEqual([0, 10, 20, 5])
	})

	it.each([
		[[0, 10, 20], 25],
		[[1, 10, 20, 5], 25],
		[[0, 10, 11, 5], 25],
		[[0, 10, 20, 6], 25],
		[[0, 10.5, 20, 5], 25],
		[[0, -1, 20, 5], 25],
		[[0, "10", 20, 5], 25]
	])("rejects %j in a file of %i bytes", (values, length) => {
		expect(parseByteRange(values, length)).toBeNull()
	})
})

describe("trimDer", () => {
	it("keeps the DER object and drops zero padding", () => {
		expect(trimDer(Uint8Array.of(0x30, 0x02, 1, 2, 0, 0))).toEqual(Uint8Array.of(0x30, 0x02, 1, 2))
		expect(trimDer(Uint8Array.of(0x30, 0x81, 0x01, 7, 0))).toEqual(Uint8Array.of(0x30, 0x81, 0x01, 7))
	})

	it("rejects anything after the object but padding, and truncated objects", () => {
		expect(trimDer(Uint8Array.of(0x30, 0x02, 1, 2, 0, 9))).toBeNull()
		expect(trimDer(Uint8Array.of(0x30, 0x05, 1, 2))).toBeNull()
		expect(trimDer(Uint8Array.of(0x04, 0x01, 1))).toBeNull()
	})
})

describe("signature policy", () => {
	const lock = [{ action: "Include" as const, fields: ["Name"] }]

	it("allows by certification level", () => {
		expect(changeAllowed({ kind: "form" }, 1, [])).toBe(false)
		expect(changeAllowed({ kind: "form" }, 2, [])).toBe(true)
		expect(changeAllowed({ kind: "annotation" }, 2, [])).toBe(false)
		expect(changeAllowed({ kind: "annotation" }, 3, [])).toBe(true)
		expect(changeAllowed({ kind: "annotation" }, null, [])).toBe(true)
		expect(changeAllowed({ kind: "signature" }, 1, [])).toBe(false)
		expect(changeAllowed({ kind: "dss" }, 1, [])).toBe(true)
		expect(changeAllowed({ kind: "content" }, null, [])).toBe(false)
	})

	it("honours field locks, including a locked parent", () => {
		expect(changeAllowed({ kind: "form", field: "Name" }, null, lock)).toBe(false)
		expect(changeAllowed({ kind: "form", field: "Other" }, null, lock)).toBe(true)
		expect(fieldLocked([{ action: "Include", fields: ["Address"] }], "Address.Street")).toBe(true)
		expect(fieldLocked([{ action: "Exclude", fields: ["Name"] }], "Other")).toBe(true)
		expect(fieldLocked([{ action: "All", fields: [] }], "Any")).toBe(true)
	})

	it("defaults DocMDP to level 2 and rejects other values", () => {
		expect(certificationLevel(null)).toBe(2)
		expect(certificationLevel(3)).toBe(3)
		expect(certificationLevel(4)).toBeNull()
	})
})

describe("signatureSummary", () => {
	const info = (state: PdfSignatureInfo["state"], allowed?: boolean): PdfSignatureInfo =>
		({ state, changes: allowed === undefined ? null : { allowed, kinds: ["form"] } }) as unknown as PdfSignatureInfo

	it("summarises by the most serious state", () => {
		expect(signatureSummary({ signatures: [], revisions: 1, dss: false })).toBeNull()
		expect(signatureSummary({ signatures: [info("unchanged"), info("changed", true)], revisions: 3, dss: false })?.state).toBe(
			"changedAllowed"
		)
		expect(signatureSummary({ signatures: [info("changed", false), info("invalid")], revisions: 3, dss: false })?.state).toBe("invalid")
		expect(signatureSummary({ signatures: [info("unverifiable"), info("changed", false)], revisions: 3, dss: false })?.state).toBe(
			"unverifiable"
		)
	})
})

describe("readXrefChain", () => {
	it("reads classic tables newest first", async () => {
		const bytes = fixture("approval-filled.pdf")
		const chain = await readXrefChain(source(bytes))

		expect(chain?.sections).toHaveLength(3)
		expect([...(chain?.sections[0]?.entries.keys() ?? [])]).toEqual([0, 8])
	})

	it("reads xref streams with PNG predictors that MuPDF writes", async () => {
		const document = new mupdf.PDFDocument(fixture("unsigned.pdf"))
		const bytes = document.saveToBuffer("compress,objstms").asUint8Array().slice()
		const chain = await readXrefChain(source(bytes))

		expect(new TextDecoder().decode(bytes)).toContain("/XRef")
		expect(chain?.sections).toHaveLength(1)
		expect([...(chain?.sections[0]?.entries.values() ?? [])].some(entry => entry.type === 2)).toBe(true)
	})

	it("returns null for a file without startxref", async () => {
		expect(await readXrefChain(source(new TextEncoder().encode("%PDF-1.7\nnothing here\n")))).toBeNull()
	})
})

describe("MuPDF revisions of a signed file", () => {
	it("judges a form value MuPDF saved incrementally as an allowed change", async () => {
		const document = new mupdf.PDFDocument(fixture("approval-rsa.pdf"))

		document.newIndirect(8).writeObject(document.newIndirect(8).resolve())
		document.newIndirect(8).resolve().put("V", document.newString("Ada"))

		const bytes = document.saveToBuffer("incremental").asUint8Array().slice()
		const report = await verifyBytes(bytes)

		expect(report.signatures[0]).toMatchObject({ state: "changed", changes: { allowed: true, kinds: ["form"] } })
	})

	it("finds a full rewrite of a signed file invalid", async () => {
		const document = new mupdf.PDFDocument(fixture("approval-rsa.pdf"))
		const bytes = document.saveToBuffer("garbage=compact,compress").asUint8Array().slice()
		const report = await verifyBytes(bytes)

		expect(report.signatures[0]?.state).toBe("invalid")
	})
})

describe("pdfSignatureFields", () => {
	it("reads pdf.js's signature metadata and rejects other shapes", () => {
		expect(pdfSignatureFields(null)).toEqual([])
		expect(pdfSignatureFields([{ fieldName: "Sig", byteRange: [0, 1, 3, 4], signerName: "A" }])).toEqual([
			{ name: "Sig", byteRange: [0, 1, 3, 4] }
		])
		expect(pdfSignatureFields([{ fieldName: "Sig", byteRange: [0, 1, 3] }])).toBeNull()
		expect(pdfSignatureFields({})).toBeNull()
	})
})

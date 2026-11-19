import { unzlibSync, zlibSync } from "fflate"
import * as mupdf from "mupdf"
import { describe, expect, it, vi } from "vitest"
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

vi.mock("fflate", async importOriginal => {
	const actual = await importOriginal<typeof import("fflate")>()

	return { ...actual, unzlibSync: vi.fn(actual.unzlibSync) }
})

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

	it("walks an indefinite-length object to the end-of-contents octets that close it", () => {
		// SEQUENCE { [0] { OCTET STRING, SEQUENCE {} }, high-tag-number [31] }, indefinite where BouncyCastle writes it.
		const ber = [0x30, 0x80, 0xa0, 0x80, 0x04, 0x01, 0, 0x30, 0x00, 0, 0, 0x9f, 0x1f, 0x01, 7, 0, 0]

		expect(trimDer(Uint8Array.of(...ber, 0, 0, 0, 0))).toEqual(Uint8Array.of(...ber))
		expect(trimDer(Uint8Array.of(...ber))).toEqual(Uint8Array.of(...ber))
	})

	it("rejects an indefinite-length object followed by anything but padding, unclosed, or overrunning", () => {
		expect(trimDer(Uint8Array.of(0x30, 0x80, 0x04, 0x01, 7, 0, 0, 0, 9))).toBeNull()
		expect(trimDer(Uint8Array.of(0x30, 0x80, 0x04, 0x01, 7, 0))).toBeNull()
		expect(trimDer(Uint8Array.of(0x30, 0x80, 0x04, 0x05, 7, 0, 0))).toBeNull()
		expect(trimDer(Uint8Array.of(0x30, 0x80, 0x04, 0x80, 0, 0, 0, 0))).toBeNull()
		expect(
			trimDer(Uint8Array.of(...Array.from({ length: 40 }, () => [0x30, 0x80]).flat(), ...new Array<number>(80).fill(0)))
		).toBeNull()
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

	it("inflates an xref stream no further than its declared rows need", async () => {
		const rows = Uint8Array.of(0, 0, 0, 0xff, 1, 0, 0x10, 0, 2, 0, 3, 1)
		const inflated = new Uint8Array(16 * 1024 * 1024)

		inflated.set(rows)

		const inflate = vi.mocked(unzlibSync)

		inflate.mockClear()

		const chain = await readXrefChain(source(xrefStreamFile([{ dict: "/W [1 2 1] /Size 3", data: inflated }])))

		expect(inflate.mock.calls[0]?.[1]?.out?.length).toBe(rows.length)
		expect(chain?.sections[0]?.entries).toEqual(
			new Map([
				[0, { type: 0 }],
				[1, { type: 1, offset: 16, gen: 0 }],
				[2, { type: 2, stream: 3, index: 1 }]
			])
		)
	})

	it("refuses rows the file does not pay for, within a section and over the chain", async () => {
		const inflate = vi.mocked(unzlibSync)

		inflate.mockClear()

		expect(
			await readXrefChain(source(xrefStreamFile([{ dict: "/W [1 0 0] /Size 8388607", data: new Uint8Array(8_388_607) }])))
		).toBeNull()
		expect(inflate).not.toHaveBeenCalled()

		const half = { dict: "/W [1 0 0] /Size 40000", data: new Uint8Array(40_000) }

		expect((await readXrefChain(source(xrefStreamFile([half]))))?.sections[0]?.entries.size).toBe(40_000)
		expect(await readXrefChain(source(xrefStreamFile([half, half])))).toBeNull()
	})

	it("reads a large file whose every revision rewrites the full table", async () => {
		const objects = 50_000
		const data = new Uint8Array((objects + 1) * 6)

		for (let num = 1; num <= objects; num++) {
			const offset = num * 20

			data.set([1, offset >>> 24, (offset >>> 16) & 0xff, (offset >>> 8) & 0xff, offset & 0xff, 0], num * 6)
		}

		const revisions = 8
		const chain = await readXrefChain(
			source(
				xrefStreamFile(
					Array.from({ length: revisions }, () => ({ dict: `/W [1 4 1] /Size ${objects + 1}`, data })),
					objects * 20
				)
			)
		)

		expect(chain?.sections).toHaveLength(revisions)
		expect(chain?.sections.every(section => section.entries.size === objects + 1)).toBe(true)
	})
})

// A file of `padding` filler bytes then one xref stream per section, newest last, each pointing at the one before.
function xrefStreamFile(sections: readonly { readonly dict: string; readonly data: Uint8Array }[], padding = 0): Uint8Array {
	const encoder = new TextEncoder()
	const parts: Uint8Array[] = [encoder.encode("%PDF-1.7\n"), new Uint8Array(padding).fill(0x20)]
	let length = parts.reduce((sum, part) => sum + part.length, 0)
	let prev: number | null = null

	for (const [i, section] of sections.entries()) {
		const stream = zlibSync(section.data)
		const head = encoder.encode(
			`${i + 1} 0 obj\n<< /Type /XRef ${section.dict}${prev === null ? "" : ` /Prev ${prev}`} /Filter /FlateDecode /Length ${stream.length} >>\nstream\n`
		)
		const tail = encoder.encode("\nendstream\nendobj\n")

		prev = length
		parts.push(head, stream, tail)
		length += head.length + stream.length + tail.length
	}

	parts.push(encoder.encode(`startxref\n${prev ?? 0}\n%%EOF\n`))

	const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
	let at = 0

	for (const part of parts) {
		bytes.set(part, at)
		at += part.length
	}

	return bytes
}

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

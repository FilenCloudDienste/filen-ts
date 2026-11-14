import { describe, expect, it } from "vitest"
import {
	addPdfSignature,
	deletePdfSignature,
	emptyPdfSignatures,
	isStorablePdfSignature,
	mergePdfSignatures,
	parsePdfSignatures,
	PDF_SIGNATURES_MAX_PER_ROLE,
	PdfSignaturesVersionError,
	samePdfSignatures,
	serializePdfSignatures,
	type SavedPdfSignature
} from "@filen/shared/pdfSignatures"

const strokes = (id: string, at: number, role: "signature" | "initials" = "signature"): SavedPdfSignature => ({
	id,
	role,
	at,
	data: { kind: "strokes", width: 1000, height: 400, strokes: [[0, 0, 500, 400, 1000, 0]] }
})

const image = (id: string, at: number): SavedPdfSignature => ({
	id,
	role: "initials",
	at,
	data: { kind: "image", width: 120, height: 40, png: "iVBORw0KGgo=" }
})

describe("saved PDF signatures", () => {
	it("round-trips through its stored text, newest first", () => {
		const doc = addPdfSignature(addPdfSignature(emptyPdfSignatures(), strokes("a", 1)), image("b", 2))
		const again = parsePdfSignatures(serializePdfSignatures(doc))

		expect(again.items.map(item => item.id)).toEqual(["b", "a"])
		expect(again.items[1]?.data).toEqual(strokes("a", 1).data)
		expect(again.items[0]?.data).toEqual(image("b", 2).data)
		expect(samePdfSignatures(doc, again)).toBe(true)
	})

	it("drops entries that are not the format and refuses a newer one", () => {
		const text = JSON.stringify({
			v: 1,
			items: [
				{ id: "ok", role: "signature", at: 1, kind: "strokes", width: 10, height: 10, strokes: [[1, 2, 3, 4]] },
				{ id: "odd", role: "signature", at: 1, kind: "strokes", width: 10, height: 10, strokes: [[1, 2, 3]] },
				{ id: "big", role: "signature", at: 1, kind: "strokes", width: 99999, height: 10, strokes: [[1, 2]] },
				{ id: "png", role: "initials", at: 1, kind: "image", width: 10, height: 10, png: "<script>" },
				{ id: "who", role: "stamp", at: 1, kind: "image", width: 10, height: 10, png: "AAAA" },
				"nonsense"
			],
			deleted: { "bad id!": 1, gone: "x" }
		})

		const doc = parsePdfSignatures(text)

		expect(doc.items.map(item => item.id)).toEqual(["ok"])
		expect(doc.deleted.size).toBe(0)
		expect(() => parsePdfSignatures(JSON.stringify({ v: 2 }))).toThrow(PdfSignaturesVersionError)
		expect(() => parsePdfSignatures("{")).toThrow(SyntaxError)
	})

	it("merges by union; a deletion on either side wins", () => {
		const base = addPdfSignature(emptyPdfSignatures(), strokes("a", 1))
		const left = addPdfSignature(base, strokes("b", 2))
		const right = deletePdfSignature(addPdfSignature(base, strokes("c", 3)), "a", 4)
		const merged = mergePdfSignatures(left, right)

		expect(merged.items.map(item => item.id)).toEqual(["c", "b"])
		expect(merged.deleted.get("a")).toBe(4)
		expect(samePdfSignatures(merged, mergePdfSignatures(right, left))).toBe(true)
		// A deleted entry never comes back from a stale copy.
		expect(addPdfSignature(merged, strokes("a", 5)).items.map(item => item.id)).toEqual(["c", "b"])
	})

	it("keeps at most the newest entries per role", () => {
		let doc = addPdfSignature(emptyPdfSignatures(), strokes("initials", 0, "initials"))

		for (let index = 1; index <= PDF_SIGNATURES_MAX_PER_ROLE + 2; index++) doc = addPdfSignature(doc, strokes(`s${String(index)}`, index))

		const signatures = doc.items.filter(item => item.role === "signature")

		expect(signatures.length).toBe(PDF_SIGNATURES_MAX_PER_ROLE)
		expect(signatures.at(-1)?.id).toBe("s3")
		expect(doc.items.some(item => item.id === "initials")).toBe(true)
		expect(doc.deleted.has("s1")).toBe(true)
	})

	it("refuses what a read would drop", () => {
		expect(isStorablePdfSignature({ kind: "strokes", width: 10, height: 10, strokes: [] })).toBe(false)
		expect(isStorablePdfSignature({ kind: "image", width: 10, height: 10, png: "A".repeat(400_000) })).toBe(false)
		expect(addPdfSignature(emptyPdfSignatures(), { ...strokes("a", 1), data: { kind: "strokes", width: 0, height: 1, strokes: [[0, 0]] } }).items).toEqual([])
	})
})

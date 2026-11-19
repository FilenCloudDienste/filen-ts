import { describe, expect, it } from "vitest"
import { bytesSource } from "../core/opc/index"
import { verifyOds } from "../core/ods/verify"
import { odsBytes, odsDocument, openOdsFixture, table } from "./odsFixtures"

// A save the verification refuses answers a message hosts log: it names where and what kind of difference, never
// what a cell holds; the two sides are on detail.

function row(cell: string): string {
	return `<table:table-row>${cell}</table:table-row>`
}

async function refusal(source: string, written: string) {
	const document = odsDocument(await openOdsFixture({ body: table("Sheet1", row(source)) }))

	await document.readyAllSheets()

	const proof = await verifyOds(document, bytesSource(odsBytes({ body: table("Sheet1", row(written)) })))

	if (proof.ok) throw new Error("the proof accepted a different file")

	return proof
}

const SECRET = "Salary of J. Doe: 123456 EUR"
const OTHER = "Harmless other words"

describe("an ODS verification refusal", () => {
	it("names the cell and the kind of a text difference, not either text", async () => {
		const proof = await refusal(
			`<table:table-cell office:value-type="string"><text:p>${SECRET}</text:p></table:table-cell>`,
			`<table:table-cell office:value-type="string"><text:p>${OTHER}</text:p></table:table-cell>`
		)

		expect(proof.message).toBe(`Sheet1 A1: text (length ${SECRET.length} → ${OTHER.length})`)
		expect(proof.detail).toContain(SECRET)
		expect(proof.detail).toContain(OTHER)
	})

	it("names a formula difference without the formula's text", async () => {
		const proof = await refusal(
			`<table:table-cell table:formula="of:=CONCATENATE(&quot;${SECRET}&quot;;&quot;x&quot;)" office:value-type="string" office:string-value="${SECRET}x"><text:p>${SECRET}x</text:p></table:table-cell>`,
			`<table:table-cell table:formula="of:=CONCATENATE(&quot;${OTHER}&quot;;&quot;x&quot;)" office:value-type="string" office:string-value="${SECRET}x"><text:p>${SECRET}x</text:p></table:table-cell>`
		)

		expect(proof.message).toMatch(/^Sheet1 A1: formula \(length \d+ → \d+\)$/)
		expect(proof.message).not.toContain("Salary")
		expect(proof.message).not.toContain("Harmless")
		expect(proof.detail).toContain(SECRET)
		expect(proof.detail).toContain(OTHER)
	})

	it("names a number difference without either number", async () => {
		const proof = await refusal(
			'<table:table-cell office:value-type="float" office:value="123456"><text:p>123456</text:p></table:table-cell>',
			'<table:table-cell office:value-type="float" office:value="654321"><text:p>654321</text:p></table:table-cell>'
		)

		expect(proof.message).toBe("Sheet1 A1: number")
		expect(proof.detail).toContain("123456")
		expect(proof.detail).toContain("654321")
	})

	it("keeps an unopenable file's reader message off the message", async () => {
		const document = odsDocument(await openOdsFixture({ body: table("Sheet1", row("<table:table-cell/>")) }))
		const proof = await verifyOds(document, bytesSource(new TextEncoder().encode(`${SECRET} is not a zip`)))

		expect(proof.ok).toBe(false)

		if (proof.ok) return

		expect(proof.message).toMatch(/^The save does not open: [A-Za-z]+$/)
		expect(proof.detail).toBeDefined()
	})

	it("keeps a kept formula's text off the message", async () => {
		// B() is LibreOffice's binomial, which the engine's grammar does not take: the formula is kept as written.
		const kept = (words: string): string =>
			`<table:table-cell table:formula="of:=IF(B(1;0.5;1)&gt;0;0.5;&quot;${words}&quot;)" office:value-type="float" office:value="0.5"><text:p>0.5</text:p></table:table-cell>`
		const proof = await refusal(kept(SECRET), kept(OTHER))

		expect(proof.message).toBe("References kept outside the cells read back otherwise")
		expect(proof.detail).toContain(OTHER)
	})
})

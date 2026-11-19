import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { encodeUtf8 } from "@filen/office/core/xml"
import { validityErrors, XMLLINT } from "./fuzz/harness"
import { NOT_WELL_FORMED, XsdOracle, xsdOracleMissing } from "./oracles/xsd"
import { SML } from "./oracles/sheet/synthetic"

// Both xmllint oracles read its exit status: a schema that does not compile or an input that does not parse is
// not "no validity errors". Skips without xmllint (and, for XsdOracle, without the Part 4 archive).

const SCHEMA =
	'<?xml version="1.0"?><xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"><xs:element name="a" type="xs:int"/></xs:schema>'
// A type in a namespace no prefix binds: the schema does not compile.
const BROKEN =
	'<?xml version="1.0"?><xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"><xs:element name="a" type="nope:int"/></xs:schema>'

describe.skipIf(!XMLLINT)("validityErrors", () => {
	let directory: string

	beforeAll(() => {
		directory = mkdtempSync(join(tmpdir(), "filen-office-xmllint-status-"))
		writeFileSync(join(directory, "schema.xsd"), SCHEMA)
		writeFileSync(join(directory, "broken.xsd"), BROKEN)
	})

	afterAll(() => {
		rmSync(directory, { recursive: true, force: true })
	})

	it("reports a valid and an invalid document as before", () => {
		const schema = join(directory, "schema.xsd")

		expect([...validityErrors(schema, encodeUtf8("<a>1</a>"))]).toEqual([])
		expect([...validityErrors(schema, encodeUtf8("<a>x</a>")).keys()]).toEqual([
			"element a: Schemas validity error : Element 'a': 'x' is not a valid value of the atomic type 'xs:int'."
		])
	})

	it("throws for a schema that does not compile", () => {
		expect(() => validityErrors(join(directory, "broken.xsd"), encodeUtf8("<a>1</a>"))).toThrow(/exited 5[\s\S]*failed to compile/)
	})

	it("throws for an input that does not parse", () => {
		expect(() => validityErrors(join(directory, "schema.xsd"), encodeUtf8("<a>1"))).toThrow(/exited 1[\s\S]*parser error/)
	})
})

const MISSING = xsdOracleMissing()

describe.skipIf(MISSING !== undefined)("XsdOracle", () => {
	const documents = [
		`<sst xmlns="${SML}" count="1" uniqueCount="1"><si><t>a</t></si></sst>`,
		`<sst xmlns="${SML}" count="1" uniqueCount="1"><bogus/></sst>`,
		`<sst xmlns="${SML}">`
	].map(encodeUtf8)

	it("reports valid, invalid and not well-formed documents", { timeout: 60_000 }, () => {
		const oracle = new XsdOracle()

		try {
			const results = oracle.validate(documents).map(errors => [...errors.keys()].join(" | "))

			expect(results[0]).toBe("")
			expect(results[1]).toMatch(/bogus'?: This element is not expected/)
			expect(results[2]).toBe(NOT_WELL_FORMED)
		} finally {
			oracle.dispose()
		}
	})

	it("throws when its schemas do not compile", { timeout: 60_000 }, () => {
		const oracle = new XsdOracle()

		try {
			writeFileSync(join(oracle.directory, "schemas", "oracle.xsd"), BROKEN)

			expect(() => oracle.validate(documents.slice(0, 2))).toThrow(/exited 5[\s\S]*failed to compile/)
		} finally {
			oracle.dispose()
		}
	})
})

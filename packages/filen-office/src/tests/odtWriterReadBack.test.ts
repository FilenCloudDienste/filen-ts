import { describe, expect, it, vi } from "vitest"
import type * as translate from "../core/odt/translate"
import type { OdtSource } from "../core/odt/write/source"
import { OdtWriteRefusal, writeOdt, type OdtEdits } from "../core/odt/write/writer"
import { decodeUtf8, encodeUtf8 } from "../core/xml/index"
import { odtBytes } from "./odtFixtures"
import { odtSource } from "./odtWriteFixtures"

// While `corrupt` is set, the written file reads back with the edited words replaced (the same length, so every
// offset the translation holds stays): the whole file's proof then finds the block reading differently.
const state = { corrupt: false }

vi.mock("../core/odt/translate", async original => {
	const actual = await original<typeof translate>()

	return {
		...actual,
		translateOdt: vi.fn(async (...args: Parameters<typeof actual.translateOdt>) => {
			const read = await actual.translateOdt(...args)

			if (!state.corrupt || !read.ok) return read

			const parts = new Map(read.translation.parts)
			const body = parts.get("word/document.xml")

			if (body instanceof Uint8Array)
				parts.set("word/document.xml", encodeUtf8(decodeUtf8(body).replace("Secret First", "Leaked First")))

			return { ...read, translation: { ...read.translation, parts } }
		})
	}
})

const DOC = odtBytes({
	styles: '<style:style style:name="Standard" style:family="paragraph" style:class="text"/>',
	body: "<text:p>First paragraph here</text:p><text:p>Second paragraph here</text:p>"
})

function body(source: OdtSource): string {
	return decodeUtf8(source.translation.parts.get("word/document.xml") as Uint8Array)
}

function edited(xml: string): OdtEdits {
	return { parts: new Map([["word/document.xml", encodeUtf8(xml)]]) }
}

async function refusal(source: OdtSource, edits: OdtEdits): Promise<unknown> {
	return writeOdt(source, edits, { spanProof: false }).then(
		() => undefined,
		(error: unknown) => error
	)
}

describe("ODT writer read-back refusal", () => {
	it("names which block reads back differently, never what it reads as, and keeps both readings on the detail", async () => {
		const source = await odtSource(DOC)
		const xml = body(source)

		expect(xml).toContain("First paragraph here")

		state.corrupt = true

		const error = await refusal(source, edited(xml.replace("First paragraph here", "Secret First paragraph here"))).finally(() => {
			state.corrupt = false
		})

		expect(error).toBeInstanceOf(OdtWriteRefusal)

		if (!(error instanceof OdtWriteRefusal)) return

		// A block's reading is a digest of its meaning: a guess at a short block's text could confirm it, so neither
		// reading is in the message (which is logged).
		expect(error.reason).toBe("proof")
		expect(error.message).toBe("block 0 reads back differently")
		expect(error.detail).toMatch(/^[0-9a-z]+\.[0-9a-z]+\.[0-9a-z]+ != [0-9a-z]+\.[0-9a-z]+\.[0-9a-z]+$/u)
		// Not enumerable: a spread or a structured log does not copy it.
		expect(Object.keys(error)).not.toContain("detail")
		expect(JSON.stringify({ ...error })).not.toContain("!=")
	})

	it("names a field it cannot write by its keyword only, never by what its instruction holds", async () => {
		const source = await odtSource(DOC)
		const xml = body(source)
		const field = (instruction: string): OdtEdits =>
			edited(
				xml.replace(
					/(<w:p\b[^>]*>(?:(?!<\/w:p>)[\s\S])*?)(<\/w:p>)/u,
					`$1<w:fldSimple w:instr="${instruction}"><w:r><w:t>shown</w:t></w:r></w:fldSimple>$2`
				)
			)

		const named = await refusal(source, field(" MERGEFIELD Client "))
		const crafted = await refusal(source, field("confidential-client-name:Acme"))

		expect(named).toBeInstanceOf(OdtWriteRefusal)
		expect(crafted).toBeInstanceOf(OdtWriteRefusal)
		expect((named as OdtWriteRefusal).message).toBe("the field MERGEFIELD")
		expect((crafted as OdtWriteRefusal).reason).toBe("field")
		expect((crafted as OdtWriteRefusal).message).toBe("a field")
	})
})

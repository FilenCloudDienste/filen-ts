import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { openOdp } from "../core/odp/read/document"
import { bytesSource } from "../core/opc/index"
import { referencedNames } from "../core/odp/write/styles"
import { decodeUtf8, encodeUtf8 } from "../core/xml/index"
import { CORPUS_DIR } from "./corpusDir"

// The style names a stream refers to, as every value of an attribute ending in "style-name" reads (the expression
// below is the definition): the same set on hand-made markup and on every corpus deck's content and styles.

function expected(bytes: Uint8Array): Set<string> {
	const out = new Set<string>()

	for (const match of decodeUtf8(bytes, 0, bytes.length).matchAll(/[\w-]*style-name="([^"]*)"/gu)) out.add(match[1] ?? "")

	return out
}

function names(bytes: Uint8Array): Set<string> {
	const out = new Set<string>()

	referencedNames(bytes, out)

	return out
}

const MARKUP = [
	'<a text:style-name="P1" draw:text-style-name="T é" style-name="x" b="y"/>',
	'<a text:style-name=\'single\' style-name="a"="b" c="style-name="/>',
	'<a text:style-name="unterminated x="1"/>',
	'style-name="" style-name="é\u{1F600}" stylename="no" style-name ="spaced"',
	'<a draw:style-name="a&amp;b"/><b presentation:style-name="pr1"/>style-name="'
]

describe("the style names a stream refers to", () => {
	for (const markup of MARKUP)
		it(`reads ${JSON.stringify(markup)} as the definition does`, () => {
			const bytes = encodeUtf8(markup)

			expect(names(bytes)).toEqual(expected(bytes))
		})

	it("reads invalid UTF-8 inside a value as the definition does", () => {
		const bytes = new Uint8Array([...encodeUtf8('<a text:style-name="'), 0xff, 0xc3, 0x41, ...encodeUtf8('"/>')])

		expect(names(bytes)).toEqual(expected(bytes))
	})

	it.skipIf(!existsSync(join(CORPUS_DIR, "odp")))(
		"reads every corpus deck's streams as the definition does",
		{ timeout: 300_000 },
		async () => {
			const directory = join(CORPUS_DIR, "odp")
			let decks = 0

			for (const file of readdirSync(directory).filter(name => name.toLowerCase().endsWith(".odp"))) {
				const opened = await openOdp(bytesSource(new Uint8Array(readFileSync(join(directory, file)))))

				if (opened.kind !== "opened") continue

				decks++

				const content = opened.parts.content.bytes

				expect([file, names(content)]).toEqual([file, expected(content)])

				const styles = opened.parts.sheet.stylesDocument

				if (styles !== undefined) expect([file, names(styles.bytes)]).toEqual([file, expected(styles.bytes)])
			}

			expect(decks).toBeGreaterThan(0)
		}
	)
})

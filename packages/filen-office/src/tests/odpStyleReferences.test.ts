import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { openOdp } from "../core/odp/read/document"
import { styleReferences } from "../core/odp/write/splice"
import { bytesSource } from "../core/opc/index"
import type { SlideRef } from "../core/presentation/model"
import { decodeCharacterData, decodeUtf8, encodeUtf8 } from "../core/xml/index"
import { CORPUS_DIR } from "./corpusDir"
import { odpBytes, page } from "./odpFixtures"
import { driveSession } from "./odpWriteDrive"
import { budget, cpuMs } from "./timing"

// The style names a written content stream refers to (what the save's orphan check keeps): every value of an
// attribute ending in "style-name" or "master-page-name", either quote, a value with references decoded. The
// expression below is the definition; the scan reads as it does, in time linear in the stream.

const DEFINITION = /[\w.-]*(?:style-name|-style-name|list-style-name|data-style-name|master-page-name)=(?:"([^"]*)"|'([^']*)')/gu

function expected(bytes: Uint8Array): Set<string> {
	const out = new Set<string>()

	for (const match of decodeUtf8(bytes, 0, bytes.length).matchAll(DEFINITION)) {
		const value = match[1] ?? match[2] ?? ""

		if (!value.includes("&")) {
			out.add(value)
			continue
		}

		const raw = encodeUtf8(value)

		try {
			out.add(decodeCharacterData(raw, 0, raw.length, true))
		} catch {
			out.add(value)
		}
	}

	return out
}

const MARKUP = [
	'<a text:style-name="P1" draw:master-page-name=\'M 1\' style:list-style-name="L&#x31;" style:data-style-name="N&amp;1"/>',
	'<a text:style-name="un\'quoted" b=\'style-name="x\' style-name="&bogus;" master-page-name="a&#9;b"/>',
	'<a text:style-name="unterminated x="1"/> master-page-name=\'y',
	'style-name="" style-name ="no" style-name= "no" master-page-name="é😀" pagename="no"',
	`${"word".repeat(10_000)}style-name="tail"`
]

describe("the style names a written content stream refers to", () => {
	for (const markup of MARKUP)
		it(`reads ${JSON.stringify(markup.slice(0, 60))} as the definition does`, () => {
			const bytes = encodeUtf8(markup)

			expect(styleReferences(bytes)).toEqual(expected(bytes))
		})

	it.skipIf(!existsSync(join(CORPUS_DIR, "odp")))(
		"reads every corpus deck's content as the definition does",
		{ timeout: 300_000 },
		async () => {
			const directory = join(CORPUS_DIR, "odp")
			let decks = 0

			for (const file of readdirSync(directory).filter(name => name.toLowerCase().endsWith(".odp"))) {
				const opened = await openOdp(bytesSource(new Uint8Array(readFileSync(join(directory, file)))))

				if (opened.kind !== "opened") continue

				decks++
				expect([file, styleReferences(opened.parts.content.bytes)]).toEqual([file, expected(opened.parts.content.bytes)])
			}

			expect(decks).toBeGreaterThan(0)
		}
	)

	it("saves a deck whose content holds a 1 MB run of letters within 200 ms CPU", { timeout: budget(60_000) }, async ({ task }) => {
		const s = await driveSession(
			odpBytes({
				body: page(`<draw:frame><draw:text-box><text:p>${"a".repeat(1_000_000)}</text:p></draw:text-box></draw:frame>`) + page("")
			}),
			"odp"
		)

		expect((await s.command({ family: "slide", kind: "hide", slides: [s.session.deck.slides[1] as SlideRef], hidden: true })).ok).toBe(
			true
		)

		const start = cpuMs()
		const saved = await s.save()
		const spent = cpuMs() - start

		expect(saved.result.kind).toBe("written")
		Object.assign(task.meta, { perf: { odpSaveLetterRunCpuMs: { value: spent, budget: 200 } } })
		expect(spent).toBeLessThanOrEqual(budget(200))
	})
})

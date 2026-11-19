import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { bytesSource, ZipArchive } from "@filen/office/core/opc"
import { openOdtAsDocx } from "../core/odt/index"
import { CORPUS_DIR } from "./corpusDir"
import { odtBytes } from "./odtFixtures"
import { buildZip } from "./zipBuilder"
import { rng as random } from "./mulberry32"

// Mutated packages: every open either succeeds or fails with a typed reason, never with an exception.

const BASE = odtBytes({
	automatic:
		'<style:style style:name="P1" style:family="paragraph" style:master-page-name="Standard"><style:paragraph-properties fo:margin-left="1cm" style:page-number="2"/><style:text-properties fo:font-size="150%"/></style:style><text:list-style style:name="L1"><text:list-level-style-number text:level="1" style:num-format="1"/></text:list-style><style:style style:name="fr" style:family="graphic"><style:graphic-properties style:wrap="dynamic"/></style:style>',
	body:
		'<text:tracked-changes><text:changed-region text:id="c"><text:deletion><office:change-info><dc:creator>A</dc:creator></office:change-info><text:p>x</text:p></text:deletion></text:changed-region></text:tracked-changes>' +
		'<text:h text:outline-level="1" text:style-name="P1">Head<text:note><text:note-body><text:p>n</text:p></text:note-body></text:note></text:h>' +
		'<text:list text:style-name="L1"><text:list-item><text:p>a<text:change text:change-id="c"/><text:a xlink:href="#b">l</text:a></text:p></text:list-item></text:list>' +
		'<table:table><table:table-column table:number-columns-repeated="2"/><table:table-row><table:table-cell table:number-columns-spanned="2" table:number-rows-spanned="2"><text:p>c</text:p></table:table-cell><table:covered-table-cell/></table:table-row><table:table-row><table:covered-table-cell table:number-columns-repeated="2"/></table:table-row></table:table>' +
		'<text:section text:name="s"><text:p>s<draw:frame draw:style-name="fr" svg:width="3cm" svg:height="2cm"><draw:text-box><text:p>t</text:p></draw:text-box></draw:frame>' +
		'<draw:custom-shape svg:width="1cm" svg:height="1cm"><draw:enhanced-geometry svg:viewBox="0 0 10 10" draw:enhanced-path="M 0 0 L ?a 10 A 0 0 10 10 0 5 10 5 W 0 0 10 10 5 0 5 10 Z N"><draw:equation draw:name="a" draw:formula="sin(pi/2)*10"/></draw:enhanced-geometry></draw:custom-shape></text:p></text:section>'
})

const SNIPPETS = [
	"<text:p>",
	"</text:list>",
	"<table:table-row>",
	"<!--",
	"<![CDATA[",
	"&",
	"<draw:frame",
	'"',
	"<?pi",
	"</office:text>",
	"<text:note>",
	'<text:list text:continue-list="x">'
]

function mutate(xml: Uint8Array, next: () => number): Uint8Array {
	const bytes = Array.from(xml)
	const edits = 1 + Math.floor(next() * 6)

	for (let k = 0; k < edits; k++) {
		const at = Math.floor(next() * bytes.length)
		const kind = next()

		if (kind < 0.3) bytes[at] = Math.floor(next() * 256)
		else if (kind < 0.5) bytes.splice(at, Math.floor(next() * 40))
		else if (kind < 0.8) bytes.splice(at, 0, ...new TextEncoder().encode(SNIPPETS[Math.floor(next() * SNIPPETS.length)] ?? ""))
		else bytes.length = Math.max(0, at)
	}

	return Uint8Array.from(bytes)
}

async function entries(odt: Uint8Array): Promise<{ name: string; data: Uint8Array }[]> {
	const archive = await ZipArchive.open(bytesSource(odt))

	return Promise.all(archive.entries.map(async entry => ({ name: entry.name, data: await archive.read(entry) })))
}

async function expectTyped(bytes: Uint8Array): Promise<void> {
	const opened = await openOdtAsDocx(bytesSource(bytes))

	if (!opened.ok) expect(typeof opened.reason).toBe("string")
}

describe("ODT translation of damaged packages", () => {
	it("opens or refuses mutated content and styles streams without throwing", async () => {
		const base = await entries(BASE)
		const next = random(20)

		for (let round = 0; round < 300; round++) {
			const target = round % 3 === 0 ? "styles.xml" : "content.xml"
			const parts = base.map(entry => (entry.name === target ? { ...entry, data: mutate(entry.data, next) } : entry))

			await expectTyped(
				buildZip(parts.map(entry => ({ name: entry.name, data: entry.data, method: entry.name === "mimetype" ? 0 : 8 })))
			)
		}
	})

	it("refuses truncated and bit-flipped packages with a reason", async () => {
		const next = random(7)

		for (let round = 0; round < 100; round++) {
			const bytes = BASE.slice(0, Math.floor(next() * BASE.length))

			const flip = Math.floor(next() * bytes.length)

			if (round % 2 === 0 && flip < bytes.length) bytes[flip] = (bytes[flip] ?? 0) ^ 0xff

			await expectTyped(bytes)
		}
	})

	const directory = join(CORPUS_DIR, "odt")

	it.skipIf(!existsSync(directory))(
		"opens mutated corpus documents or refuses them, typed",
		async () => {
			const next = random(3)
			const files = readdirSync(directory)
				.filter(name => name.endsWith(".odt"))
				.sort()

			for (const name of files.slice(0, 40)) {
				const original = new Uint8Array(readFileSync(join(directory, name)))
				let parts: { name: string; data: Uint8Array }[]

				try {
					parts = await entries(original)
				} catch {
					continue
				}

				const content = parts.find(entry => entry.name === "content.xml")

				if (content === undefined || content.data.length > 2_000_000) continue

				for (let round = 0; round < 3; round++) {
					const mutated = parts.map(entry => (entry === content ? { ...entry, data: mutate(entry.data, next) } : entry))

					await expectTyped(
						buildZip(mutated.map(entry => ({ name: entry.name, data: entry.data, method: entry.name === "mimetype" ? 0 : 8 })))
					)
				}
			}
		},
		120_000
	)
})

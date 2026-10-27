import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { bytesSource } from "../core/opc/index"
import { Fragment } from "../core/odp/read/context"
import { openOdp } from "../core/odp/read/document"
import { pageFragment } from "../core/odp/read/scan"
import { Namespaces } from "../core/xml/index"
import { digestOf } from "../core/presentation/edit/changes"
import type { SlideNode } from "../core/presentation/model"
import { CORPUS_DIR } from "./corpusDir"
import { odpBytes } from "./odpFixtures"
import { ODP_DECK } from "./odpWriteFixtures"

// The reader's page fields for a page in any fragment (pageFields), and the display names of synthesized layouts
// (ODF 1.3 Part 3: a presentation page layout's display name, §16.41, else a master page's style:display-name, §16.9).

async function opened(bytes: Uint8Array) {
	const result = await openOdp(bytesSource(bytes))

	if (result.kind !== "opened") throw new Error(result.reason)

	await result.parts.parseAll()

	return result
}

describe("ODP page fields", () => {
	const decks = [
		odpBytes({
			...ODP_DECK,
			automatic: (ODP_DECK.automatic ?? "").replace(
				'<style:drawing-page-properties presentation:background-visible="true"/>',
				'<style:drawing-page-properties presentation:background-visible="true" draw:fill="solid" draw:fill-color="#336699" smil:type="fade" smil:subtype="crossfade"/>'
			)
		}),
		...["govuk__bbfa-11-business-lifecycle.odp", "govuk__Workshop_in_a_box_slides_ODP.odp"]
			.map(name => join(CORPUS_DIR, "odp", name))
			.filter(path => existsSync(path))
			.map(path => new Uint8Array(readFileSync(path)))
	]

	it("reads a page's background and transition the same from any fragment as when it reads the page", async () => {
		let pages = 0

		for (const bytes of decks) {
			const { deck, parts } = await opened(bytes)

			for (const ref of deck.slides) {
				const node = deck.nodes.get(ref) as SlideNode
				const src = node.src

				if (src?.format !== "odp") continue

				const span = parts.span(ref)

				if (span === undefined) continue

				const document = pageFragment(parts.content, span)
				const fragment = new Fragment(
					document,
					new Namespaces(document, { lenient: true }),
					"content.xml",
					span.start,
					"content",
					0
				)
				const fields = parts.pageFields(fragment, document.firstChildElement(document.documentElement()))

				expect(digestOf(fields), String(ref)).toBe(digestOf({ background: node.background, transition: node.transition }))
				pages++
			}
		}

		expect(pages).toBeGreaterThan(3)
	})
})

describe("ODP layout names", () => {
	it("names a layout by the presentation page layout styles.xml defines, never by a master's internal name", async () => {
		const { deck } = await opened(
			odpBytes({
				...ODP_DECK,
				styles: `${ODP_DECK.styles ?? ""}<style:presentation-page-layout style:name="AL1T0" style:display-name="Title, Content"><presentation:placeholder presentation:object="title" svg:x="2cm" svg:y="1cm" svg:width="24cm" svg:height="3cm"/></style:presentation-page-layout>`
			})
		)
		const names = deck.layouts.map(ref => deck.nodes.get(ref)?.name)
		const types = deck.layouts.map(ref => deck.nodes.get(ref)?.layoutType)

		expect(names).toEqual(["Title, Content", undefined])
		expect(types).toEqual(["AL1T0", undefined])
	})

	it.skipIf(!existsSync(join(CORPUS_DIR, "odp", "govuk__Workshop_in_a_box_slides_ODP.odp")))(
		"names no layout by internal style names (LibreOffice's MasterN-PPLn, MasterN-LayoutN-…)",
		async () => {
			const { deck } = await opened(new Uint8Array(readFileSync(join(CORPUS_DIR, "odp", "govuk__Workshop_in_a_box_slides_ODP.odp"))))
			const names = deck.layouts.map(ref => deck.nodes.get(ref)?.name ?? "")

			expect(names.length).toBeGreaterThan(1)
			expect(names).toContain("Contenet slide")
			expect(names.some(name => /Master\d|PPL\d/u.test(name))).toBe(false)
		}
	)
})

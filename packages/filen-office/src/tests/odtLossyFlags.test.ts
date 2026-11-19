import { describe, expect, it } from "vitest"
import { bytesSource } from "@filen/office/core/opc"
import { translateOdt } from "../core/odt/index"
import { odtBytes, translated } from "./odtFixtures"

// What an ODT translation approximates is flagged on the blocks that show it, and only there; a document nested
// past what the translator follows is refused as malformed.

const PNG = Uint8Array.from(
	atob("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP4z8DAAMIM/4EAAB/uBfsL2WiLAAAAAElFTkSuQmCC"),
	c => c.charCodeAt(0)
)

function picture(graphic: string): Parameters<typeof odtBytes>[0] {
	return {
		automatic: `<style:style style:name="fr1" style:family="graphic"><style:graphic-properties ${graphic}/></style:style>`,
		body: '<text:p><draw:frame draw:style-name="fr1" text:anchor-type="as-char" svg:width="1cm" svg:height="1cm"><draw:image xlink:href="Pictures/a.png"/></draw:frame></text:p>',
		extra: [{ name: "Pictures/a.png", data: PNG }]
	}
}

describe("ODT nesting", () => {
	for (const [name, open, close] of [
		[
			"frames",
			'<text:p><draw:frame text:anchor-type="as-char" svg:width="1cm" svg:height="1cm"><draw:text-box>',
			"</draw:text-box></draw:frame></text:p>"
		],
		[
			"tables",
			"<table:table><table:table-column/><table:table-row><table:table-cell>",
			"</table:table-cell></table:table-row></table:table>"
		],
		[
			"notes",
			'<text:p><text:note text:note-class="footnote"><text:note-citation>1</text:note-citation><text:note-body>',
			"</text:note-body></text:note></text:p>"
		],
		["spans", "<text:span>", "</text:span>"],
		["lists", "<text:list><text:list-item>", "</text:list-item></text:list>"],
		["shape groups", "<draw:g>", "</draw:g>"]
	] as const) {
		it(`refuses ${name} nested 2,000 deep as malformed`, async () => {
			const inline = name === "spans" || name === "shape groups"
			const inner =
				name === "spans" ? "x" : name === "shape groups" ? '<draw:rect svg:width="1cm" svg:height="1cm"/>' : "<text:p>x</text:p>"
			const nested = `${open.repeat(2000)}${inner}${close.repeat(2000)}`
			const body = inline ? `<text:p>${nested}</text:p>` : nested
			const result = await translateOdt(bytesSource(odtBytes({ body })))

			expect(result.ok).toBe(false)
			if (!result.ok) expect(result.reason).toBe("malformed")
		})
	}

	it("translates ordinary nesting (a list ten deep in a table in a frame)", async () => {
		const list = `${"<text:list><text:list-item>".repeat(10)}<text:p>deep</text:p>${"</text:list-item></text:list>".repeat(10)}`
		const body = `<text:p><draw:frame text:anchor-type="as-char" svg:width="5cm" svg:height="5cm"><draw:text-box><table:table><table:table-column/><table:table-row><table:table-cell>${list}</table:table-cell></table:table-row></table:table></draw:text-box></draw:frame></text:p>`

		await expect(translated({ body })).resolves.toBeDefined()
	})
})

describe("ODT lossy flags", () => {
	it("flags the blocks whose common paragraph style is approximated, and the document", async () => {
		const translation = await translated({
			styles: '<style:style style:name="Low" style:family="paragraph"><style:text-properties fo:text-transform="lowercase"/></style:style><style:style style:name="Child" style:family="paragraph" style:parent-style-name="Low"/>',
			automatic: '<style:style style:name="P1" style:family="paragraph" style:parent-style-name="Child"/>',
			body: '<text:p text:style-name="Low">AAA</text:p><text:p>plain</text:p><text:p text:style-name="P1">BBB</text:p>'
		})

		expect(translation.origins.map(origin => origin.lossy.includes("textTransform"))).toEqual([true, false, true])
		expect(translation.lossy.get("textTransform")).toBe(2)
	})

	it("counts what only an unused common style approximates once for the document", async () => {
		const translation = await translated({
			styles: '<style:style style:name="Unused" style:family="paragraph"><style:text-properties fo:text-transform="capitalize"/></style:style>',
			body: "<text:p>plain</text:p>"
		})

		expect(translation.origins[0]?.lossy).toEqual([])
		expect(translation.lossy.get("textTransform")).toBe(1)
	})

	it("flags every paragraph of an automatic style it approximates, and every span of one, not only the first", async () => {
		const translation = await translated({
			automatic:
				'<style:style style:name="P3" style:family="paragraph"><style:text-properties fo:text-transform="lowercase"/></style:style><style:style style:name="T2" style:family="text"><style:text-properties style:text-rotation-angle="90"/></style:style>',
			body: '<text:p text:style-name="P3">ONE</text:p><text:p text:style-name="P3">TWO</text:p><text:p>plain</text:p><text:p text:style-name="P3">THREE</text:p><text:p>a <text:span text:style-name="T2">b</text:span></text:p><text:p>c <text:span text:style-name="T2">d</text:span></text:p>'
		})

		expect(translation.origins.map(origin => origin.lossy.includes("textTransform"))).toEqual([true, true, false, true, false, false])
		expect(translation.origins.map(origin => origin.lossy.includes("textEffect"))).toEqual([false, false, false, false, true, true])
		expect(translation.lossy.get("textTransform")).toBe(3)
		expect(translation.lossy.get("textEffect")).toBe(2)
	})

	it("flags a table of contents kept as its entries, and a bookmark between blocks", async () => {
		const translation = await translated({
			body: '<text:table-of-content text:name="toc"><text:table-of-content-source/><text:index-body><text:p>entry</text:p></text:index-body></text:table-of-content><text:bookmark text:name="b"/><text:p>after</text:p>'
		})

		expect(translation.origins[0]?.lossy).toContain("index")
		expect(translation.origins[1]?.lossy).toContain("bookmark")
		expect(translation.origins[2]?.lossy).toEqual([])
	})

	it("does not flag LibreOffice's zero crop rectangle or neutral adjustments", async () => {
		const translation = await translated(
			picture('fo:clip="rect(0cm, 0cm, 0cm, 0cm)" draw:luminance="0%" draw:contrast="0%" draw:gamma="100%"')
		)

		expect(translation.lossy.has("imageAdjustment")).toBe(false)
	})

	for (const graphic of ['fo:clip="rect(0.5cm, 0cm, 0cm, 0cm)"', 'draw:gamma="150%"', 'draw:luminance="10%"']) {
		it(`flags an image adjustment it does not translate (${graphic})`, async () => {
			expect((await translated(picture(graphic))).lossy.has("imageAdjustment")).toBe(true)
		})
	}

	it("translates image opacity as DrawingML alpha", async () => {
		const translation = await translated(picture('draw:image-opacity="40%"'))
		const document = new TextDecoder().decode(translation.parts.get("word/document.xml") as Uint8Array)

		expect(document).toContain('<a:alphaModFix amt="40000"/>')
		expect(translation.lossy.has("imageAdjustment")).toBe(false)
	})

	it("lists styles.xml origins in stream order", async () => {
		const translation = await translated({
			masters:
				'<style:master-page style:name="Standard" style:page-layout-name="pm1"><style:header><text:p>H</text:p></style:header><style:footer><text:p>F</text:p></style:footer></style:master-page><style:master-page style:name="Second" style:page-layout-name="pm1"><style:header><text:p>H2</text:p></style:header><style:footer><text:p>F2</text:p></style:footer></style:master-page>',
			automatic: '<style:style style:name="P2" style:family="paragraph" style:master-page-name="Second"/>',
			body: '<text:p>one</text:p><text:p text:style-name="P2">two</text:p>'
		})
		const starts = translation.origins.filter(origin => origin.stream === "styles.xml").map(origin => origin.start)

		expect(starts.length).toBeGreaterThanOrEqual(4)
		expect(starts).toEqual([...starts].sort((a, b) => a - b))
	})
})

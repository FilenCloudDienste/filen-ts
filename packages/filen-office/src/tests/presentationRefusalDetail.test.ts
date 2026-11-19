import { describe, expect, it } from "vitest"
import { zipParts, type TemplatePart } from "../core/templates/zip"
import { designDeckParts } from "./presentationDesignFixtures"
import { editHarness } from "./presentationEditFixtures"

// A refused command carries the detail its apply family built (which shape blocked it) next to the reason, for logs
// and reports; the reason the page turns into its notice is unchanged.

const A = "http://schemas.openxmlformats.org/drawingml/2006/main"
const P = "http://schemas.openxmlformats.org/presentationml/2006/main"
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
const MC = "http://schemas.openxmlformats.org/markup-compatibility/2006"

// A shape in a branch the reader takes (p14, with its fallback copy), kept as written: its fallback states a text
// size its Choice does not, so no stated value of the read branch says how the other's scales.
const P14 = "http://schemas.microsoft.com/office/powerpoint/2010/main"
const KEPT = (rPr: string): string =>
	'<p:sp><p:nvSpPr><p:cNvPr id="7" name="Kept"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="11000000" y="6000000"/><a:ext cx="1000000" cy="500000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>' +
	`<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"${rPr}/><a:t>y</a:t></a:r></a:p></p:txBody></p:sp>`
const UNEVEN =
	`<mc:AlternateContent xmlns:mc="${MC}"><mc:Choice xmlns:p14="${P14}" Requires="p14">${KEPT("")}</mc:Choice>` +
	`<mc:Fallback>${KEPT(' sz="2400"')}</mc:Fallback></mc:AlternateContent>`

function slide(content: string): string {
	return (
		`<p:sld xmlns:a="${A}" xmlns:r="${R}" xmlns:p="${P}"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
		'<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
		`${content}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`
	)
}

function deck(content: string): Promise<Uint8Array> {
	const parts = designDeckParts(["title", "blank"]).map(([name, markup, stored]): TemplatePart =>
		name === "ppt/slides/slide2.xml" ? [name, slide(content)] : stored === undefined ? [name, markup] : [name, markup, stored]
	)

	return zipParts(parts)
}

describe("refused command detail", () => {
	it("a refused slide size change names the kept shape next to the reason", async () => {
		const h = await editHarness(await deck(UNEVEN))
		const result = await h.command({
			family: "design",
			kind: "setSize",
			cx: 9_144_000,
			cy: 6_858_000,
			type: "screen4x3",
			scale: "ensureFit"
		})

		expect(result).toEqual({
			ok: false,
			refusal: "locked",
			detail: "Kept is kept as written and its text would not scale with the slide size"
		})
		h.close()
	})
})

import { describe, expect, it } from "vitest"
import { bytesSource } from "@filen/office/core/opc"
import { openPptx, type PptxParts } from "../core/pptx/package"
import { resolveBackground, themeFillStyle } from "../core/presentation/background"
import { creationId, newGuid, nextMasterLayoutId, nextShapeId, nextSlideId, SlideRefs, uniqueShapeIds } from "../core/presentation/ids"
import { inheritedShapes, resolveBodyPr, resolveParagraph, resolveRun, resolveShape, styleFont } from "../core/presentation/inherit"
import type { Deck, ShapeNode, SlideNode } from "../core/presentation/model"
import { applyMods, effectiveClrMap, presetColor, resolveColor, themeTypeface } from "../core/presentation/theme"
import { body, buildPptx, para, sp, xfrm, type FixtureOptions } from "./pptxFixtures"

// Placeholder and text-style inheritance, colour resolution through themes and colour maps, backgrounds and the
// identifiers a deck needs unique.

async function open(options: FixtureOptions): Promise<{ deck: Deck; parts: PptxParts; slides: SlideNode[] }> {
	const result = await openPptx(bytesSource(buildPptx(options)))

	if (result.kind !== "opened") throw new Error(result.reason)

	await result.parts.parseAll()

	return { deck: result.deck, parts: result.parts, slides: result.deck.slides.map(ref => result.deck.nodes.get(ref) ?? never()) }
}

function never(): never {
	throw new Error("unexpected undefined")
}

function shape(slide: SlideNode | undefined, name: string): ShapeNode {
	return slide?.shapes.find(candidate => candidate.name === name) ?? never()
}

describe("placeholder inheritance", () => {
	it("places a placeholder without xfrm at its layout's box, else its master's", async () => {
		const { deck, slides } = await open({ slides: [{ shapes: sp(2, "Title", 'type="title"') + sp(3, "Body", 'idx="1"') }] })
		const slide = slides[0] ?? never()
		const title = resolveShape(deck, slide.ref, shape(slide, "Title"))
		const content = resolveShape(deck, slide.ref, shape(slide, "Body"))

		// The layout's title has no xfrm: the master's title box.
		expect(title.match).toBe("idx")
		expect(title.levels.map(level => level.node.kind)).toEqual(["slide", "layout", "master"])
		expect(title.xfrm).toMatchObject({ x: 100, y: 200, cx: 3000, cy: 400 })
		expect(title.xfrmFrom).toBe(deck.masters[0])
		expect(content.xfrm).toMatchObject({ x: 150, y: 750, cx: 2900, cy: 1900 })
		expect(content.xfrmFrom).toBe(deck.layouts[0])
	})

	it("keeps a slide's own xfrm whole", async () => {
		const { deck, slides } = await open({ slides: [{ shapes: sp(2, "Title", 'type="title"', xfrm(1, 2, 3, 4)) }] })
		const slide = slides[0] ?? never()

		expect(resolveShape(deck, slide.ref, shape(slide, "Title")).xfrm).toMatchObject({ x: 1, y: 2, cx: 3, cy: 4 })
	})

	it("matches by type when the layout has no placeholder of that idx, then the master by type", async () => {
		const { deck, slides } = await open({
			slides: [
				{ shapes: sp(2, "Body", 'type="body" idx="42"') + sp(3, "Title", 'type="title" idx="4294967295"'), layout: 1 },
				{ shapes: sp(2, "Title", 'type="title"'), layout: 2 }
			]
		})
		const [first, second] = slides
		const body42 = resolveShape(deck, first?.ref ?? never(), shape(first, "Body"))
		const orphan = resolveShape(deck, second?.ref ?? never(), shape(second, "Title"))

		// The layout's content placeholder (idx 1, type obj) by type class; the "Blank" layout has no title: the master's.
		expect(body42.match).toBe("type")
		expect(body42.xfrm).toMatchObject({ x: 150, y: 750 })
		expect(resolveShape(deck, first?.ref ?? never(), shape(first, "Title")).match).toBe("type")
		expect(orphan.match).toBe("master")
		expect(orphan.xfrm).toMatchObject({ x: 100, y: 200, cx: 3000, cy: 400 })
	})

	it("never matches an idx across placeholder classes", async () => {
		// A body written without idx (idx 0) must not take the layout's title (idx 0).
		const { deck, slides } = await open({ slides: [{ shapes: sp(2, "Body", 'type="body"') }] })
		const slide = slides[0] ?? never()
		const resolved = resolveShape(deck, slide.ref, shape(slide, "Body"))

		expect(resolved.match).toBe("type")
		expect(resolved.levels[1]?.shape.name).toBe("Content Placeholder 2")
	})

	it("inherits notes placeholders from the notes master by type", async () => {
		const { deck, slides } = await open({ slides: [{ shapes: "", notes: para("n") }] })
		const notes = deck.nodes.get(slides[0]?.notes ?? never()) ?? never()
		const resolved = resolveShape(deck, notes.ref, shape(notes, "Notes Placeholder 2"))

		expect(resolved.xfrm).toMatchObject({ x: 10, y: 20, cx: 300, cy: 400 })
		// A placeholder stops at the master's notesStyle (MS-OI29500 §2.1.1388(a)), so it is last.
		expect(resolved.listStyles[resolved.listStyles.length - 1]?.levels[0]).toEqual({ defRPr: { sz: 1200 } })
	})

	it("resolves bodyPr attribute by attribute, insets per side", async () => {
		const { deck, slides } = await open({
			slides: [{ shapes: sp(3, "Body", 'idx="1"', "", body(para("x"), '<a:bodyPr rIns="0" wrap="none"/>')) }]
		})
		const slide = slides[0] ?? never()
		const resolved = resolveShape(deck, slide.ref, shape(slide, "Body"))

		// rIns from the slide, tIns from the layout, lIns from the master, bIns by default; wrap from the slide.
		expect(resolved.bodyPr.insets).toEqual({ left: 12700 / 9525, top: 0, right: 0, bottom: 4.8 })
		expect(resolved.bodyPr.wrap).toBe(false)
		expect(resolved.bodyPr.anchor).toBe("t")
	})

	it("keeps fontScale with the autofit choice it came with", () => {
		expect(resolveBodyPr([{ autofit: "none" }, { autofit: "normal", fontScale: 0.5, lineSpacingReduction: 0.1 }])).toMatchObject({
			autofit: "none",
			fontScale: 1,
			lineSpacingReduction: 0
		})
		expect(resolveBodyPr([{ anchor: "b" }, { autofit: "normal", fontScale: 0.5 }])).toMatchObject({
			anchor: "b",
			autofit: "normal",
			fontScale: 0.5
		})
	})

	it("resolves text level by level: run, shape, layout, master placeholder, txStyles, defaults", async () => {
		const { deck, slides } = await open({
			slides: [
				{
					shapes:
						sp(
							3,
							"Body",
							'idx="1"',
							"",
							body(
								para("x", ' b="1"') + para("y", "", '<a:pPr lvl="1"/>'),
								"<a:bodyPr/>",
								'<a:lstStyle><a:lvl1pPr algn="r"/></a:lstStyle>'
							)
						) + sp(4, "Box", undefined, "", body(para("z")))
				}
			],
			presentation: '<p:defaultTextStyle><a:lvl1pPr><a:defRPr sz="1100" kern="1200"/></a:lvl1pPr></p:defaultTextStyle>'
		})
		const slide = slides[0] ?? never()
		const content = resolveShape(deck, slide.ref, shape(slide, "Body"))
		const [first, second] = shape(slide, "Body").text?.paragraphs ?? []
		const p1 = resolveParagraph(content, first ?? never())
		const p2 = resolveParagraph(content, second ?? never())
		const run = first?.runs[0]

		expect(content.textClass).toBe("body")
		// algn from the slide's lstStyle, sz from the layout's (2600 over the master body style's 2800), marL and the
		// bullet from the master's bodyStyle; a placeholder never reaches defaultTextStyle (MS-OI29500 §2.1.1388(a)).
		expect(p1.pPr).toMatchObject({ algn: "r", marL: 228600, bullet: { kind: "char", char: "•" }, defRPr: { sz: 2600 } })
		expect(p1.pPr.defRPr?.kern).toBeUndefined()
		expect(resolveRun(p1, run?.kind === "r" ? run.rPr : undefined)).toMatchObject({ b: true, sz: 2600, lang: "en-GB" })
		expect(p2.level).toBe(1)
		expect(p2.pPr).toMatchObject({ marL: 685800, defRPr: { sz: 2400 } })

		const box = resolveShape(deck, slide.ref, shape(slide, "Box"))
		const boxParagraph = resolveParagraph(box, shape(slide, "Box").text?.paragraphs[0] ?? never())

		expect(box.textClass).toBe("other")
		expect(boxParagraph.pPr.defRPr).toMatchObject({ sz: 1800, kern: 1200 })
	})

	it("starts titles from the master's title style", async () => {
		const { deck, slides } = await open({ slides: [{ shapes: sp(2, "Title", 'type="title"', "", body(para("T"))) }] })
		const slide = slides[0] ?? never()
		const resolved = resolveShape(deck, slide.ref, shape(slide, "Title"))

		expect(resolveParagraph(resolved, shape(slide, "Title").text?.paragraphs[0] ?? never()).pPr).toMatchObject({
			algn: "ctr",
			defRPr: { sz: 4400, latin: { typeface: "+mj-lt" } }
		})
		expect(resolved.bodyPr.anchor).toBe("ctr")
	})

	it("finds property groups per level, an edit's props first", async () => {
		const { deck, slides, parts } = await open({
			slides: [{ shapes: sp(2, "Title", 'type="title"', '<a:solidFill><a:srgbClr val="FF0000"/></a:solidFill><a:ln w="1"/>') }]
		})
		const slide = slides[0] ?? never()
		const title = shape(slide, "Title")
		const resolved = resolveShape(deck, slide.ref, title, parts)

		expect(resolved.fill).toMatchObject({ kind: "source", from: slide.ref, src: { part: "/ppt/slides/slide1.xml" } })
		expect(resolved.ln?.kind).toBe("source")
		expect(resolved.geometry).toBeUndefined()

		title.props = { fill: "none" }
		slide.revision++

		expect(resolveShape(deck, slide.ref, title, parts).fill).toEqual({ kind: "props", value: "none", from: slide.ref })
	})

	it("memoizes by revisions and recomputes after an edit", async () => {
		const { deck, slides } = await open({ slides: [{ shapes: sp(2, "Title", 'type="title"') }] })
		const slide = slides[0] ?? never()
		const title = shape(slide, "Title")
		const first = resolveShape(deck, slide.ref, title)

		expect(resolveShape(deck, slide.ref, title)).toBe(first)

		const master = deck.nodes.get(deck.masters[0] ?? never()) ?? never()
		const masterTitle = master.shapes.find(candidate => candidate.ph?.type === "title") ?? never()

		masterTitle.xfrm = { ...(masterTitle.xfrm ?? never()), x: 999 }
		master.revision++

		expect(resolveShape(deck, slide.ref, title).xfrm?.x).toBe(999)
	})

	it("paints layout and master shapes only as showMasterSp allows, never their placeholders", async () => {
		const { deck, slides } = await open({
			slides: [{ shapes: "" }, { shapes: "", attributes: ' showMasterSp="0"' }],
			layouts: [
				{
					name: "No master shapes",
					shapes: sp(2, "Layout Art", undefined) + sp(3, "Title", 'type="title"'),
					attributes: ' showMasterSp="0"'
				}
			]
		})

		expect(inheritedShapes(deck, slides[0] ?? never()).map(level => level.shape.name)).toEqual(["Layout Art"])
		expect(inheritedShapes(deck, slides[1] ?? never())).toEqual([])

		const plain = await open({ slides: [{ shapes: "" }] })

		expect(inheritedShapes(plain.deck, plain.slides[0] ?? never()).map(level => level.shape.name)).toEqual([
			"Master Logo",
			"Layout Line"
		])
	})

	it("names a non-placeholder's style font for the text adapter", async () => {
		const { deck, slides } = await open({
			slides: [
				{
					shapes: '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Styled"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/><p:style><a:lnRef idx="2"><a:schemeClr val="accent1"/></a:lnRef><a:fillRef idx="1"><a:schemeClr val="accent1"/></a:fillRef><a:effectRef idx="0"><a:schemeClr val="accent1"/></a:effectRef><a:fontRef idx="minor"><a:schemeClr val="lt1"/></a:fontRef></p:style></p:sp>'
				}
			]
		})
		const slide = slides[0] ?? never()
		const resolved = resolveShape(deck, slide.ref, shape(slide, "Styled"))

		expect(resolved.style).toMatchObject({
			ln: { idx: 2 },
			fill: { idx: 1 },
			font: { idx: "minor", color: { kind: "scheme", slot: "lt1" } }
		})
		expect(styleFont(resolved)).toEqual({ typeface: "+mn-lt" })
	})
})

describe("themes and colours", () => {
	it("resolves scheme colours through the master's map and a slide's override", async () => {
		const { deck, parts, slides } = await open({
			slides: [
				{ shapes: "" },
				{
					shapes: "",
					after: '<p:clrMapOvr><a:overrideClrMapping bg1="dk1" tx1="lt1" bg2="dk2" tx2="lt2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/></p:clrMapOvr>'
				}
			]
		})
		const theme = parts.theme("/ppt/theme/theme1.xml")
		const [plain, inverted] = slides

		expect(resolveColor({ kind: "scheme", slot: "bg1" }, { theme, clrMap: effectiveClrMap(deck.nodes, plain ?? never()) })).toEqual({
			hex: "FFFFFF",
			alpha: 1
		})
		expect(resolveColor({ kind: "scheme", slot: "bg1" }, { theme, clrMap: effectiveClrMap(deck.nodes, inverted ?? never()) })).toEqual({
			hex: "000000",
			alpha: 1
		})
		expect(
			resolveColor(
				{
					kind: "scheme",
					slot: "accent1",
					mods: [
						{ name: "lumMod", value: 75000 },
						{ name: "alpha", value: 40000 }
					]
				},
				{ theme, clrMap: effectiveClrMap(deck.nodes, plain ?? never()) }
			)
		).toEqual({ hex: "2F5597", alpha: 0.4 })
	})

	it("resolves presets, system colours and phClr", () => {
		const context = { theme: undefined, clrMap: effectiveClrMap(new Map(), { parent: undefined } as unknown as SlideNode) }

		expect(presetColor("dkGoldenrod")).toBe("B8860B")
		expect(presetColor("darkGoldenrod")).toBe("B8860B")
		expect(resolveColor({ kind: "preset", name: "cornflowerBlue" }, context)).toEqual({ hex: "6495ED", alpha: 1 })
		expect(resolveColor({ kind: "system", name: "window", lastColor: "fafafa" }, context)).toEqual({ hex: "FAFAFA", alpha: 1 })
		expect(resolveColor({ kind: "system", name: "windowText" }, context)).toEqual({ hex: "000000", alpha: 1 })
		expect(resolveColor({ kind: "scheme", slot: "phClr" }, context)).toBeUndefined()
		expect(
			resolveColor(
				{ kind: "scheme", slot: "phClr", mods: [{ name: "shade", value: 50000 }] },
				{ ...context, phClr: { hex: "FFFFFF", alpha: 1 } }
			)?.hex
		).toBe("BCBCBC")
	})

	it("applies every DrawingML colour transform in order", () => {
		expect(applyMods("808080", 1, [{ name: "inv" }]).hex).toBe("7F7F7F")
		expect(applyMods("FF0000", 1, [{ name: "comp" }]).hex).toBe("00FFFF")
		expect(applyMods("FF0000", 1, [{ name: "gray" }]).hex).toBe("4D4D4D")
		expect(applyMods("FF0000", 1, [{ name: "hue", value: 120 * 60000 }]).hex).toBe("00FF00")
		expect(applyMods("FF0000", 1, [{ name: "sat", value: 0 }]).hex).toBe("808080")
		expect(applyMods("FF0000", 1, [{ name: "lum", value: 100000 }]).hex).toBe("FFFFFF")
		expect(applyMods("000000", 1, [{ name: "red", value: 100000 }]).hex).toBe("FF0000")
		expect(applyMods("000000", 1, [{ name: "blueOff", value: 100000 }]).hex).toBe("0000FF")
		expect(applyMods("FFFFFF", 1, [{ name: "greenMod", value: 0 }]).hex).toBe("FF00FF")
		expect(
			applyMods("FFFFFF", 0.5, [
				{ name: "alphaMod", value: 50000 },
				{ name: "alphaOff", value: 10000 }
			]).alpha
		).toBeCloseTo(0.35)
		expect(applyMods("808080", 1, [{ name: "gamma" }, { name: "invGamma" }]).hex).toBe("808080")
	})

	it("resolves theme font references, with script overrides", async () => {
		const { parts } = await open({ slides: [] })
		const theme = parts.theme("/ppt/theme/theme1.xml")

		expect(themeTypeface(theme, "+mj-lt")).toBe("Major Face")
		expect(themeTypeface(theme, "+mn-ea")).toBe("Minor EA")
		expect(themeTypeface(theme, "+mj-ea", "Jpan")).toBe("Jpan Major")
		expect(themeTypeface(theme, "+mn-cs")).toBeUndefined()
		expect(themeTypeface(theme, "Calibri")).toBe("Calibri")
	})

	it("finds a slide's background on the nearest level and the theme fill a bgRef names", async () => {
		const { deck, parts, slides } = await open({
			slides: [{ shapes: "" }, { shapes: "<p:cSld><p:bg><p:bgPr><a:noFill/><a:effectLst/></p:bgPr></p:bg><p:spTree/></p:cSld>" }]
		})
		const inherited = resolveBackground(deck, slides[0] ?? never())
		const own = resolveBackground(deck, slides[1] ?? never())
		const theme = parts.theme("/ppt/theme/theme1.xml")?.document ?? never()

		expect(inherited?.node.kind).toBe("master")
		expect(inherited?.background).toMatchObject({ kind: "ref", idx: 1002 })
		expect(own?.node.kind).toBe("slide")

		const fill = themeFillStyle(theme, 1002)

		expect(theme.localName(fill)).toBe("solidFill")
		expect(theme.localName(themeFillStyle(theme, 1003))).toBe("gradFill")
		expect(theme.localName(themeFillStyle(theme, 1))).toBe("solidFill")
		expect(themeFillStyle(theme, 0)).toBe(-1)
		expect(themeFillStyle(theme, 1000)).toBe(-1)
		expect(themeFillStyle(theme, 1009)).toBe(-1)
	})
})

describe("identifiers", () => {
	it("allocates slide ids from 256 and master/layout ids from 2^31, never colliding", () => {
		expect(nextSlideId([])).toBe(256)
		expect(nextSlideId([256, 300])).toBe(301)
		expect(nextSlideId([2_147_483_647, 256])).toBe(257)
		expect(nextMasterLayoutId([2_147_483_648, 2_147_483_650])).toBe(2_147_483_651)
		expect(nextMasterLayoutId([4_294_967_295])).toBe(2_147_483_648)
	})

	it("hands out slide refs once", () => {
		const refs = new SlideRefs()

		expect([refs.next(), refs.next(), refs.next()]).toEqual([1, 2, 3])
	})

	it("makes cNvPr ids unique across groups and allocates the next", () => {
		const shapes: ShapeNode[] = [
			{ id: 2, name: "a", hidden: false, kind: "sp" },
			{ id: 3, name: "g", hidden: false, kind: "grpSp", children: [{ id: 2, name: "b", hidden: false, kind: "sp" }] }
		]

		expect(uniqueShapeIds(shapes, [1])).toBe(1)
		expect(shapes[1]?.children?.[0]).toMatchObject({ id: 4, sourceId: 2 })
		expect(nextShapeId(shapes)).toBe(5)
	})

	it("makes version 4 GUIDs and creation ids from the random source given", () => {
		const random = (count: number): Uint32Array => Uint32Array.from({ length: count }, (_, index) => 0x01234567 * (index + 1))

		expect(newGuid(random)).toMatch(/^\{[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}\}$/u)
		expect(creationId(random)).toBe(0x01234567)
	})
})

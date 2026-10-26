import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { cfbBytes } from "@filen/office/core/cfb"
import { bytesSource } from "@filen/office/core/opc"
import { openEncryptedPackage } from "@filen/office/dom/encryption"
import { strToU8, unzipSync, zipSync } from "fflate"
import { openPptx, type PptxOpen } from "../core/pptx/package"
import { DEFAULT_PRESENTATION_BUDGETS, type PresentationBudgets } from "../core/presentation/budget"
import { encryptionRefusal } from "../core/presentation/refusal"
import type { CorpusManifest } from "../scripts/corpusManifest"
import { CORPUS_DIR } from "./corpusDir"
import { irmPptx, minimalPptx, modifyVerifierPptx } from "./fixtures/presentation/protected"
import { buildPptx, para, sp, body, xfrm } from "./pptxFixtures"

// Opening presentation packages: refusals before anything is shown, variants, the view-only gates, encrypted
// packages through the realm that holds the password, and slides read on demand.

function opened(result: PptxOpen): Extract<PptxOpen, { kind: "opened" }> {
	if (result.kind !== "opened") throw new Error(`refused: ${result.reason} ${result.detail ?? ""}`)

	return result
}

const manifest = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "corpus", "manifest.json"), "utf8")) as CorpusManifest
const corpusFile = (path: string): Uint8Array | undefined => {
	const file = join(CORPUS_DIR, path)

	return existsSync(file) ? new Uint8Array(readFileSync(file)) : undefined
}

describe("pptx package open", () => {
	it("opens a minimal deck with its master, layout and slide", async () => {
		const { deck, parts } = opened(await openPptx(bytesSource(minimalPptx("Hello"))))

		expect(deck.format).toBe("pptx")
		expect(deck.variant).toBe("pptx")
		expect(deck.size).toEqual({ cx: 9_144_000, cy: 6_858_000, type: "screen4x3" })
		expect(deck.masters).toHaveLength(1)
		expect(deck.layouts).toHaveLength(1)
		expect(deck.slides).toHaveLength(1)
		expect(deck.gate).toEqual([])

		const slide = await parts.slide(deck.slides[0] ?? never())
		const title = slide.shapes[0]

		expect(title?.ph).toEqual({ type: "title", idx: 0 })
		expect(title?.text?.paragraphs[0]?.runs[0]).toEqual({ kind: "r", text: "Hello", rPr: { lang: "en-US" } })
	})

	it("reads slides only when asked, and knows hidden slides at open", async () => {
		const bytes = buildPptx({
			slides: [{ shapes: sp(2, "A", undefined) }, { shapes: sp(2, "B", undefined), attributes: ' show="0"' }, { shapes: "" }]
		})
		const { deck, parts } = opened(await openPptx(bytesSource(bytes)))

		expect(deck.slides).toHaveLength(3)
		expect(deck.slides.some(ref => deck.nodes.has(ref))).toBe(false)
		expect([...parts.hiddenAtOpen]).toEqual([deck.slides[1]])
		expect([...(deck.hiddenSlides ?? [])]).toEqual([deck.slides[1]])

		const second = await parts.slide(deck.slides[1] ?? never())

		expect(second.hidden).toBe(true)
		expect(deck.nodes.has(deck.slides[0] ?? never())).toBe(false)

		parts.release(deck.slides[1] ?? never())
		expect(deck.nodes.has(deck.slides[1] ?? never())).toBe(false)
		expect((await parts.slide(deck.slides[1] ?? never())).shapes[0]?.name).toBe("B")
	})

	it("parses one slide once when asked twice at the same time", async () => {
		const { deck, parts } = opened(await openPptx(bytesSource(buildPptx({ slides: [{ shapes: sp(2, "A", undefined) }] }))))
		const ref = deck.slides[0] ?? never()
		const [first, second] = await Promise.all([parts.slide(ref), parts.slide(ref)])

		expect(first).toBe(second)
	})

	it("names the variant from the main part's content type, macros making it macro-enabled", async () => {
		const cases = [
			["application/vnd.openxmlformats-officedocument.presentationml.template.main+xml", "potx"],
			["application/vnd.openxmlformats-officedocument.presentationml.slideshow.main+xml", "ppsx"],
			["application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml", "pptm"],
			["application/vnd.ms-powerpoint.template.macroEnabled.main+xml", "potm"],
			["application/vnd.ms-powerpoint.slideshow.macroEnabled.main+xml", "ppsm"]
		] as const

		for (const [type, variant] of cases) {
			const { deck } = opened(await openPptx(bytesSource(buildPptx({ slides: [], mainContentType: type }))))

			expect(deck.variant).toBe(variant)
		}

		const macro = buildPptx({
			slides: [],
			presentationRels: [["rId50", "http://schemas.microsoft.com/office/2006/relationships/vbaProject", "vbaProject.bin"]],
			parts: { "ppt/vbaProject.bin": { data: new Uint8Array([1, 2, 3]), type: "application/vnd.ms-office.vbaProject" } }
		})
		const { deck } = opened(await openPptx(bytesSource(macro)))

		expect(deck.variant).toBe("pptm")
		expect(deck.opaque).toEqual([{ part: "/ppt/vbaProject.bin", kind: "vbaProject" }])
	})

	it("refuses what is not a presentation package, typed", async () => {
		expect(await openPptx(bytesSource(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])))).toMatchObject({
			kind: "refused",
			reason: "malformed"
		})

		const workbook = buildPptx({
			slides: [],
			mainContentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"
		})

		expect(await openPptx(bytesSource(workbook))).toMatchObject({ kind: "refused", reason: "unsupported" })

		const legacy = await cfbBytes([{ path: ["PowerPoint Document"], bytes: new Uint8Array(64) }])

		expect(await openPptx(bytesSource(legacy))).toMatchObject({ kind: "refused", reason: "unsupported" })
	})

	it("defaults the slide size to PowerPoint's 4:3 when p:sldSz is absent", async () => {
		const { deck } = opened(await openPptx(bytesSource(buildPptx({ slides: [], sldSz: "" }))))

		expect(deck.size).toEqual({ cx: 9_144_000, cy: 6_858_000 })
		expect(deck.firstSlideNumber).toBe(1)
	})

	it("lists a slide's layout that no master lists, so inheritance still finds it", async () => {
		const files = unzipSync(buildPptx({ slides: [{ shapes: sp(2, "Title", 'type="title"'), layout: 2 }] }))
		const master = new TextDecoder().decode(files["ppt/slideMasters/slideMaster1.xml"])

		files["ppt/slideMasters/slideMaster1.xml"] = strToU8(master.replace(/<p:sldLayoutId id="2147483650" r:id="rId2"\/>/u, ""))

		const { deck, parts } = opened(await openPptx(bytesSource(zipSync(files))))
		const slide = await parts.slide(deck.slides[0] ?? never())

		expect(deck.layouts).toHaveLength(2)
		expect(slide.parent === undefined ? undefined : deck.nodes.get(slide.parent)?.name).toBe("Blank")
	})
})

describe("pptx gates", () => {
	it("opens a write-reserved deck view-only, with its verifier", async () => {
		const { deck } = opened(await openPptx(bytesSource(modifyVerifierPptx())))

		expect(deck.gate).toEqual(["writeProtected"])
		expect(deck.protection.modifyVerifier).toMatchObject({ algorithm: "SHA-512", spinCount: 1000 })
	})

	it("refuses a rights-managed package before any prompt", async () => {
		const bytes = await irmPptx()

		expect(await openPptx(bytesSource(bytes))).toMatchObject({ kind: "refused", reason: "encrypted" })

		const verdict = await openEncryptedPackage(bytesSource(bytes))

		expect(verdict.kind).toBe("refused")
		expect(verdict.kind === "refused" ? encryptionRefusal(verdict.reason) : undefined).toBe("rightsManaged")
	})

	it("marks a deck whose presentation part is malformed", async () => {
		const bytes = buildPptx({ slides: [], presentation: '<p:defaultTextStyle rtl="0" rtl="1"/>' })
		const { deck } = opened(await openPptx(bytesSource(bytes)))

		expect(deck.gate).toContain("malformed")
	})

	const signed = [
		"tika__testPPT_signed.pptx",
		"poi__ms-office-2010-signed.pptx",
		"poi__PPT2016withComment.pptx",
		"poi__hello-world-signed.pptx"
	]
	const strict = [
		"oxsdk__anchorModified.pptx",
		"docx4j__strict.pptx",
		"oxsdk__main_buautonum_type_ea1jpnkorperiod.pptx",
		"lo__tdf119087.pptx"
	]

	it.each(signed)("opens the signed corpus deck %s view-only as signed", async name => {
		const bytes = corpusFile(`pptx/${name}`)

		if (bytes === undefined) return

		const { deck } = opened(await openPptx(bytesSource(bytes)))

		expect(deck.gate).toContain("signed")
	})

	it.each(strict)("opens the Strict corpus deck %s view-only as strict, with its slides read", async name => {
		const bytes = corpusFile(`pptx/${name}`)

		if (bytes === undefined) return

		const { deck, parts } = opened(await openPptx(bytesSource(bytes)))

		expect(deck.gate).toContain("strict")
		expect(deck.slides.length).toBeGreaterThan(0)
		await parts.parseAll()

		const shapes = deck.slides.flatMap(ref => deck.nodes.get(ref)?.shapes ?? [])

		expect(shapes.length).toBeGreaterThan(0)
	})

	it("keeps unsigned, transitional corpus decks editable", async () => {
		const bytes = corpusFile("pptx/govuk__Shaping_the_Qualifications_Landscape.pptx")

		if (bytes === undefined) return

		expect(opened(await openPptx(bytesSource(bytes))).deck.gate).toEqual([])
	})
})

describe("encrypted pptx", () => {
	const encrypted = manifest.files.filter(file => /^(pptx|pptm|potx|potm|ppsx|ppsm)\//u.test(file.path) && file.password !== undefined)

	it("lists the corpus's password-protected decks with their passwords", () => {
		expect(encrypted.map(file => [file.path, file.password])).toEqual([
			["pptx/oxsdk__encrypted_pptx.pptx", "password123"],
			["pptx/tika__testPPT_protected_passtika.pptx", "tika"]
		])
	})

	it.each(encrypted.map(file => [file.path, file.password ?? ""] as const))(
		"opens %s with its password and refuses a wrong one",
		{ timeout: 60_000 },
		async (path, password) => {
			const bytes = corpusFile(path)

			if (bytes === undefined) return

			expect(await openPptx(bytesSource(bytes))).toMatchObject({ kind: "refused", reason: "encrypted" })

			const verdict = await openEncryptedPackage(bytesSource(bytes))

			if (verdict.kind !== "needsPassword") throw new Error(`expected a prompt, got ${verdict.kind}`)

			const wrong = await verdict.locked.unlock(`${password}!`)

			expect(wrong.ok).toBe(false)
			expect(wrong.ok ? undefined : encryptionRefusal(wrong.reason)).toBe("wrongPassword")

			const right = await verdict.locked.unlock(password)

			if (!right.ok) throw new Error(right.reason)

			const { deck, parts } = opened(
				await openPptx(bytesSource(right.document.bytes), { encrypted: { scheme: right.document.scheme } })
			)

			right.document.release()
			expect(deck.protection.encrypted).toEqual({ scheme: verdict.locked.scheme })
			expect(deck.slides.length).toBeGreaterThan(0)
			await parts.parseAll()

			// LibreOffice 7.5 over UNO (lo_slides.py --password): the slide count, size (1/100 mm) and the layout name
			// its master page carries.
			const oracle: Readonly<Record<string, { slides: number; size: readonly [number, number]; layout: string }>> = {
				"pptx/oxsdk__encrypted_pptx.pptx": { slides: 1, size: [33867, 19050], layout: "Title Slide" },
				"pptx/tika__testPPT_protected_passtika.pptx": { slides: 1, size: [25400, 19050], layout: "Title Slide" }
			}
			const expected = oracle[path]

			expect(deck.slides).toHaveLength(expected?.slides ?? -1)
			expect([Math.round(deck.size.cx / 360), Math.round(deck.size.cy / 360)]).toEqual(expected?.size)

			const first = deck.nodes.get(deck.slides[0] ?? never())
			const layout = first?.parent === undefined ? undefined : deck.nodes.get(first.parent)

			expect(layout?.name).toBe(expected?.layout)
		}
	)
})

describe("pptx budgets", () => {
	const deckOf = (shapes: number, depth = 0): Uint8Array => {
		let inner = ""

		for (let index = 0; index < shapes; index++) inner += sp(10 + index, `S${index}`, undefined, xfrm(0, 0, 10, 10))
		for (let level = 0; level < depth; level++) {
			inner = `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="${1000 + level}" name="G"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${inner}</p:grpSp>`
		}

		return buildPptx({ slides: [{ shapes: inner }] })
	}

	async function refusal(bytes: Uint8Array, budgets: Partial<PresentationBudgets>): Promise<unknown> {
		const open = await openPptx(bytesSource(bytes), { budgets: { ...DEFAULT_PRESENTATION_BUDGETS, ...budgets } })

		if (open.kind === "refused") return open

		try {
			await open.parts.parseAll()
		} catch (error) {
			return error
		}

		return "opened"
	}

	it("refuses more shapes on a slide than the budget", async () => {
		// The fixture master has six shapes, so the budget holds a slide of seven and refuses one of eight.
		expect(await refusal(deckOf(8), { shapesPerSlide: 7 })).toMatchObject({ reason: "tooLarge" })
		expect(await refusal(deckOf(7), { shapesPerSlide: 7 })).toBe("opened")
	})

	it("refuses groups nested deeper than the budget", async () => {
		expect(await refusal(deckOf(1, 4), { groupDepth: 3 })).toMatchObject({ reason: "tooDeep" })
		expect(await refusal(deckOf(1, 3), { groupDepth: 3 })).toBe("opened")
	})

	it("refuses element nesting deeper than the budget", async () => {
		expect(await refusal(deckOf(1, 3), { elementDepth: 8 })).toMatchObject({ reason: "tooDeep" })
	})

	it("refuses more slides, layouts or masters than the budget", async () => {
		const three = buildPptx({ slides: [{ shapes: "" }, { shapes: "" }, { shapes: "" }] })

		expect(await refusal(three, { slides: 2 })).toMatchObject({ reason: "tooLarge" })
		expect(await refusal(three, { layouts: 1 })).toMatchObject({ reason: "tooLarge" })
		expect(await refusal(three, { masters: 0 })).toMatchObject({ reason: "tooLarge" })
	})

	it("refuses runs in a body, characters in a deck and table cells past their budgets", async () => {
		const text = buildPptx({ slides: [{ shapes: sp(2, "T", undefined, "", body(para("a") + para("bb") + para("ccc"))) }] })

		expect(await refusal(text, { runsPerBody: 2 })).toMatchObject({ reason: "tooLarge" })
		expect(await refusal(text, { charactersPerDeck: 5 })).toMatchObject({ reason: "tooLarge" })

		const cells = Array.from({ length: 3 }, () => "<a:tc><a:txBody><a:bodyPr/><a:p/></a:txBody><a:tcPr/></a:tc>").join("")
		const table = buildPptx({
			slides: [
				{
					shapes:
						'<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="5" name="Table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>' +
						'<p:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">' +
						`<a:tbl><a:tblPr/><a:tblGrid><a:gridCol w="10"/><a:gridCol w="10"/><a:gridCol w="10"/></a:tblGrid><a:tr h="10">${cells}</a:tr></a:tbl>` +
						"</a:graphicData></a:graphic></p:graphicFrame>"
				}
			]
		})

		expect(await refusal(table, { cellsPerTable: 2 })).toMatchObject({ reason: "tooLarge" })
		expect(await refusal(table, { cellsPerDeck: 2 })).toMatchObject({ reason: "tooLarge" })
		expect(await refusal(table, { gridColumns: 2 })).toMatchObject({ reason: "tooLarge" })
		expect(await refusal(table, {})).toBe("opened")
	})

	it("refuses an XML part over the part budget before reading it", async () => {
		const bytes = buildPptx({ slides: [{ shapes: sp(2, "x".repeat(2000), undefined) }] })

		expect(await refusal(bytes, { xmlPartBytes: 1500 })).toMatchObject({ reason: "tooLarge" })
	})

	it("refuses more zip entries than the budget from the central directory", async () => {
		expect(await refusal(buildPptx({ slides: [] }), { zipEntries: 3 })).toMatchObject({ reason: "tooLarge" })
	})

	it("refuses more sections, custom shows or comment authors than the budget", async () => {
		const P14 = 'xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main"'
		const lists = buildPptx({
			slides: [{ shapes: "" }],
			presentation:
				'<p:custShowLst><p:custShow name="A" id="0"><p:sldLst/></p:custShow><p:custShow name="B" id="1"><p:sldLst/></p:custShow></p:custShowLst>' +
				`<p:extLst><p:ext uri="{521415D9-36F7-43E2-AB2F-B90AF26B5E84}"><p14:sectionLst ${P14}><p14:section name="A" id="{1}"/><p14:section name="B" id="{2}"/></p14:sectionLst></p:ext></p:extLst>`,
			presentationRels: [["rId71", "commentAuthors", "commentAuthors.xml"]],
			parts: {
				"ppt/commentAuthors.xml": {
					data: '<p:cmAuthorLst xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cmAuthor id="1" name="A"/><p:cmAuthor id="2" name="B"/></p:cmAuthorLst>'
				}
			}
		})

		expect(await refusal(lists, { sections: 1 })).toMatchObject({ reason: "tooLarge" })
		expect(await refusal(lists, { customShows: 1 })).toMatchObject({ reason: "tooLarge" })
		expect(await refusal(lists, { authors: 1 })).toMatchObject({ reason: "tooLarge" })
		expect(await refusal(lists, { sections: 2, customShows: 2, authors: 2 })).toBe("opened")
	})
})

function never(): never {
	throw new Error("unexpected undefined")
}

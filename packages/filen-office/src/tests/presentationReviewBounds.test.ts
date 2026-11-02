import { describe, expect, it } from "vitest"
import { readLegacyComments } from "../core/pptx/read/comments"
import { MAX_COMMENTS_PER_SLIDE, slideComments } from "../core/presentation/comments"
import { PresentationError, type SlideRef } from "../core/presentation/model"
import { encodeUtf8, parseXml } from "../core/xml/index"
import { review } from "../dom/presentation/engine/review"
import { odpBytes, page } from "./odpFixtures"
import { driveSession } from "./odpWriteDrive"
import { buildPptx } from "./pptxFixtures"
import { editDeckOptions } from "./presentationEditFixtures"
import { cpuMs } from "./timing"

// The review reader under hostile comments: amplified and over-long text, deep nesting, a comment part related many
// times from one slide, many authors; and the notes pane's review, which reads no comments.

const P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
const P188_NS =
	'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p188="http://schemas.microsoft.com/office/powerpoint/2018/8/main"'
const LEGACY_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.comments+xml"
const AUTHORS_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.commentAuthors+xml"
const MODERN_REL = "http://schemas.microsoft.com/office/2018/10/relationships/comments"

function annotation(paragraph: string): string {
	return `<officeooo:annotation xmlns:dc="http://purl.org/dc/elements/1.1/" svg:x="1cm" svg:y="1cm"><dc:creator>X</dc:creator><text:p>${paragraph}</text:p></officeooo:annotation>`
}

async function odpReview(paragraph: string) {
	const s = await driveSession(odpBytes({ body: page(annotation(paragraph)) }), "odp")

	return { s, slide: s.session.deck.slides[0] as SlideRef }
}

async function refusal(run: () => Promise<unknown>): Promise<string | undefined> {
	try {
		await run()
	} catch (error) {
		if (error instanceof PresentationError) return error.reason

		throw error
	}

	return undefined
}

// A deck whose first slide relates `rels` (id, type, target), with `parts` and a legacy author list.
function deckWith(
	rels: readonly (readonly [string, string, string])[],
	parts: Record<string, { data: string; type: string }>,
	authors?: string
) {
	const base = editDeckOptions()

	return buildPptx({
		...base,
		slides: base.slides.map((slide, index) => (index === 0 ? { ...slide, rels: [...(slide.rels ?? []), ...rels] } : slide)),
		presentationRels: [["rId81", "commentAuthors", "commentAuthors.xml"]],
		parts: {
			...parts,
			"ppt/commentAuthors.xml": {
				type: AUTHORS_TYPE,
				data: `<p:cmAuthorLst ${P}>${authors ?? '<p:cmAuthor id="0" name="A" initials="A" lastIdx="1000" clrIdx="0"/>'}</p:cmAuthorLst>`
			}
		}
	})
}

function legacyComments(count: number, authorId = 0): string {
	let out = ""

	for (let k = 0; k < count; k++)
		out += `<p:cm authorId="${String(authorId)}" idx="${String(k + 1)}"><p:pos x="10" y="20"/><p:text>c${String(k)}</p:text></p:cm>`

	return `<p:cmLst ${P}>${out}</p:cmLst>`
}

describe("the review reader under hostile comments", () => {
	it("expands an ODP annotation's text:s to at most 1000 spaces each", async () => {
		const { s, slide } = await odpReview('<text:s text:c="100000000"/>'.repeat(5))
		const reviewed = await review(s.context, slide)

		expect(reviewed.comments[0]?.text.length).toBe(5000)
	})

	it("refuses an ODP annotation longer than a comment may be as too large", async () => {
		const { s, slide } = await odpReview('<text:s text:c="1000"/>'.repeat(1001))

		expect(await refusal(() => review(s.context, slide))).toBe("tooLarge")
	})

	it("refuses spans in an ODP annotation nested past the text reader's depth as too deep", async () => {
		const depth = 1000
		const { s, slide } = await odpReview(`${"<text:span>".repeat(depth)}x${"</text:span>".repeat(depth)}`)

		expect(await refusal(() => review(s.context, slide))).toBe("tooDeep")
	})

	it("refuses one page's annotations past the slide's comment characters as too large", async () => {
		const one = annotation('<text:s text:c="1000"/>'.repeat(999))
		const s = await driveSession(odpBytes({ body: page(one.repeat(5)) }), "odp")

		expect(await refusal(() => review(s.context, s.session.deck.slides[0] as SlideRef))).toBe("tooLarge")
	})

	it("refuses a deck's comments past the deck's comment characters as too large, page by page", async () => {
		const one = annotation('<text:s text:c="1000"/>'.repeat(999))
		const s = await driveSession(odpBytes({ body: page(one.repeat(4)).repeat(5) }), "odp")
		const slides = s.session.deck.slides as readonly SlideRef[]

		for (const slide of slides.slice(0, 4)) expect((await review(s.context, slide)).comments).toHaveLength(4)
		expect(await refusal(() => review(s.context, slides[4] as SlideRef))).toBe("tooLarge")
	})

	it("gives a deleted slide's comment characters back to the deck, takes them again on undo and counts a duplicate's", async () => {
		const one = annotation('<text:s text:c="1000"/>'.repeat(999))
		const s = await driveSession(odpBytes({ body: page(one.repeat(4)).repeat(5) }), "odp")
		const [first, second, , , fifth] = [...s.session.deck.slides] as SlideRef[]
		const add = (slide: SlideRef) =>
			s.command({
				family: "comment",
				kind: "add",
				slide,
				comment: { id: "odf:new", author: "", text: "short", created: "2026-10-28T08:00:00.000Z" },
				authorName: "Eve"
			})
		const refusalOf = async (run: () => Promise<{ readonly ok: boolean; readonly refused?: unknown }>) => {
			const result = await run()

			return result.ok ? undefined : result
		}

		for (const slide of s.session.deck.slides.slice(0, 4)) await review(s.context, slide)

		let message: string | undefined

		try {
			await review(s.context, fifth as SlideRef)
		} catch (error) {
			if (!(error instanceof PresentationError)) throw error
			expect(error.reason).toBe("tooLarge")
			message = error.message
		}

		expect(message).toContain("16000000")
		expect((await s.command({ family: "slide", kind: "delete", slides: [first as SlideRef] })).ok).toBe(true)
		expect((await review(s.context, fifth as SlideRef)).comments).toHaveLength(4)
		expect((await add(second as SlideRef)).ok).toBe(true)
		await s.undo()
		await s.undo()
		expect(await refusalOf(() => add(second as SlideRef))).toBeDefined()
		await s.redo()
		expect((await add(second as SlideRef)).ok).toBe(true)
		await s.undo()
		expect(await refusalOf(() => s.command({ family: "slide", kind: "duplicate", slide: second as SlideRef }))).toBeDefined()
	})

	it("counts a duplicate's comments against the deck, reading the source's first, and refuses a copy past it", async () => {
		const one = annotation('<text:s text:c="1000"/>'.repeat(999))
		const s = await driveSession(
			odpBytes({ body: [one.repeat(4), one.repeat(4), one.repeat(4), one.repeat(4), ""].map(each => page(each)).join("") }),
			"odp"
		)
		const [first, , , fourth] = [...s.session.deck.slides] as SlideRef[]

		for (const slide of s.session.deck.slides.slice(0, 3)) await review(s.context, slide)

		const duplicated = await s.command({ family: "slide", kind: "duplicate", slide: fourth as SlideRef })

		expect(duplicated.ok).toBe(false)
		expect((await s.command({ family: "slide", kind: "delete", slides: [first as SlideRef] })).ok).toBe(true)
		expect((await s.command({ family: "slide", kind: "duplicate", slide: fourth as SlideRef })).ok).toBe(true)

		const copy = s.session.deck.slides[s.session.deck.slides.indexOf(fourth as SlideRef) + 1] as SlideRef

		expect((await review(s.context, copy)).comments).toHaveLength(4)
		await s.undo()
		expect((await s.command({ family: "slide", kind: "duplicate", slide: fourth as SlideRef })).ok).toBe(true)
	})

	it("counts the deck's unread comments when a slide is duplicated, refusing a copy past the deck's bound (ODP)", async () => {
		const full = annotation('<text:s text:c="1000"/>'.repeat(999)).repeat(4)
		const s = await driveSession(odpBytes({ body: [full, full, full, full, ""].map(each => page(each)).join("") }), "odp")
		const slides = [...s.session.deck.slides] as SlideRef[]

		expect((await s.command({ family: "slide", kind: "duplicate", slide: slides[1] as SlideRef })).ok).toBe(false)
		expect((await s.command({ family: "slide", kind: "duplicate", slide: slides[4] as SlideRef })).ok).toBe(true)
		expect(slideComments(s.session.deck, slides[1] as SlideRef)).toBeUndefined()
	})

	it("counts the deck's unread comments when a slide is duplicated, refusing a copy past the deck's bound (pptx)", async () => {
		const cm = (k: number) => `<p:cm authorId="0" idx="${String(k)}"><p:text>${"x".repeat(990_000)}</p:text></p:cm>`
		const commented = { shapes: "", rels: [["rIdC", "comments", "../comments/comment1.xml"] as const] }
		const bytes = buildPptx({
			slides: [commented, commented, commented, commented, { shapes: "" }],
			presentationRels: [["rId81", "commentAuthors", "commentAuthors.xml"]],
			parts: {
				"ppt/comments/comment1.xml": { type: LEGACY_TYPE, data: `<p:cmLst ${P}>${[1, 2, 3, 4].map(cm).join("")}</p:cmLst>` },
				"ppt/commentAuthors.xml": {
					type: AUTHORS_TYPE,
					data: `<p:cmAuthorLst ${P}><p:cmAuthor id="0" name="A" initials="A" lastIdx="4" clrIdx="0"/></p:cmAuthorLst>`
				}
			}
		})
		const s = await driveSession(bytes, "pptx")
		const slides = [...s.session.deck.slides] as SlideRef[]

		expect((await s.command({ family: "slide", kind: "duplicate", slide: slides[1] as SlideRef })).ok).toBe(false)
		expect((await s.command({ family: "slide", kind: "duplicate", slide: slides[4] as SlideRef })).ok).toBe(true)
		expect(slideComments(s.session.deck, slides[1] as SlideRef)).toBeUndefined()
	})

	for (const [kind, hostile] of [
		["oversized", annotation('<text:s text:c="1000"/>'.repeat(1001))],
		["deep", annotation(`${"<text:span>".repeat(1000)}x${"</text:span>".repeat(1000)}`)]
	] as const) {
		it(`duplicates any other slide of a deck where one page's comments refuse to read (ODP, ${kind}), never that page`, async () => {
			const s = await driveSession(odpBytes({ body: [page(""), page(hostile), page("")].join("") }), "odp")
			const [plain, bad] = [...s.session.deck.slides] as SlideRef[]

			expect((await s.command({ family: "slide", kind: "duplicate", slide: plain as SlideRef })).ok).toBe(true)
			expect((await s.command({ family: "slide", kind: "duplicate", slide: bad as SlideRef })).ok).toBe(false)
			expect((await s.command({ family: "slide", kind: "duplicate", slide: plain as SlideRef })).ok).toBe(true)
			expect(await refusal(() => review(s.context, bad as SlideRef))).toBe(kind === "deep" ? "tooDeep" : "tooLarge")
		})
	}

	for (const [kind, text] of [
		["oversized", "x".repeat(1_000_001)],
		["deep", `${"<a:b>".repeat(100_000)}${"</a:b>".repeat(100_000)}`],
		["malformed", "<a:b>"]
	] as const) {
		it(`duplicates any other slide of a deck where one slide's comments refuse to read (pptx, ${kind}), never that slide`, async () => {
			const bytes = buildPptx({
				slides: [{ shapes: "" }, { shapes: "", rels: [["rIdC", "comments", "../comments/comment1.xml"] as const] }, { shapes: "" }],
				presentationRels: [["rId81", "commentAuthors", "commentAuthors.xml"]],
				parts: {
					"ppt/comments/comment1.xml": {
						type: LEGACY_TYPE,
						data: `<p:cmLst ${P} xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cm authorId="0" idx="1"><p:text>${text}</p:text></p:cm></p:cmLst>`
					},
					"ppt/commentAuthors.xml": {
						type: AUTHORS_TYPE,
						data: `<p:cmAuthorLst ${P}><p:cmAuthor id="0" name="A" initials="A" lastIdx="1" clrIdx="0"/></p:cmAuthorLst>`
					}
				}
			})
			const s = await driveSession(bytes, "pptx")
			const [plain, bad] = [...s.session.deck.slides] as SlideRef[]
			let reviewed: unknown

			try {
				await review(s.context, bad as SlideRef)
			} catch (error) {
				reviewed = error
			}

			expect((await s.command({ family: "slide", kind: "duplicate", slide: plain as SlideRef })).ok).toBe(true)
			expect((await s.command({ family: "slide", kind: "duplicate", slide: bad as SlideRef })).ok).toBe(reviewed === undefined)
			expect((await s.command({ family: "slide", kind: "duplicate", slide: plain as SlideRef })).ok).toBe(true)
		})
	}

	it("refuses a slide's legacy comments past the slide's comment characters as too large", async () => {
		const cm = (k: number) => `<p:cm authorId="0" idx="${String(k)}"><p:text>${"x".repeat(900_000)}</p:text></p:cm>`
		const bytes = deckWith([["rIdC", "comments", "../comments/comment1.xml"]], {
			"ppt/comments/comment1.xml": { type: LEGACY_TYPE, data: `<p:cmLst ${P}>${[1, 2, 3, 4, 5].map(cm).join("")}</p:cmLst>` }
		})
		const s = await driveSession(bytes, "pptx")

		expect(await refusal(() => review(s.context, s.session.deck.slides[0] as SlideRef))).toBe("tooLarge")
	})

	it("refuses an added or edited comment that takes the slide past its comment characters as too large", async () => {
		const s = await driveSession(
			deckWith([["rIdC", "comments", "../comments/comment1.xml"]], {
				"ppt/comments/comment1.xml": { type: LEGACY_TYPE, data: legacyComments(1) }
			}),
			"pptx"
		)
		const slide = s.session.deck.slides[0] as SlideRef
		const add = (k: number) =>
			s.command({
				family: "comment",
				kind: "add",
				slide,
				comment: { id: `legacy:0:${String(k + 10)}`, author: "0", text: "x".repeat(990_000), created: "2026-10-28T08:00:00.000Z" }
			})

		await review(s.context, slide)

		for (const k of [0, 1, 2, 3]) expect((await add(k)).ok).toBe(true)
		expect((await add(4)).ok).toBe(false)
		expect((await s.command({ family: "comment", kind: "edit", slide, id: "legacy:0:1", text: "y".repeat(900_000) })).ok).toBe(false)
	})

	it("refuses a legacy comment longer than a comment may be as too large", async () => {
		const bytes = deckWith([["rIdC", "comments", "../comments/comment1.xml"]], {
			"ppt/comments/comment1.xml": {
				type: LEGACY_TYPE,
				data: `<p:cmLst ${P}><p:cm authorId="0" idx="1"><p:text>${"x".repeat(1_000_001)}</p:text></p:cm></p:cmLst>`
			}
		})
		const s = await driveSession(bytes, "pptx")

		expect(await refusal(() => review(s.context, s.session.deck.slides[0] as SlideRef))).toBe("tooLarge")
	})

	it("refuses a modern comment body longer than a comment may be as too large", async () => {
		const runs = `<a:p><a:r><a:t>${"x".repeat(600_000)}</a:t></a:r></a:p>`.repeat(2)
		const bytes = deckWith([["rIdC", MODERN_REL, "../comments/modernComment_1.xml"]], {
			"ppt/comments/modernComment_1.xml": {
				type: "application/vnd.ms-powerpoint.comments+xml",
				data: `<p188:cmLst ${P188_NS}><p188:cm id="{AAAAAAAA-0000-4000-8000-000000000001}" authorId="{1}"><p188:txBody><a:bodyPr/>${runs}</p188:txBody></p188:cm></p188:cmLst>`
			}
		})
		const s = await driveSession(bytes, "pptx")

		expect(await refusal(() => review(s.context, s.session.deck.slides[0] as SlideRef))).toBe("tooLarge")
	})

	it("reads a comment part once however many times one slide relates it", async () => {
		const rels = Array.from({ length: 400 }, (_, k) => [`rIdC${String(k)}`, "comments", "../comments/comment1.xml"] as const)
		const s = await driveSession(
			deckWith(rels, { "ppt/comments/comment1.xml": { type: LEGACY_TYPE, data: legacyComments(1000) } }),
			"pptx"
		)
		const start = cpuMs()
		const reviewed = await review(s.context, s.session.deck.slides[0] as SlideRef)

		expect(reviewed.comments).toHaveLength(1000)
		expect(cpuMs() - start).toBeLessThan(500)
	})

	it("bounds a slide's comments across its parts, refusing before the next part's entries are kept", () => {
		const document = parseXml(encodeUtf8(legacyComments(2)))

		expect(readLegacyComments(document, MAX_COMMENTS_PER_SLIDE - 2).entries).toHaveLength(2)
		expect(() => readLegacyComments(document, MAX_COMMENTS_PER_SLIDE - 1)).toThrow(PresentationError)
	})

	it("resolves the authors of many comments by the last of many authors in linear time", { timeout: 60_000 }, async () => {
		const n = 30_000
		const authors = Array.from(
			{ length: n },
			(_, k) => `<p:cmAuthor id="${String(k)}" name="A${String(k)}" initials="A" lastIdx="${String(n)}" clrIdx="0"/>`
		).join("")
		const bytes = deckWith(
			[["rIdC", "comments", "../comments/comment1.xml"]],
			{ "ppt/comments/comment1.xml": { type: LEGACY_TYPE, data: legacyComments(n, n - 1) } },
			authors
		)
		const s = await driveSession(bytes, "pptx")
		const slide = s.session.deck.slides[0] as SlideRef

		await review(s.context, slide)

		const start = cpuMs()
		const reviewed = await review(s.context, slide)

		expect(cpuMs() - start).toBeLessThan(500)
		expect(reviewed.comments[n - 1]?.author).toBe(`A${String(n - 1)}`)
	})
})

describe("the notes pane's review", () => {
	it("reads and keeps no comments when asked for the notes only, and reads them when the comments are asked for", async () => {
		const s = await driveSession(
			deckWith([["rIdC", "comments", "../comments/comment1.xml"]], {
				"ppt/comments/comment1.xml": { type: LEGACY_TYPE, data: legacyComments(3) }
			}),
			"pptx"
		)
		const slide = s.session.deck.slides[0] as SlideRef
		const notesOnly = await review(s.context, slide, { comments: false })

		expect(notesOnly.comments).toEqual([])
		expect(notesOnly.format).toBe("legacy")
		expect(slideComments(s.session.deck, slide)).toBeUndefined()

		const whole = await review(s.context, slide)

		expect(whole.comments).toHaveLength(3)
		expect(slideComments(s.session.deck, slide)?.entries).toHaveLength(3)
	})

	it("answers the notes text as it is after an edit, and an empty text for a slide without notes", async () => {
		const s = await driveSession(buildPptx(editDeckOptions()), "pptx")
		const slide = s.session.deck.slides[1] as SlideRef
		const lines = (...texts: string[]) => ({
			bodyPr: {},
			paragraphs: texts.map(text => ({ pPr: {}, runs: [{ kind: "r" as const, text, rPr: {} }] }))
		})

		expect((await review(s.context, slide, { comments: false })).notesText).toBe("")
		expect((await s.command({ family: "notes", kind: "setNotes", slide, body: lines("Speak slowly") })).ok).toBe(true)

		const target = (await review(s.context, slide, { comments: false })).notes

		if (target === undefined) throw new Error("no notes body")

		expect((await s.command({ family: "text", kind: "setText", target, body: lines("Then pause", "and smile") })).ok).toBe(true)
		expect((await review(s.context, slide, { comments: false })).notesText).toBe("Then pause\nand smile")
		expect((await review(s.context, slide)).notesText).toBe("Then pause\nand smile")
	})
})

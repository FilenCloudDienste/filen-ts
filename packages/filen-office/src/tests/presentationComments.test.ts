import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { CommentOp } from "../core/presentation/edit/ops"
import type { SlideRef } from "../core/presentation/model"
import { review } from "../dom/presentation/engine/review"
import { CORPUS_DIR } from "./corpusDir"
import { odpBytes, page } from "./odpFixtures"
import { entriesOf } from "./odpWriteFixtures"
import { driveSession } from "./odpWriteDrive"
import { buildPptx, type FixtureOptions } from "./pptxFixtures"
import { danglingReferences, partsOf, text } from "./pptxWriteFixtures"
import { editDeckOptions } from "./presentationEditFixtures"

// Comments: modern (MS-PPTX §2.16) when the file has modern comments or none, legacy (ECMA-376 §19.4) in a
// legacy-only file, LibreOffice's officeooo:annotation on ODF pages; read, added, replied to, resolved (modern only),
// edited and deleted; written back in place, so untouched comments keep their bytes and an undo after a save gives
// the file back as it was.

const P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
const P188_NS =
	'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p188="http://schemas.microsoft.com/office/powerpoint/2018/8/main"'
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
const AUTHOR_A = "{11111111-1111-4111-8111-111111111111}"
const AUTHOR_NEW = "{22222222-2222-4222-8222-222222222222}"
const ROOT = "{33333333-3333-4333-8333-333333333333}"
const REPLY = "{44444444-4444-4444-8444-444444444444}"
const SECOND = "{55555555-5555-4555-8555-555555555555}"

function guid(n: number): string {
	const hex = n.toString(16).padStart(12, "0")

	return `{AAAAAAAA-0000-4000-8000-${hex}}`
}

function legacyOptions(): FixtureOptions {
	const base = editDeckOptions()
	const slides = base.slides.map((slide, index) =>
		index === 0 ? { ...slide, rels: [...(slide.rels ?? []), ["rId80", "comments", "../comments/comment1.xml"] as const] } : slide
	)

	return {
		...base,
		slides,
		presentationRels: [["rId81", "commentAuthors", "commentAuthors.xml"]],
		parts: {
			"ppt/comments/comment1.xml": {
				type: "application/vnd.openxmlformats-officedocument.presentationml.comments+xml",
				data:
					`${XML}<p:cmLst ${P}><p:cm authorId="0" dt="2020-01-01T10:00:00.000" idx="1"><p:pos x="10" y="20"/><p:text>First</p:text></p:cm>` +
					'<p:cm authorId="1" dt="2020-01-02T10:00:00.000" idx="1"><p:pos x="10" y="20"/><p:text>Answer</p:text><p:extLst><p:ext uri="{C676402C-5697-4E1C-873F-D02D1690AC5C}"><p15:threadingInfo xmlns:p15="http://schemas.microsoft.com/office/powerpoint/2012/main" timeZoneBias="0"><p15:parentCm authorId="0" idx="1"/></p15:threadingInfo></p:ext></p:extLst></p:cm></p:cmLst>'
			},
			"ppt/commentAuthors.xml": {
				type: "application/vnd.openxmlformats-officedocument.presentationml.commentAuthors+xml",
				data: `${XML}<p:cmAuthorLst ${P}><p:cmAuthor id="0" name="Ann Lee" initials="AL" lastIdx="1" clrIdx="0"/><p:cmAuthor id="1" name="Bo Ek" initials="BE" lastIdx="1" clrIdx="1"/></p:cmAuthorLst>`
			}
		}
	}
}

function modernComment(id: string, text: string, extra = "", attributes = ""): string {
	return `<p188:cm id="${id}" authorId="${AUTHOR_A}" created="2024-03-01T09:00:00.000"${attributes}><pc:sldMkLst xmlns:pc="http://schemas.microsoft.com/office/powerpoint/2013/main/command"><pc:docMk/><pc:sldMk cId="1" sldId="256"/></pc:sldMkLst><p188:pos x="100" y="200"/>${extra}<p188:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>${text}</a:t></a:r></a:p></p188:txBody></p188:cm>`
}

function modernOptions(comments: string): FixtureOptions {
	const base = editDeckOptions()
	const slides = base.slides.map((slide, index) =>
		index === 0
			? {
					...slide,
					rels: [
						...(slide.rels ?? []),
						[
							"rId80",
							"http://schemas.microsoft.com/office/2018/10/relationships/comments",
							"../comments/modernComment_100_1.xml"
						] as const
					]
				}
			: slide
	)

	return {
		...base,
		slides,
		presentationRels: [["rId81", "http://schemas.microsoft.com/office/2018/10/relationships/authors", "authors.xml"]],
		parts: {
			"ppt/comments/modernComment_100_1.xml": {
				type: "application/vnd.ms-powerpoint.comments+xml",
				data: `${XML}<p188:cmLst ${P188_NS}>${comments}</p188:cmLst>`
			},
			"ppt/authors.xml": {
				type: "application/vnd.ms-powerpoint.authors+xml",
				data: `${XML}<p188:authorLst ${P188_NS}><p188:author id="${AUTHOR_A}" name="Ann Lee" initials="AL" userId="Ann Lee" providerId="None"/></p188:authorLst>`
			}
		}
	}
}

function threadWithReply(): string {
	return modernComment(
		ROOT,
		"Root",
		`<p188:replyLst><p188:reply id="${REPLY}" authorId="${AUTHOR_A}" created="2024-03-02T09:00:00.000"><p188:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>Reply</a:t></a:r></a:p></p188:txBody></p188:reply></p188:replyLst>`,
		' status="resolved"'
	)
}

function add(slide: SlideRef, id: string, text: string, authorName = "Cy Doe"): CommentOp {
	return {
		family: "comment",
		kind: "add",
		slide,
		comment: { id, author: AUTHOR_NEW, text, created: "2026-10-28T08:00:00.000Z", anchor: { x: 12_700, y: 25_400 } },
		authorName
	}
}

async function partsAfter(bytes: Uint8Array | undefined): Promise<Map<string, Uint8Array>> {
	if (bytes === undefined) throw new Error("not written")

	return partsOf(bytes)
}

async function sameParts(a: Uint8Array, b: Uint8Array | undefined): Promise<void> {
	const before = await partsOf(a)
	const after = await partsAfter(b)

	expect([...after.keys()].sort()).toEqual([...before.keys()].sort())

	for (const [name, data] of before) expect(text(after.get(name)), name).toBe(text(data))
}

describe("presentation comments", () => {
	it("reads a slide's legacy comments with their authors, dates and threads; legacy threads do not resolve", async () => {
		const s = await driveSession(buildPptx(legacyOptions()), "pptx")
		const slide = s.session.deck.slides[0] as SlideRef
		const reviewed = await review(s.context, slide)

		expect(reviewed.format).toBe("legacy")
		expect(reviewed.can.resolve).toBe(false)
		expect(reviewed.comments.map(comment => [comment.author, comment.text, comment.parent ?? null, comment.created])).toEqual([
			["Ann Lee", "First", null, "2020-01-01T10:00:00.000"],
			["Bo Ek", "Answer", "legacy:0:1", "2020-01-02T10:00:00.000"]
		])
		expect((await s.command({ family: "comment", kind: "resolve", slide, id: "legacy:0:1", resolved: true })).ok).toBe(false)
	})

	it("a legacy-only deck takes a new comment as legacy: the next index, its author's lastIdx and a thread reply", async () => {
		const s = await driveSession(buildPptx(legacyOptions()), "pptx")
		const slide = s.session.deck.slides[0] as SlideRef

		await review(s.context, slide)
		expect((await s.command(add(slide, "", "New one", "Ann Lee"))).ok).toBe(true)
		expect(
			(
				await s.command({
					family: "comment",
					kind: "reply",
					slide,
					parent: "legacy:0:2",
					comment: { id: "", author: "", text: "Thanks", created: "2026-10-28T08:01:00.000Z" },
					authorName: "Bo Ek"
				})
			).ok
		).toBe(true)

		const { bytes } = await s.save()
		const parts = await partsAfter(bytes)
		const comments = text(parts.get("ppt/comments/comment1.xml"))

		expect(
			comments.startsWith(
				text((await partsOf(buildPptx(legacyOptions()))).get("ppt/comments/comment1.xml")).replace("</p:cmLst>", "")
			)
		).toBe(true)
		expect(comments).toContain(
			'<p:cm authorId="0" dt="2026-10-28T08:00:00.000Z" idx="2"><p:pos x="8" y="16"/><p:text>New one</p:text></p:cm>'
		)
		expect(comments).toContain('<p15:parentCm authorId="0" idx="2"/>')
		expect(text(parts.get("ppt/commentAuthors.xml"))).toContain(
			'<p:cmAuthor id="0" name="Ann Lee" initials="AL" lastIdx="2" clrIdx="0"/>'
		)

		const back = await driveSession(bytes ?? new Uint8Array(), "pptx")
		const reread = await review(back.context, back.session.deck.slides[0] as SlideRef)

		expect(reread.comments.map(comment => [comment.author, comment.text, comment.parent ?? null])).toEqual([
			["Ann Lee", "First", null],
			["Bo Ek", "Answer", "legacy:0:1"],
			["Ann Lee", "New one", null],
			["Bo Ek", "Thanks", "legacy:0:2"]
		])
	})

	it("writes a new author with the user's own initials when given", async () => {
		const s = await driveSession(buildPptx(editDeckOptions()), "pptx")
		const slide = s.session.deck.slides[1] as SlideRef

		const op: CommentOp = {
			family: "comment",
			kind: "add",
			slide,
			comment: { id: ROOT, author: AUTHOR_NEW, text: "Hi", created: "2026-10-28T08:00:00.000Z" },
			authorName: "Cy Doe",
			authorInitials: "CYD"
		}

		expect((await s.command(op)).ok).toBe(true)

		const parts = await partsAfter((await s.save()).bytes)

		expect(text(parts.get("ppt/authors.xml"))).toContain('name="Cy Doe" initials="CYD"')
	})

	it("adds a modern comment to a deck with none: its Comment part, the Author part, the slide's commentRel; it reads back equal", async () => {
		const original = buildPptx(editDeckOptions())
		const s = await driveSession(original, "pptx")
		const slide = s.session.deck.slides[1] as SlideRef

		expect((await review(s.context, slide)).format).toBe("modern")
		expect((await s.command(add(slide, ROOT, "Looks good\nShip it"))).ok).toBe(true)

		const { bytes } = await s.save()
		const parts = await partsAfter(bytes)
		const part = [...parts.keys()].find(name => name.startsWith("ppt/comments/"))

		expect(part).toBeDefined()
		expect(text(parts.get(part ?? ""))).toContain(
			`<p188:cm id="${ROOT}" authorId="${AUTHOR_NEW}" created="2026-10-28T08:00:00.000Z"><pc:sldMkLst xmlns:pc="http://schemas.microsoft.com/office/powerpoint/2013/main/command"><pc:docMk/><pc:sldMk sldId="257"/></pc:sldMkLst><p188:pos x="12700" y="25400"/><p188:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Looks good</a:t></a:r></a:p><a:p><a:r><a:t>Ship it</a:t></a:r></a:p></p188:txBody></p188:cm>`
		)
		expect(text(parts.get("ppt/authors.xml"))).toContain(
			`<p188:author id="${AUTHOR_NEW}" name="Cy Doe" initials="CD" userId="Cy Doe" providerId="None"/>`
		)
		expect(text(parts.get("ppt/slides/slide2.xml"))).toMatch(
			/<p:ext uri="\{6950BFC3-D8DA-4A85-94F7-54DA5524770B\}"><p188:commentRel xmlns:p188="[^"]+" r:id="rId\d+"\/><\/p:ext>/u
		)
		expect(text(parts.get("[Content_Types].xml"))).toContain("application/vnd.ms-powerpoint.comments+xml")
		expect(await danglingReferences(bytes ?? new Uint8Array())).toEqual([])

		const back = await driveSession(bytes ?? new Uint8Array(), "pptx")
		const reread = await review(back.context, back.session.deck.slides[1] as SlideRef)

		expect(reread.comments.map(comment => [comment.id, comment.author, comment.text, comment.resolved])).toEqual([
			[ROOT, "Cy Doe", "Looks good\nShip it", false]
		])
	})

	it("replies to, resolves and deletes a modern thread; the last comment's part goes with its relationship", async () => {
		const original = buildPptx(modernOptions(modernComment(ROOT, "Root")))
		const s = await driveSession(original, "pptx")
		const slide = s.session.deck.slides[0] as SlideRef

		await review(s.context, slide)
		await s.command({
			family: "comment",
			kind: "reply",
			slide,
			parent: ROOT,
			comment: { id: REPLY, author: AUTHOR_A, text: "Reply", created: "2026-10-28T08:00:00.000Z" }
		})
		await s.command({ family: "comment", kind: "resolve", slide, id: REPLY, resolved: true })

		const saved = await s.save()
		const back = await driveSession(saved.bytes ?? new Uint8Array(), "pptx")
		const reread = await review(back.context, back.session.deck.slides[0] as SlideRef)

		expect(reread.comments.map(comment => [comment.id, comment.parent ?? null, comment.text, comment.resolved])).toEqual([
			[ROOT, null, "Root", true],
			[REPLY, ROOT, "Reply", false]
		])

		await s.command({ family: "comment", kind: "delete", slide, id: ROOT })

		const parts = await partsAfter((await s.save()).bytes)

		expect([...parts.keys()].some(name => name.startsWith("ppt/comments/"))).toBe(false)
		expect(text(parts.get("ppt/slides/_rels/slide1.xml.rels"))).not.toContain("2018/10/relationships/comments")
	})

	it("an edit rewrites only that comment: its siblings and its own anchor keep their bytes", async () => {
		const first = modernComment(ROOT, "Keep")
		const original = buildPptx(modernOptions(first + modernComment(SECOND, "Change")))
		const s = await driveSession(original, "pptx")
		const slide = s.session.deck.slides[0] as SlideRef

		await review(s.context, slide)
		await s.command({ family: "comment", kind: "edit", slide, id: SECOND, text: "Changed" })

		const parts = await partsAfter((await s.save()).bytes)
		const written = text(parts.get("ppt/comments/modernComment_100_1.xml"))

		expect(written).toContain(first)
		expect(written).toContain(modernComment(SECOND, "Changed").replace('<a:rPr lang="en-US"/>', "").replace("<p188:cm ", "<p188:cm "))
	})

	it("a save without a comment edit keeps a modern thread and its replies byte for byte", async () => {
		const original = buildPptx(modernOptions(threadWithReply()))
		const s = await driveSession(original, "pptx")
		const slide = s.session.deck.slides[0] as SlideRef

		expect((await review(s.context, slide)).comments.map(comment => [comment.text, comment.resolved])).toEqual([
			["Root", true],
			["Reply", false]
		])
		await s.command({
			family: "comment",
			kind: "add",
			slide: s.session.deck.slides[1] as SlideRef,
			comment: { id: SECOND, author: AUTHOR_A, text: "Other slide", created: "2026-10-28T08:00:00.000Z" }
		})

		const parts = await partsAfter((await s.save()).bytes)

		expect(text(parts.get("ppt/comments/modernComment_100_1.xml"))).toBe(
			text((await partsOf(original)).get("ppt/comments/modernComment_100_1.xml"))
		)
	})

	it("an undo after the save that added comments gives a modern deck back byte for byte", async () => {
		const original = buildPptx(editDeckOptions())
		const s = await driveSession(original, "pptx")
		const slide = s.session.deck.slides[0] as SlideRef

		await review(s.context, slide)
		await s.command(add(slide, ROOT, "Temporary"))
		await s.save()
		await s.undo()

		await sameParts(original, (await s.save()).bytes)
	})

	it("an undo after the save that deleted and edited comments puts their bytes back", async () => {
		const original = buildPptx(modernOptions(threadWithReply() + modernComment(SECOND, "Second")))
		const s = await driveSession(original, "pptx")
		const slide = s.session.deck.slides[0] as SlideRef

		await review(s.context, slide)
		await s.command({ family: "comment", kind: "delete", slide, id: REPLY })
		await s.command({ family: "comment", kind: "edit", slide, id: SECOND, text: "Edited" })
		await s.save()
		await s.undo()
		await s.undo()

		await sameParts(original, (await s.save()).bytes)
	})

	it("an undo after the save of a legacy comment gives its comment part back byte for byte", async () => {
		const original = buildPptx(legacyOptions())
		const s = await driveSession(original, "pptx")
		const slide = s.session.deck.slides[0] as SlideRef

		await review(s.context, slide)
		await s.command(add(slide, "", "Temporary", "Ann Lee"))
		await s.save()
		await s.undo()

		const parts = await partsAfter((await s.save()).bytes)

		expect(text(parts.get("ppt/comments/comment1.xml"))).toBe(text((await partsOf(original)).get("ppt/comments/comment1.xml")))
	})

	it("refuses an empty comment, a character XML cannot hold and a comment on a missing thread", async () => {
		const s = await driveSession(buildPptx(editDeckOptions()), "pptx")
		const slide = s.session.deck.slides[0] as SlideRef

		await review(s.context, slide)
		expect(await s.command(add(slide, ROOT, "   "))).toEqual({ ok: false, refusal: "malformed" })
		expect(await s.command(add(slide, ROOT, "bell\u0007"))).toEqual({ ok: false, refusal: "malformed" })
		expect(
			await s.command({
				family: "comment",
				kind: "reply",
				slide,
				parent: SECOND,
				comment: { id: REPLY, author: AUTHOR_A, text: "x", created: "" }
			})
		).toEqual({ ok: false, refusal: "notFound" })
		expect((await s.save()).result.kind).toBe("unchanged")
	})

	it("an ODP page's annotations: read, added and replied to as officeooo:annotation, and given back on an undo after the save", async () => {
		const annotation =
			'<officeooo:annotation xmlns:dc="http://purl.org/dc/elements/1.1/" svg:x="20cm" svg:y="5cm"><dc:creator>Dee Fox</dc:creator><dc:date>2021-05-01T12:00:00</dc:date><text:p>Old note</text:p></officeooo:annotation>'
		const original = odpBytes({
			body: page(
				`<draw:frame presentation:class="title" svg:x="2cm" svg:y="1cm" svg:width="24cm" svg:height="3cm"><draw:text-box><text:p>Hi</text:p></draw:text-box></draw:frame>${annotation}`
			)
		})
		const s = await driveSession(original, "odp")
		const slide = s.session.deck.slides[0] as SlideRef
		const reviewed = await review(s.context, slide)

		expect(reviewed.format).toBe("odf")
		expect(reviewed.comments.map(comment => [comment.author, comment.text, comment.created])).toEqual([
			["Dee Fox", "Old note", "2021-05-01T12:00:00"]
		])

		const old = reviewed.comments[0]?.id ?? ""

		expect(
			(
				await s.command({
					family: "comment",
					kind: "add",
					slide,
					comment: { id: "odf:new", author: "", text: "Two  spaces\ttab", created: "2026-10-28T08:00:00.000Z" },
					authorName: "Eve"
				})
			).ok
		).toBe(true)
		expect(
			(
				await s.command({
					family: "comment",
					kind: "reply",
					slide,
					parent: old,
					comment: { id: "odf:reply", author: "", text: "Agreed", created: "2026-10-28T08:01:00.000Z" },
					authorName: "Eve"
				})
			).ok
		).toBe(true)
		expect((await s.command({ family: "comment", kind: "resolve", slide, id: old, resolved: true })).ok).toBe(false)

		const { bytes } = await s.save()
		const content = text((await entriesOf(bytes ?? new Uint8Array())).get("content.xml"))

		expect(content).toContain(
			`${annotation}<officeooo:annotation xmlns:dc="http://purl.org/dc/elements/1.1/" svg:x="20cm" svg:y="5cm"><dc:creator>Eve</dc:creator><dc:date>2026-10-28T08:01:00.000Z</dc:date><text:p>Agreed</text:p></officeooo:annotation><officeooo:annotation xmlns:dc="http://purl.org/dc/elements/1.1/" svg:x="0cm" svg:y="0cm"><dc:creator>Eve</dc:creator><dc:date>2026-10-28T08:00:00.000Z</dc:date><text:p>Two <text:s text:c="1"/>spaces<text:tab/>tab</text:p></officeooo:annotation></draw:page>`
		)

		const back = await driveSession(bytes ?? new Uint8Array(), "odp")
		const reread = await review(back.context, back.session.deck.slides[0] as SlideRef)

		expect(reread.comments.map(comment => [comment.author, comment.text])).toEqual([
			["Dee Fox", "Old note"],
			["Eve", "Agreed"],
			["Eve", "Two  spaces\ttab"]
		])

		await s.undo()
		await s.undo()

		const undone = await s.save()

		expect(text((await entriesOf(undone.bytes ?? new Uint8Array())).get("content.xml"))).toBe(
			text((await entriesOf(original)).get("content.xml"))
		)
	})

	const TIKA = join(CORPUS_DIR, "pptx", "tika__testComment.pptx")
	const DOCX4J = join(CORPUS_DIR, "pptx", "docx4j__loadAndSave.pptx")

	it.skipIf(!existsSync(TIKA) || !existsSync(DOCX4J))("reads the corpus's legacy and modern comments", async () => {
		const legacy = await driveSession(new Uint8Array(readFileSync(TIKA)), "pptx")
		const modern = await driveSession(new Uint8Array(readFileSync(DOCX4J)), "pptx")
		const all = async (s: Awaited<ReturnType<typeof driveSession>>) =>
			(await Promise.all(s.session.deck.slides.map(ref => review(s.context, ref)))).flatMap(each => each.comments)

		expect((await all(legacy)).map(comment => [comment.author, comment.text])).toEqual([["Michael McCandless", "Here is a comment"]])
		expect((await all(modern)).map(comment => [comment.author, comment.text, comment.editable])).toEqual([
			["Buck Cronk", "Comment", true]
		])
	})

	it("1,000 comments: one added and saved rewrites one part in place", async () => {
		const many = Array.from({ length: 1000 }, (_, index) => modernComment(guid(index), `Comment ${String(index)}`)).join("")
		const original = buildPptx(modernOptions(many))
		const s = await driveSession(original, "pptx")
		const slide = s.session.deck.slides[0] as SlideRef

		expect((await review(s.context, slide)).comments).toHaveLength(1000)
		await s.command(add(slide, guid(5000), "One more", "Ann Lee"))

		const written = text((await partsAfter((await s.save()).bytes)).get("ppt/comments/modernComment_100_1.xml"))

		expect(
			written.startsWith(text((await partsOf(original)).get("ppt/comments/modernComment_100_1.xml")).replace("</p188:cmLst>", ""))
		).toBe(true)
	})
})

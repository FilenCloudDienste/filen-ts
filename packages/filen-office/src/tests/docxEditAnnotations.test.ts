import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { TextSelection } from "prosemirror-state"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { RevisionView, type DocxPackage } from "@filen/office/core/docx"
import type { DocxEditContext } from "@filen/office/core/docx/edit"
import { EditAnnotations, type EditAnnotationData, type PagedEditor } from "@filen/office/core/docx/paged"
import { saveDocx } from "@filen/office/core/docx/write"
import { RECT_FLOATS, type DocxAnnotations } from "@filen/office/dom/docx"
import { collectAnnotations } from "../dom/docx/annotate"
import { CORPUS_DIR } from "./corpusDir"
import { NAMESPACES, buildDocx, p } from "./docxSynthetic"
import { STYLES_PART } from "./docxEditFixtures"
import { layOut } from "./layoutFixtures"
import { pagedEditor, settleAll } from "./pagedFixtures"
import { budget } from "./timing"

interface Opened {
	readonly editor: PagedEditor
	readonly pkg: DocxPackage
	readonly context: DocxEditContext
}

beforeEach(() => {
	vi.stubEnv("TZ", "UTC")
})

async function open(bytes: Uint8Array, author: string | undefined = "Ann Lee"): Promise<Opened> {
	const opened = await pagedEditor(bytes)

	opened.context.identity.author = author
	opened.context.identity.initials = author === undefined ? undefined : "AL"
	opened.context.identity.now = () => Date.UTC(2026, 9, 12, 10, 30, 15)

	return opened
}

function allPages(editor: PagedEditor): number[] {
	return Array.from({ length: editor.pageCount }, (_, page) => page)
}

function select(editor: PagedEditor, from: number, to: number = from): void {
	const session = editor.session

	session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, from, to)))
}

// A comment's or change's boxes as (page, top, height) lines, and the x where its first box starts.
function lines(data: Pick<DocxAnnotations, "rectPages" | "rectFloats">, first: number, count: number): { lines: string[]; x: number } {
	const out = new Set<string>()

	for (let rect = first; rect < first + count; rect++) {
		const f = rect * RECT_FLOATS

		out.add(`${String(data.rectPages[rect])}:${(data.rectFloats[f + 1] ?? 0).toFixed(1)}:${(data.rectFloats[f + 3] ?? 0).toFixed(1)}`)
	}

	return { lines: [...out].sort(), x: count > 0 ? (data.rectFloats[first * RECT_FLOATS] ?? 0) : -1 }
}

// The changed lines of a page set (what change bars mark), from every change's boxes.
function changedLines(data: DocxAnnotations): string[] {
	const out = new Set<string>()

	for (const revision of data.revisions) for (const line of lines(data, revision.firstRect, revision.rectCount).lines) out.add(line)

	return [...out].sort()
}

async function viewerAnnotations(bytes: Uint8Array, view: RevisionView): Promise<DocxAnnotations> {
	const layout = await layOut(bytes, { view })

	return collectAnnotations(layout.loaded.model, layout.pages, view, layout.styles)
}

async function save(opened: Opened): Promise<Uint8Array> {
	const result = await saveDocx({ pkg: opened.pkg, context: opened.context, sessions: opened.editor.sessions })

	return result.bytes as Uint8Array
}

// Every comment's lines and anchor, live and from a fresh layout of the saved file, by comment id.
function expectSameComments(live: EditAnnotationData, viewer: DocxAnnotations): void {
	const byId = new Map(viewer.comments.map(comment => [comment.id, comment]))

	expect(live.comments.map(comment => comment.id).sort()).toEqual(viewer.comments.map(comment => comment.id).sort())

	for (const comment of live.comments) {
		const other = byId.get(comment.id)

		if (other === undefined) continue

		const mine = lines(live, comment.firstRect, comment.rectCount)
		const theirs = lines(viewer, other.firstRect, other.rectCount)

		expect(mine.lines, `comment ${comment.id}`).toEqual(theirs.lines)
		expect(Math.abs(mine.x - theirs.x), `comment ${comment.id} anchor`).toBeLessThan(1.5)
		expect(live.authors[comment.author] ?? "", `comment ${comment.id} author`).toBe(viewer.authors[other.author] ?? "")
		expect(comment.done).toBe(other.done)
	}
}

const ANNOTATED = buildDocx({
	body:
		'<w:p><w:r><w:t xml:space="preserve">Hello </w:t></w:r><w:commentRangeStart w:id="1"/><w:r><w:t>world</w:t></w:r>' +
		'<w:commentRangeEnd w:id="1"/><w:r><w:commentReference w:id="1"/></w:r><w:r><w:t xml:space="preserve"> again</w:t></w:r></w:p>' +
		'<w:p><w:ins w:id="10" w:author="Bob" w:date="2024-01-02T03:04:05Z"><w:r><w:t>Inserted</w:t></w:r></w:ins>' +
		'<w:r><w:t xml:space="preserve"> kept </w:t></w:r>' +
		'<w:del w:id="11" w:author="Cy" w:date="2024-01-03T00:00:00Z"><w:r><w:delText>gone</w:delText></w:r></w:del></w:p>' +
		p("Third paragraph"),
	comments:
		'<w:comment w:id="1" w:author="Bo" w:date="2020-01-01T00:00:00Z" w:initials="B"><w:p><w:r><w:t>First</w:t></w:r></w:p></w:comment>'
})

describe("live annotations (EditAnnotations)", () => {
	it("reads comments and changes with their boxes on the pages asked for", async () => {
		const { editor } = await open(ANNOTATED)

		editor.setView(RevisionView.Markup)
		await settleAll(editor)

		const annotations = new EditAnnotations(editor)
		const data = annotations.read([0])

		expect(data.comments.map(comment => comment.id)).toEqual(["1"])
		expect(data.comments[0]?.rectCount).toBeGreaterThan(0)
		expect(data.comments[0]?.paragraphs).toEqual([[{ text: "First", bold: false, italic: false, underline: false, strike: false }]])
		expect(data.authors[data.comments[0]?.author ?? -1]).toBe("Bo")
		expect(
			data.revisions.map(revision => [revision.kind, revision.target, data.authors[revision.author], revision.text]).sort()
		).toEqual(
			[
				["deletion", "text", "Cy", "gone"],
				["insertion", "text", "Bob", "Inserted"]
			].sort()
		)
		expect(data.revisions.every(revision => revision.rectCount > 0 && revision.id.length > 0)).toBe(true)

		// Nothing is boxed on pages not asked for; the comments are listed all the same.
		const none = annotations.read([])

		expect(none.comments[0]?.rectCount).toBe(0)
		expect(none.revisions).toEqual([])

		const session = editor.body.session
		const change = data.revisions.find(revision => revision.kind === "insertion")
		const inserted = session.state.doc.textContent.indexOf("Inserted")

		expect(change).toBeDefined()
		expect(inserted).toBeGreaterThan(0)

		let found: string | undefined

		session.state.doc.descendants((node, pos) => {
			if (found === undefined && node.isText && node.text?.startsWith("Inserted") === true)
				found = annotations.changeAt(session.story.story.index, pos + 2)?.id

			return found === undefined
		})

		expect(found).toBe(change?.id)
		annotations.dispose()
	})

	it("tells once per burst of edits, with a new version for the pages laid out again", async () => {
		const { editor } = await open(ANNOTATED)

		await settleAll(editor)

		const annotations = new EditAnnotations(editor)
		const heard = vi.fn()
		const before = annotations.pageVersion(0)

		annotations.subscribe(heard)
		select(editor, 3)

		const session = editor.session

		session.dispatch(session.state.tr.insertText("x"))
		session.dispatch(session.state.tr.insertText("y"))
		await Promise.resolve()

		expect(heard).toHaveBeenCalledTimes(1)
		expect(annotations.pageVersion(0)).not.toBe(before)

		await settleAll(editor)

		const heardBefore = heard.mock.calls.length

		annotations.dispose()
		session.dispatch(session.state.tr.insertText("z"))
		await settleAll(editor)
		await Promise.resolve()
		expect(heard).toHaveBeenCalledTimes(heardBefore)
	})

	it("follows a comment added, resolved and deleted", async () => {
		const { editor } = await open(ANNOTATED)

		await settleAll(editor)

		const annotations = new EditAnnotations(editor)
		const doc = editor.session.state.doc
		const at = doc.textContent.indexOf("Third")
		let third = -1

		doc.descendants((node, pos) => {
			if (third < 0 && node.isText && node.text?.includes("Third") === true) third = pos

			return third < 0
		})

		expect(at).toBeGreaterThan(0)
		select(editor, third, third + 5)
		expect(await editor.execute({ type: "comment.add", text: "New one\nSecond line" })).toBe(true)
		await settleAll(editor)

		const added = annotations.read(allPages(editor))
		const comment = added.comments.find(candidate => candidate.id !== "1")

		expect(added.comments).toHaveLength(2)
		expect(comment?.paragraphs.map(runs => runs.map(run => run.text).join(""))).toEqual(["New one", "Second line"])
		expect(added.authors[comment?.author ?? -1]).toBe("Ann Lee")
		expect(comment?.rectCount).toBe(1)
		expect(await editor.execute({ type: "comment.resolve", id: comment?.id ?? "" })).toBe(true)
		expect(annotations.read([0]).comments.find(candidate => candidate.id === comment?.id)?.done).toBe(true)
		expect(await editor.execute({ type: "comment.delete", id: comment?.id ?? "" })).toBe(true)
		expect(annotations.read([0]).comments.map(candidate => candidate.id)).toEqual(["1"])
		annotations.dispose()
	})
})

const MARGINS = '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>'
const NOTE_SEPARATORS =
	'<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>' +
	'<w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>'
// A comment in the header and a tracked insertion in a footnote: stories never entered.
const IN_STORIES = buildDocx({
	body:
		'<w:p><w:r><w:t>Body text</w:t></w:r><w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="1"/></w:r></w:p>' +
		`<w:sectPr><w:headerReference w:type="default" r:id="rIdH"/><w:pgSz w:w="12240" w:h="15840"/>${MARGINS}</w:sectPr>`,
	headers: {
		rIdH:
			'<w:p><w:r><w:t xml:space="preserve">Header </w:t></w:r><w:commentRangeStart w:id="5"/><w:r><w:t>noted</w:t></w:r>' +
			'<w:commentRangeEnd w:id="5"/><w:r><w:commentReference w:id="5"/></w:r></w:p>'
	},
	footnotes:
		NOTE_SEPARATORS +
		'<w:footnote w:id="1"><w:p><w:r><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> note </w:t></w:r>' +
		'<w:ins w:id="20" w:author="Dee" w:date="2024-01-02T00:00:00Z"><w:r><w:t>added</w:t></w:r></w:ins></w:p></w:footnote>',
	comments: '<w:comment w:id="5" w:author="Bo" w:date="2020-01-01T00:00:00Z"><w:p><w:r><w:t>In the header</w:t></w:r></w:p></w:comment>'
})

describe("live annotations in headers, footers and notes", () => {
	it("boxes comments and changes of stories not being edited, on the pages read", async () => {
		const { editor } = await open(IN_STORIES)

		editor.setView(RevisionView.Markup)
		await settleAll(editor)

		const sessions = editor.sessions.length
		const annotations = new EditAnnotations(editor)
		const data = annotations.read([0])
		const comment = data.comments.find(candidate => candidate.id === "5")
		const change = data.revisions.find(revision => revision.text === "added")

		expect(editor.session).toBe(editor.body.session)
		expect(comment?.rectCount).toBeGreaterThan(0)
		expect(data.rectPages[comment?.firstRect ?? -1]).toBe(0)
		expect(change?.rectCount).toBeGreaterThan(0)
		expect(data.authors[change?.author ?? -1]).toBe("Dee")
		// The header's and the note's sessions were made for it; stories without comments or changes get none.
		expect(editor.sessions.length).toBe(sessions + 2)
		// The note's change is found where its text is.
		const note = editor.storySession(change?.story ?? -1)
		let added = -1

		note?.state.doc.descendants((node, pos) => {
			if (added < 0 && node.isText && node.text === "added") added = pos + 1

			return added < 0
		})
		expect(annotations.changeAt(change?.story ?? -1, added)?.id).toBe(change?.id)

		// Nothing more is made on the next read.
		annotations.read([0])
		expect(editor.sessions.length).toBe(sessions + 2)
		annotations.dispose()
	})
})

// Tracked formatting from the file: a run made bold and red (w:rPrChange), a paragraph indented and centred
// (w:pPrChange).
const FORMATTED = buildDocx({
	body:
		'<w:p><w:r><w:t xml:space="preserve">Plain </w:t></w:r><w:r><w:rPr><w:b/><w:color w:val="FF0000"/>' +
		'<w:rPrChange w:id="30" w:author="Eve" w:date="2024-01-01T00:00:00Z"><w:rPr/></w:rPrChange></w:rPr><w:t>changed</w:t></w:r></w:p>' +
		'<w:p><w:pPr><w:jc w:val="center"/><w:ind w:left="567"/><w:pPrChange w:id="31" w:author="Eve" w:date="2024-01-01T00:00:00Z"><w:pPr/></w:pPrChange></w:pPr>' +
		"<w:r><w:t>Indented</w:t></w:r></w:p>" +
		p("Third")
})

describe("what a formatting change changed", () => {
	it("lists a change read from the file, as Word does", async () => {
		const { editor } = await open(FORMATTED)

		editor.setView(RevisionView.Markup)
		await settleAll(editor)

		const data = new EditAnnotations(editor).read([0])
		const text = data.revisions.find(revision => revision.kind === "formatting" && revision.target === "text")
		const paragraph = data.revisions.find(revision => revision.kind === "formatting" && revision.target === "paragraph")

		expect(text?.format).toEqual([
			{ kind: "toggle", property: "bold", on: true },
			{ kind: "color", color: { kind: "rgb", rgb: "FF0000" } }
		])
		expect(paragraph?.format).toEqual([
			{ kind: "align", value: "center" },
			{ kind: "indent", side: "left", twips: 567 }
		])
	})

	it("lists a change the editor recorded while tracking", async () => {
		const { editor, context } = await open(ANNOTATED)

		context.review.tracking = true
		await settleAll(editor)

		let third = -1

		editor.session.state.doc.descendants((node, pos) => {
			if (third < 0 && node.isText && node.text?.includes("Third") === true) third = pos

			return third < 0
		})
		select(editor, third, third + 5)
		expect(await editor.execute({ type: "format.italic" })).toBe(true)
		expect(await editor.execute({ type: "font.size", halfPoints: 28 })).toBe(true)
		expect(await editor.execute({ type: "color.text", color: { kind: "theme", theme: "accent1" } })).toBe(true)
		expect(await editor.execute({ type: "paragraph.indent", start: 720, firstLine: 360 })).toBe(true)
		expect(await editor.execute({ type: "align.end" })).toBe(true)
		await settleAll(editor)

		const data = new EditAnnotations(editor).read([0])
		const text = data.revisions.find(revision => revision.kind === "formatting" && revision.target === "text")
		const paragraph = data.revisions.find(revision => revision.kind === "formatting" && revision.target === "paragraph")

		expect(text?.format).toEqual([
			{ kind: "size", script: "default", points: 14 },
			{ kind: "toggle", property: "italic", on: true },
			{ kind: "color", color: { kind: "theme", theme: "accent1" } }
		])
		expect(data.authors[text?.author ?? -1]).toBe("Ann Lee")
		expect(paragraph?.format).toEqual([
			{ kind: "align", value: "right" },
			{ kind: "indent", side: "left", twips: 720 },
			{ kind: "indent", side: "firstLine", twips: 360 }
		])
	})
})

const EVE = 'w:id="30" w:author="Eve" w:date="2024-01-01T00:00:00Z"'

// What the formatting change of a one-paragraph document lists.
async function formatOf(body: string, act?: (editor: PagedEditor) => Promise<void>, styles?: string): Promise<unknown> {
	const { editor } = await open(
		buildDocx({
			body: body + p("end"),
			...(styles === undefined
				? {}
				: { parts: [STYLES_PART(styles)], relationships: [{ id: "rIdS", type: "styles", target: "styles.xml" }] })
		})
	)

	if (act !== undefined) await act(editor)

	editor.setView(RevisionView.Markup)
	await settleAll(editor)

	return new EditAnnotations(editor).read([0]).revisions.find(revision => revision.kind === "formatting")?.format
}

describe("what a formatting change changed, value by value", () => {
	it("compares what the text shows: its own formatting over its style's", async () => {
		const run = (now: string, before: string): string =>
			`<w:p><w:r><w:rPr>${now}<w:rPrChange ${EVE}><w:rPr>${before}</w:rPr></w:rPrChange></w:rPr><w:t>x</w:t></w:r></w:p>`
		const paragraph = (now: string, before: string): string =>
			`<w:p><w:pPr>${now}<w:pPrChange ${EVE}><w:pPr>${before}</w:pPr></w:pPrChange></w:pPr><w:r><w:t>x</w:t></w:r></w:p>`

		expect(await formatOf(run('<w:rFonts w:ascii="Arial" w:eastAsia="MS Mincho"/>', '<w:rFonts w:ascii="Arial"/>'))).toEqual([
			{ kind: "font", script: "asian", name: "MS Mincho", theme: null }
		])
		expect(await formatOf(run('<w:szCs w:val="40"/>', ""))).toEqual([{ kind: "size", script: "complex", points: 20 }])
		expect(await formatOf(run("<w:vanish/>", ""))).toEqual([{ kind: "toggle", property: "hidden", on: true }])
		expect(await formatOf(run('<w:u w:val="single" w:color="FF0000"/>', '<w:u w:val="single"/>'))).toEqual([
			{ kind: "underlineColor", color: { kind: "rgb", rgb: "FF0000" } }
		])
		expect(await formatOf(run('<w:color w:val="ff0000"/><w:b/>', '<w:color w:val="FF0000"/>'))).toEqual([
			{ kind: "toggle", property: "bold", on: true }
		])
		// Single line spacing set and then not: the same spacing.
		expect(await formatOf(paragraph('<w:jc w:val="center"/>', '<w:spacing w:line="240" w:lineRule="auto"/>'))).toEqual([
			{ kind: "align", value: "center" }
		])
		// Line spacing is listed before the space around the paragraph.
		expect(await formatOf(paragraph('<w:spacing w:before="240" w:line="360" w:lineRule="auto"/>', ""))).toEqual([
			{ kind: "lineSpacing", rule: "auto", value: 360 },
			{ kind: "space", side: "before", points: 12 }
		])
	})

	it("describes a change made and undone by the formatting the paragraph has", async () => {
		const format = await formatOf(p("Hello"), async editor => {
			editor.session.context.review.tracking = true
			select(editor, 1, 2)
			await editor.execute({ type: "align.center" })
			await editor.execute({ type: "align.start" })
		})

		expect(format).toEqual([{ kind: "style", paragraph: true, name: null }])
	})
})

describe("what a formatting change changed, with character styles", () => {
	const STYLES =
		'<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
		'<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:rPr><w:b/></w:rPr></w:style>' +
		'<w:style w:type="character" w:styleId="Strong"><w:name w:val="Strong"/><w:rPr><w:b/></w:rPr></w:style>'
	const run = (now: string, before: string, paragraph = ""): string =>
		`<w:p>${paragraph}<w:r><w:rPr>${now}<w:rPrChange ${EVE}><w:rPr>${before}</w:rPr></w:rPrChange></w:rPr><w:t>x</w:t></w:r></w:p>`

	it("counts what a character style gives, its toggles flipping the paragraph style's", async () => {
		// Strong instead of direct bold: the same bold text, a new style.
		expect(await formatOf(run('<w:rStyle w:val="Strong"/>', "<w:b/>"), undefined, STYLES)).toEqual([
			{ kind: "style", paragraph: false, name: "Strong" }
		])
		// Strong in a bold heading flips bold off.
		expect(
			await formatOf(run('<w:rStyle w:val="Strong"/>', "", '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>'), undefined, STYLES)
		).toEqual([
			{ kind: "style", paragraph: false, name: "Strong" },
			{ kind: "toggle", property: "bold", on: false }
		])
	})

	it("describes a change that left nothing different by the font and size the text shows", async () => {
		expect(await formatOf(run("", '<w:b w:val="0"/>'), undefined, STYLES)).toEqual([
			{ kind: "font", script: "default", name: "Times New Roman", theme: null },
			{ kind: "size", script: "default", points: 10 }
		])
	})

	it("lists the Asian font before the default one", async () => {
		expect(await formatOf(run('<w:rFonts w:ascii="Arial" w:eastAsia="SimSun"/>', ""))).toEqual([
			{ kind: "font", script: "asian", name: "SimSun", theme: null },
			{ kind: "font", script: "default", name: "Arial", theme: null }
		])
	})
})

describe("comments in many notes", () => {
	it(
		"makes no note's session to open, and reads comments and changes of the pages in view under a millisecond",
		{ timeout: 300_000 },
		async () => {
			let body = ""
			let notes = NOTE_SEPARATORS
			let comments = ""

			for (let k = 1; k <= 200; k++) {
				body += `<w:p><w:r><w:t xml:space="preserve">Paragraph ${String(k)} ${"lorem ipsum dolor sit amet ".repeat(8)}</w:t></w:r><w:r><w:footnoteReference w:id="${String(k)}"/></w:r></w:p>`
				notes +=
					`<w:footnote w:id="${String(k)}"><w:p><w:r><w:footnoteRef/></w:r><w:commentRangeStart w:id="${String(k)}"/>` +
					`<w:r><w:t xml:space="preserve"> note ${String(k)}</w:t></w:r><w:commentRangeEnd w:id="${String(k)}"/><w:r><w:commentReference w:id="${String(k)}"/></w:r>` +
					`<w:ins w:id="${String(1000 + k)}" w:author="Bob" w:date="2026-01-01T00:00:00Z"><w:r><w:t>X</w:t></w:r></w:ins></w:p></w:footnote>`
				comments += `<w:comment w:id="${String(k)}" w:author="Ada" w:date="2026-01-01T00:00:00Z"><w:p><w:r><w:t>c${String(k)}</w:t></w:r></w:p></w:comment>`
			}

			const { editor } = await open(buildDocx({ body, footnotes: notes, comments }))

			await settleAll(editor)

			const annotations = new EditAnnotations(editor)
			const middle = Math.floor(editor.pageCount / 2)
			const mounted = [middle - 1, middle, middle + 1]

			expect(editor.sessions).toHaveLength(1)

			const data = annotations.read(mounted)
			const boxed = data.comments.filter(comment => comment.rectCount > 0)

			expect(data.comments).toHaveLength(200)
			expect(boxed.length).toBeGreaterThan(0)
			// Each note shown has its tracked insertion boxed, with its author.
			expect(data.revisions).toHaveLength(boxed.length)
			expect(data.revisions.every(revision => revision.rectCount > 0 && data.authors[revision.author] === "Bob")).toBe(true)
			// Only the notes on the pages read got theirs.
			expect(editor.sessions.length).toBe(1 + boxed.length)

			const range = editor.body.geometry.pageRange(middle)
			let target = range?.from ?? 1

			for (let $pos = editor.session.state.doc.resolve(target); !$pos.parent.inlineContent;)
				$pos = editor.session.state.doc.resolve(++target)

			select(editor, target)
			editor.setVisible(mounted[0] ?? 0, mounted[2] ?? 0)

			const batches: number[] = []

			// In this thread's CPU time (other work on the machine does not count), the p95 of each batch of
			// keystrokes after a warm-up one, and the least of them: a batch a collection, a recompile or a busy machine lands
			// in does not decide it.
			for (let batch = 0; batch < 6; batch++) {
				const reads: number[] = []

				for (let k = 0; k < 40; k++) {
					editor.session.dispatch(editor.session.state.tr.insertText("a"))
					await Promise.resolve()

					const start = cpuMs()

					annotations.read(mounted)
					reads.push(cpuMs() - start)
				}

				if (batch > 0)
					batches.push(
						percentile(
							reads.sort((a, b) => a - b),
							0.95
						)
					)
			}

			const sorted = batches.sort((a, b) => a - b)

			process.stderr.write(`notes read p95 per batch (CPU): ${sorted.map(value => value.toFixed(3)).join(", ")} ms\n`)
			// Still only the notes of the pages read have a session (typing moves some onto them).
			expect(editor.sessions).toHaveLength(1 + annotations.read(mounted).comments.filter(comment => comment.rectCount > 0).length)
			expect(sorted[0]).toBeLessThan(budget(1))
			annotations.dispose()
		}
	)
})

const MATH_FONT = '<w:rPr><w:rFonts w:ascii="Cambria Math" w:hAnsi="Cambria Math"/></w:rPr>'
const mathRun = (text: string): string => `<m:r>${MATH_FONT}<m:t>${text}</m:t></m:r>`
// x squared changed to x cubed inside an equation (Bob), and a separate equation's run Ada inserted.
const EQUATIONS = buildDocx({
	document:
		`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NAMESPACES}><w:body>` +
		`<w:p><w:r><w:t xml:space="preserve">Edited </w:t></w:r><m:oMath><m:sSup><m:sSupPr><m:ctrlPr>${MATH_FONT}</m:ctrlPr></m:sSupPr>` +
		`<m:e>${mathRun("x")}</m:e><m:sup><w:del w:id="21" w:author="Bob" w:date="2026-02-02T11:00:00Z">${mathRun("2")}</w:del>` +
		`<w:ins w:id="22" w:author="Bob" w:date="2026-02-02T11:00:00Z">${mathRun("3")}</w:ins></m:sup></m:sSup></m:oMath></w:p>` +
		`<w:p><m:oMath>${mathRun("a")}<w:ins w:id="31" w:author="Ada" w:date="2026-01-01T10:00:00Z">${mathRun("+b")}</w:ins></m:oMath></w:p>` +
		"</w:body></w:document>"
})

describe("changes inside equations", () => {
	it("are told with their own kind, author and date, each change apart", async () => {
		const { editor } = await open(EQUATIONS)

		editor.setView(RevisionView.Markup)
		await settleAll(editor)

		const data = new EditAnnotations(editor).read([0])
		const changes = data.revisions
			.map(revision => [revision.kind, data.authors[revision.author] ?? "?", revision.date, revision.text])
			.sort((a, b) => String(a).localeCompare(String(b)))

		expect(changes).toEqual([
			["deletion", "Bob", "2026-02-02T11:00:00Z", ""],
			["insertion", "Ada", "2026-01-01T10:00:00Z", ""],
			["insertion", "Bob", "2026-02-02T11:00:00Z", ""]
		])
		expect(data.revisions.every(revision => revision.rectCount > 0)).toBe(true)
	})
})

const CORPUS_FILES = [
	"docx/oxsdk__Comment025.docx",
	"docx/oxsdk__Comment028.docx",
	"docx/oxsdk__Comment033.docx",
	"docx/lo__redline-range-comment.docx"
]

describe.skipIf(!existsSync(join(CORPUS_DIR, CORPUS_FILES[0] ?? "")))("live annotations against a fresh layout of the saved file", () => {
	for (const file of CORPUS_FILES) {
		it(`boxes ${file} as the viewer does after an edit, a save and a reopen`, { timeout: 60_000 }, async () => {
			const opened = await open(new Uint8Array(readFileSync(join(CORPUS_DIR, file))))
			const editor = opened.editor

			for (const view of [RevisionView.Final, RevisionView.Markup]) {
				editor.setView(view)
				await settleAll(editor)

				// An edit away from the annotations: the last paragraph gets a character.
				const session = editor.body.session
				const end = session.state.doc.content.size - 1
				const $end = session.state.doc.resolve(end)

				if ($end.parent.isTextblock) {
					session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, end)))
					session.dispatch(session.state.tr.insertText("."))
					await settleAll(editor)
				}

				const annotations = new EditAnnotations(editor)
				const live = annotations.read(allPages(editor))
				const viewer = await viewerAnnotations(await save(opened), view)

				expectSameComments(live, viewer)

				if (view === RevisionView.Markup) expect(changedLines(live)).toEqual(changedLines(viewer))

				annotations.dispose()
			}
		})
	}
})

const LARGE = join(import.meta.dirname, "fixtures", "08-large-300p.docx")

// This thread's CPU time in ms where the runtime tells it, else the wall clock.
function cpuMs(): number {
	const usage: unknown = Reflect.get(process, "threadCpuUsage")

	if (typeof usage !== "function") return performance.now()

	const { user, system } = Reflect.apply(usage, process, []) as { user: number; system: number }

	return (user + system) / 1000
}

function percentile(sorted: readonly number[], fraction: number): number {
	return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0
}

describe("comment boxes kept per page", () => {
	it("boxes the comments again only on pages laid out again, as a fresh read boxes them", async () => {
		let body = ""
		let comments = ""

		// A comment in every other paragraph.
		for (let k = 1; k <= 120; k++) {
			body +=
				k % 2 === 0
					? `<w:p><w:r><w:t xml:space="preserve">Plain ${String(k)} ${"lorem ipsum dolor sit amet ".repeat(10)}</w:t></w:r></w:p>`
					: `<w:p><w:commentRangeStart w:id="${String(k)}"/><w:r><w:t xml:space="preserve">Paragraph ${String(k)} </w:t></w:r><w:commentRangeEnd w:id="${String(k)}"/>` +
						`<w:r><w:commentReference w:id="${String(k)}"/></w:r><w:r><w:t xml:space="preserve">${"lorem ipsum dolor sit amet ".repeat(10)}</w:t></w:r></w:p>`

			if (k % 2 === 0) continue

			comments += `<w:comment w:id="${String(k)}" w:author="Ada" w:date="2026-01-01T00:00:00Z"><w:p><w:r><w:t>c${String(k)}</w:t></w:r></w:p></w:comment>`
		}

		const { editor } = await open(buildDocx({ body, comments }))

		await settleAll(editor)
		expect(editor.pageCount).toBeGreaterThan(5)

		const mounted = [2, 3, 4]
		const annotations = new EditAnnotations(editor)
		const boxed = vi.spyOn(editor.body.geometry, "rangesBoxes")
		const rects = (data: EditAnnotationData): unknown[] =>
			data.comments.map(comment => [
				comment.id,
				[...data.rectPages.subarray(comment.firstRect, comment.firstRect + comment.rectCount)],
				[...data.rectFloats.subarray(comment.firstRect * RECT_FLOATS, (comment.firstRect + comment.rectCount) * RECT_FLOATS)]
			])

		annotations.read(mounted)
		boxed.mockClear()
		// Nothing changed: no page is boxed again.
		annotations.read(mounted)
		expect(boxed).not.toHaveBeenCalled()

		// Typing at the start of the first paragraph without a comment that starts on page 4.
		editor.setVisible(2, 4)

		const from = editor.body.geometry.pageRange(4)?.from ?? 1
		let target = -1

		editor.session.state.doc.descendants((node, pos) => {
			if (target < 0 && node.isTextblock && pos >= from && node.textContent.startsWith("Plain")) target = pos + 1

			return target < 0
		})

		for (let k = 0; k < 3; k++) editor.session.dispatch(editor.session.state.tr.insertText("typed ", target))

		boxed.mockClear()

		const kept = annotations.read(mounted)

		// Pages 2 and 3 show what they showed: page 4 alone is boxed again.
		expect(boxed).toHaveBeenCalledTimes(1)
		expect(rects(kept)).toEqual(rects(new EditAnnotations(editor).read(mounted)))
		annotations.dispose()
	})
})

describe("change boxes kept per page", () => {
	it("boxes each change again only when its page or places change, as a fresh read boxes them", async () => {
		let body = ""

		// Tracked insertions by two authors on the first page.
		for (let k = 1; k <= 12; k++)
			body +=
				`<w:p><w:r><w:t xml:space="preserve">Plain ${String(k)} </w:t></w:r>` +
				`<w:ins w:id="${String(k)}" w:author="${k % 2 === 0 ? "Ann" : "Bob"}" w:date="2026-01-01T00:00:00Z"><w:r><w:t>added ${String(k)}</w:t></w:r></w:ins></w:p>`

		const { editor } = await open(buildDocx({ body }))

		await settleAll(editor)

		const mounted = allPages(editor)
		const annotations = new EditAnnotations(editor)
		const boxed = vi.spyOn(editor.body.geometry, "rangesBoxes")
		const rects = (data: EditAnnotationData): unknown[] =>
			data.revisions.map(revision => [
				revision.id,
				[...data.rectPages.subarray(revision.firstRect, revision.firstRect + revision.rectCount)],
				[...data.rectFloats.subarray(revision.firstRect * RECT_FLOATS, (revision.firstRect + revision.rectCount) * RECT_FLOATS)]
			])

		expect(annotations.read(mounted).revisions.length).toBeGreaterThanOrEqual(12)
		boxed.mockClear()
		// Nothing changed: no change is boxed again.
		annotations.read(mounted)
		expect(boxed).not.toHaveBeenCalled()

		select(editor, 2)
		editor.session.dispatch(editor.session.state.tr.insertText("typed "))
		await settleAll(editor)
		expect(rects(annotations.read(mounted))).toEqual(rects(new EditAnnotations(editor).read(mounted)))
		annotations.dispose()
	})
})

describe("change boxes kept per page", () => {
	it("keeps a page's change boxes right when typing on an earlier page moves its places", async () => {
		let body = '<w:p><w:r><w:t xml:space="preserve">Start</w:t></w:r></w:p>'

		for (let k = 1; k <= 60; k++)
			body += `<w:p><w:r><w:t xml:space="preserve">Plain ${String(k)} ${"lorem ipsum dolor sit amet ".repeat(10)}</w:t></w:r></w:p>`

		// Two adjacent insertions of four characters by two authors on the last page.
		body +=
			'<w:p><w:r><w:t xml:space="preserve">Last </w:t></w:r>' +
			'<w:ins w:id="1" w:author="Ann" w:date="2026-01-01T00:00:00Z"><w:r><w:t>abcd</w:t></w:r></w:ins>' +
			'<w:ins w:id="2" w:author="Bob" w:date="2026-01-01T00:00:00Z"><w:r><w:t>efgh</w:t></w:r></w:ins>' +
			'<w:r><w:t xml:space="preserve"> tail</w:t></w:r></w:p>'

		const { editor } = await open(buildDocx({ body }), undefined)

		await settleAll(editor)
		expect(editor.pageCount).toBeGreaterThan(2)

		const last = editor.pageCount - 1
		const mounted = [last]
		const annotations = new EditAnnotations(editor)
		const boxed = vi.spyOn(editor.body.geometry, "rangesBoxes")
		const rects = (data: EditAnnotationData): unknown[] =>
			data.revisions.map(revision => [
				revision.id,
				[...data.rectPages.subarray(revision.firstRect, revision.firstRect + revision.rectCount)],
				[...data.rectFloats.subarray(revision.firstRect * RECT_FLOATS, (revision.firstRect + revision.rectCount) * RECT_FLOATS)]
			])

		expect(annotations.read(mounted).revisions.length).toBe(2)

		const list = editor.page(last)

		// Text as long as the first insertion, typed into the first paragraph: the last page is not laid out
		// again, and the first change now sits where the second one was.
		editor.session.dispatch(editor.session.state.tr.insertText("wxyz", 2))
		await settleAll(editor)
		expect(editor.page(last)).toBe(list)
		boxed.mockClear()

		const kept = annotations.read(mounted)

		// The page shows what it showed: its boxes are kept.
		expect(boxed).not.toHaveBeenCalled()
		expect(rects(kept)).toEqual(rects(new EditAnnotations(editor).read(mounted)))
		annotations.dispose()
	})
})

describe("live annotations performance", () => {
	it("adds less than a millisecond per keystroke on 300 pages with 200 comments", { timeout: 300_000 }, async () => {
		const { editor } = await open(new Uint8Array(readFileSync(LARGE)))

		await settleAll(editor)
		expect(editor.pageCount).toBeGreaterThanOrEqual(150)

		// 200 comments spread over the document, each on a word.
		for (let k = 0; k < 200; k++) {
			const doc = editor.session.state.doc
			const blocks: number[] = []

			doc.descendants((node, pos) => {
				if (node.isTextblock && node.textContent.length > 12) blocks.push(pos + 1)

				return !node.isTextblock
			})

			const start = blocks[Math.floor((k * blocks.length) / 200)] ?? 1

			select(editor, start, start + 5)
			expect(await editor.execute({ type: "comment.add", text: `Comment ${String(k)}` })).toBe(true)
		}

		await settleAll(editor)

		const annotations = new EditAnnotations(editor)
		const middle = Math.floor(editor.pageCount / 2)
		const mounted = [middle - 1, middle, middle + 1]

		expect(annotations.read(allPages(editor)).comments).toHaveLength(200)

		// Keystrokes on the middle page, laid out as the view lays them out (the pages in view), each followed
		// by what the view reads once per burst.
		const range = editor.body.geometry.pageRange(middle)

		expect(range).toBeDefined()
		editor.setVisible(mounted[0] ?? 0, mounted[2] ?? 0)

		let target = range?.from ?? 1

		for (let $pos = editor.session.state.doc.resolve(target); !$pos.parent.inlineContent;)
			$pos = editor.session.state.doc.resolve(++target)

		select(editor, target)

		const reads: number[] = []

		for (let k = 0; k < 120; k++) {
			const session = editor.session

			session.dispatch(session.state.tr.insertText("a"))
			await Promise.resolve()
			await Promise.resolve()

			const start = cpuMs()
			const data = annotations.read(mounted)

			reads.push(cpuMs() - start)
			expect(data.comments).toHaveLength(200)
		}

		const sorted = reads.slice(20).sort((a, b) => a - b)
		const p95 = percentile(sorted, 0.95)

		process.stderr.write(`annotations read per keystroke: median ${percentile(sorted, 0.5).toFixed(3)} ms, p95 ${p95.toFixed(3)} ms\n`)
		expect(p95).toBeLessThan(budget(1))
		annotations.dispose()
	})
})

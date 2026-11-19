import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { Node as ProseMirrorNode } from "prosemirror-model"
import { EditorState, TextSelection } from "prosemirror-state"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { bytesSource, OpcPackage } from "@filen/office/core/opc"
import { docxSchema, findUnsavableBlocks, type DocxEditContext, type DocxEditorSession } from "@filen/office/core/docx/edit"
import { prepareDocxSave, saveDocx, type PartContributor } from "@filen/office/core/docx/write"
import type { DocxPackage } from "@filen/office/core/docx"
import type { PagedEditor } from "@filen/office/core/docx/paged"
import { markInternal } from "../core/docx/edit/invariants/index"
import { COMMENT_UNITS, commentRecords, commentsAt, docxComments, editText } from "../core/docx/review/comments"
import { commentDeclarations, commentParts } from "../core/docx/write/parts/comments"
import { CORPUS_DIR } from "./corpusDir"
import { STYLES_PART } from "./docxEditFixtures"
import { NAMESPACES, buildDocx, p, type SyntheticDocx } from "./docxSynthetic"
import { pagedEditor } from "./pagedFixtures"

const decoder = new TextDecoder()
const nodes = docxSchema.nodes

// w:date is local wall-clock time (see "comments: dates"): the clock's zone is fixed.
beforeEach(() => {
	vi.stubEnv("TZ", "UTC")
})

interface Opened {
	readonly editor: PagedEditor
	readonly pkg: DocxPackage
	readonly context: DocxEditContext
}

async function open(source: SyntheticDocx | Uint8Array, author: string | null = "Ann Lee"): Promise<Opened> {
	const opened = await pagedEditor(source instanceof Uint8Array ? source : buildDocx(source))

	opened.context.identity.author = author ?? undefined
	opened.context.identity.initials = author === null ? undefined : "AL"
	opened.context.identity.now = () => Date.UTC(2026, 9, 12, 10, 30, 15)

	return opened
}

async function save(opened: Opened, sessions: readonly DocxEditorSession[] = opened.editor.sessions): Promise<Uint8Array> {
	const result = await saveDocx({ pkg: opened.pkg, context: opened.context, sessions })

	return result.bytes as Uint8Array
}

async function changedParts(opened: Opened): Promise<readonly string[]> {
	return (await saveDocx({ pkg: opened.pkg, context: opened.context, sessions: opened.editor.sessions })).changedParts
}

async function refusal(opened: Opened, parts?: readonly PartContributor[]): Promise<{ reason: string; message: string } | undefined> {
	try {
		await prepareDocxSave({
			pkg: opened.pkg,
			context: opened.context,
			sessions: opened.editor.sessions,
			...(parts === undefined ? {} : { parts })
		})

		return undefined
	} catch (error) {
		return { reason: (error as { reason: string }).reason, message: (error as Error).message }
	}
}

async function read(bytes: Uint8Array, name: string): Promise<string | undefined> {
	const pkg = await OpcPackage.open(bytesSource(bytes))

	return pkg.has(name) ? decoder.decode(await pkg.read(name)) : undefined
}

function select(editor: PagedEditor, from: number, to: number = from): void {
	const session = editor.session

	session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, from, to)))
}

function textOf(editor: PagedEditor, range: { from: number; to: number } | undefined): string {
	return range === undefined ? "" : editor.session.state.doc.textBetween(range.from, range.to)
}

interface Reopened {
	readonly id: string
	readonly author?: string
	readonly parent?: string
	readonly done: boolean
	readonly text: string
	readonly anchored: boolean
}

// What a reopened file says of its comments: id, author, parent, done, text and whether something refers to it.
async function reopenComments(bytes: Uint8Array): Promise<Reopened[]> {
	const opened = await open(bytes)
	const store = docxComments(opened.editor)
	const texts = new Map(
		store
			.threads()
			.flatMap(thread => [thread.comment, ...thread.replies])
			.map(comment => [comment.id, comment.text])
	)

	return opened.context.model.comments.map(comment => ({
		id: comment.id,
		...(comment.author === undefined ? {} : { author: comment.author }),
		...(comment.parentId === undefined ? {} : { parent: comment.parentId }),
		done: comment.done,
		text: texts.get(comment.id) ?? "(unreferenced)",
		anchored: comment.anchor >= 0 && texts.has(comment.id)
	}))
}

// A document as Word 2013 writes it: a comment and a reply, commentsExtended and people.
const W2013: SyntheticDocx = {
	body:
		'<w:p><w:r><w:t xml:space="preserve">Alpha </w:t></w:r><w:commentRangeStart w:id="0"/><w:commentRangeStart w:id="1"/>' +
		'<w:r><w:t>beta</w:t></w:r><w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r>' +
		'<w:commentRangeEnd w:id="1"/><w:r><w:commentReference w:id="1"/></w:r><w:r><w:t xml:space="preserve"> gamma</w:t></w:r></w:p>' +
		p("Second paragraph"),
	comments:
		'<w:comment w:id="0" w:author="Bo" w:date="2020-01-01T00:00:00Z" w:initials="B"><w:p w14:paraId="11111111"><w:r><w:annotationRef/></w:r><w:r><w:t>First</w:t></w:r></w:p></w:comment>' +
		'<w:comment w:id="1" w:author="Cy" w:date="2020-01-02T00:00:00Z" w:initials="C"><w:p w14:paraId="22222222"><w:r><w:t>Reply</w:t></w:r></w:p></w:comment>',
	commentsExtended:
		'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w15:commentsEx xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml">' +
		'<w15:commentEx w15:paraId="11111111" w15:done="0"/><w15:commentEx w15:paraId="22222222" w15:paraIdParent="11111111" w15:done="0"/></w15:commentsEx>',
	people:
		'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w15:people xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml">' +
		'<w15:person w15:author="Bo"/><w15:person w15:author="Cy"/></w15:people>'
}

// The same with the parts Word 2019 adds: durable ids and UTC dates.
const W2019: SyntheticDocx = {
	...W2013,
	commentsIds:
		'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w16cid:commentsIds xmlns:w16cid="http://schemas.microsoft.com/office/word/2016/wordml/cid">' +
		'<w16cid:commentId w16cid:paraId="11111111" w16cid:durableId="0AAAAAAA"/><w16cid:commentId w16cid:paraId="22222222" w16cid:durableId="0BBBBBBB"/></w16cid:commentsIds>',
	commentsExtensible:
		'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w16cex:commentsExtensible xmlns:w16cex="http://schemas.microsoft.com/office/word/2018/wordml/cex">' +
		'<w16cex:commentExtensible w16cex:durableId="0AAAAAAA" w16cex:dateUtc="2020-01-01T00:00:00Z"/>' +
		'<w16cex:commentExtensible w16cex:durableId="0BBBBBBB" w16cex:dateUtc="2020-01-02T00:00:00Z"/></w16cex:commentsExtensible>'
}

const PLAIN: SyntheticDocx = { body: p("one two three") + p("four") }

// Two footnotes, a comment on "marked" in the first.
const NOTED: SyntheticDocx = {
	body: '<w:p><w:r><w:t xml:space="preserve">Body </w:t></w:r><w:r><w:footnoteReference w:id="1"/></w:r><w:r><w:t xml:space="preserve"> text </w:t></w:r><w:r><w:footnoteReference w:id="2"/></w:r></w:p>',
	footnotes:
		'<w:footnote w:id="1"><w:p><w:r><w:t xml:space="preserve">Note one </w:t></w:r><w:commentRangeStart w:id="5"/><w:r><w:t>marked</w:t></w:r><w:commentRangeEnd w:id="5"/><w:r><w:commentReference w:id="5"/></w:r></w:p></w:footnote>' +
		'<w:footnote w:id="2"><w:p><w:r><w:t>Note two</w:t></w:r></w:p></w:footnote>',
	comments: '<w:comment w:id="5" w:author="Bo" w:date="2020-01-01T00:00:00Z"><w:p><w:r><w:t>On a note</w:t></w:r></w:p></w:comment>'
}

// A Word 2013 thread whose reply has replies of its own (0 <- 1 <- 2, 1 <- 3).
const CHAIN: SyntheticDocx = {
	body:
		'<w:p><w:commentRangeStart w:id="0"/><w:commentRangeStart w:id="1"/><w:commentRangeStart w:id="2"/><w:commentRangeStart w:id="3"/>' +
		'<w:r><w:t>text</w:t></w:r><w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r>' +
		'<w:commentRangeEnd w:id="1"/><w:r><w:commentReference w:id="1"/></w:r><w:commentRangeEnd w:id="2"/><w:r><w:commentReference w:id="2"/></w:r>' +
		'<w:commentRangeEnd w:id="3"/><w:r><w:commentReference w:id="3"/></w:r><w:r><w:t xml:space="preserve"> after</w:t></w:r></w:p>',
	comments: [0, 1, 2, 3]
		.map(
			id =>
				`<w:comment w:id="${String(id)}" w:author="Bo"><w:p w14:paraId="0000000${String(id + 1)}"><w:r><w:t>c${String(id)}</w:t></w:r></w:p></w:comment>`
		)
		.join(""),
	commentsExtended:
		'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w15:commentsEx xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml">' +
		'<w15:commentEx w15:paraId="00000001" w15:done="0"/><w15:commentEx w15:paraId="00000002" w15:paraIdParent="00000001" w15:done="0"/>' +
		'<w15:commentEx w15:paraId="00000003" w15:paraIdParent="00000002" w15:done="0"/><w15:commentEx w15:paraId="00000004" w15:paraIdParent="00000002" w15:done="1"/></w15:commentsEx>'
}

// Every comment's paragraph id and the one its commentsExtended entry answers.
async function parents(bytes: Uint8Array): Promise<string[][]> {
	return [...((await read(bytes, "word/commentsExtended.xml")) ?? "").matchAll(/<w15:commentEx ([^>]*)\/>/g)].map(match => {
		const attributes = match[1] ?? ""

		return [/w15:paraId="([^"]*)"/.exec(attributes)?.[1] ?? "", /w15:paraIdParent="([^"]*)"/.exec(attributes)?.[1] ?? "-"]
	})
}

describe("comments: adding", () => {
	it("anchors a new comment on the selection, with its author and date, and makes the comments parts", async () => {
		const opened = await open(PLAIN)
		const { editor } = opened

		select(editor, 5, 8)
		expect(await editor.execute({ type: "comment.add", text: "Looks good\nSecond" })).toBe(true)

		const [thread] = docxComments(editor).threads()

		expect(thread?.comment).toMatchObject({
			author: "Ann Lee",
			initials: "AL",
			date: "2026-10-12T10:30:00Z",
			text: "Looks good\nSecond",
			done: false,
			added: true
		})
		expect(docxComments(editor).anchor(thread?.id ?? "")).toEqual({
			story: editor.body.session.story.story.index,
			from: 5,
			to: 9,
			reference: 10
		})

		const bytes = await save(opened)

		expect(await read(bytes, "word/document.xml")).toContain(
			'<w:commentRangeStart w:id="0"/><w:r><w:t>two</w:t></w:r><w:commentRangeEnd w:id="0"/><w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="0"/></w:r>'
		)
		expect(await read(bytes, "word/comments.xml")).toMatch(
			/<w:comment w:id="0" w:author="Ann Lee" w:date="2026-10-12T10:30:00Z" w:initials="AL"><w:p><w:pPr><w:pStyle w:val="CommentText"\/><\/w:pPr><w:r><w:rPr><w:rStyle w:val="CommentReference"\/><\/w:rPr><w:annotationRef\/><\/w:r><w:r><w:t>Looks good<\/w:t><\/w:r><\/w:p><w:p w14:paraId="[0-9A-F]{8}"><w:pPr><w:pStyle w:val="CommentText"\/><\/w:pPr><w:r><w:t>Second<\/w:t><\/w:r><\/w:p><\/w:comment>/
		)
		expect(await read(bytes, "word/commentsExtended.xml")).toMatch(/<w15:commentEx w15:paraId="[0-9A-F]{8}" w15:done="0"\/>/)
		expect(await read(bytes, "[Content_Types].xml")).toContain("commentsExtended+xml")
		expect(await read(bytes, "word/_rels/document.xml.rels")).toContain('Target="commentsExtended.xml"')
		expect(await reopenComments(bytes)).toEqual([
			{ id: "0", author: "Ann Lee", done: false, text: "Looks good\nSecond", anchored: true }
		])
	})

	it("anchors the word at the caret, or the caret itself away from words", async () => {
		const opened = await open(PLAIN)
		const { editor } = opened
		const store = docxComments(editor)

		select(editor, 6)
		expect(await editor.execute({ type: "comment.add", text: "word" })).toBe(true)
		expect(textOf(editor, store.anchor("0"))).toBe("two")

		const second = editor.session.state.doc.child(0).nodeSize + 1

		select(editor, second)
		expect(await editor.execute({ type: "comment.add", text: "start of four" })).toBe(true)
		expect(textOf(editor, store.anchor("1"))).toBe("four")
		expect((await reopenComments(await save(opened))).map(comment => comment.text)).toEqual(["word", "start of four"])
	})

	it("refuses to record a comment without an author name and leaves the document as it was", async () => {
		const opened = await open(PLAIN, null)
		const before = opened.editor.session.state.doc

		select(opened.editor, 5, 8)
		expect(opened.editor.snapshot().enabled["comment.add"]).toBe(true)
		expect(await opened.editor.execute({ type: "comment.add", text: "x" })).toBe(false)
		expect(opened.editor.session.state.doc).toBe(before)
		expect(docxComments(opened.editor).threads()).toEqual([])
		expect(await changedParts(opened)).toEqual([])
	})

	it("leaves out what XML cannot hold and writes tabs as tabs", async () => {
		const opened = await open(PLAIN)

		select(opened.editor, 1, 4)
		expect(await opened.editor.execute({ type: "comment.add", text: "a\tb\u0001c\r\nd\uD800" })).toBe(true)

		const bytes = await save(opened)

		expect(await read(bytes, "word/comments.xml")).toContain("<w:t>a</w:t><w:tab/><w:t>bc</w:t></w:r></w:p><w:p")
		expect((await reopenComments(bytes))[0]?.text).toBe("a\tbc\nd")
	})

	it("adds into an existing comments part and its Word 2019 parts, and lists a new author once", async () => {
		const opened = await open(W2019)
		const { editor } = opened
		const second = editor.session.state.doc.child(0).nodeSize

		select(editor, second + 1, second + 7)
		expect(await editor.execute({ type: "comment.add", text: "New" })).toBe(true)
		select(editor, second + 9)
		expect(await editor.execute({ type: "comment.add", text: "Again" })).toBe(true)

		const bytes = await save(opened)
		const durable = [...((await read(bytes, "word/commentsIds.xml")) ?? "").matchAll(/w16cid:durableId="([0-9A-F]{8})"/g)].map(
			match => match[1]
		)

		expect(durable).toHaveLength(4)
		expect(new Set(durable).size).toBe(4)
		expect(await read(bytes, "word/commentsExtensible.xml")).toContain(
			`w16cex:durableId="${durable[2] ?? ""}" w16cex:dateUtc="2026-10-12T10:30:00Z"`
		)
		expect(await read(bytes, "word/people.xml")).toBe(
			'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w15:people xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml">' +
				'<w15:person w15:author="Bo"/><w15:person w15:author="Cy"/><w15:person w15:author="Ann Lee"/></w15:people>'
		)
		expect((await reopenComments(bytes)).map(comment => [comment.id, comment.text])).toEqual([
			["0", "First"],
			["1", "Reply"],
			["2", "New"],
			["3", "Again"]
		])

		// A second save gives the new comments the same durable ids.
		const again = [
			...((await read(await save(opened), "word/commentsIds.xml")) ?? "").matchAll(/w16cid:durableId="([0-9A-F]{8})"/g)
		].map(match => match[1])

		expect(again).toEqual(durable)
	})

	it("undoes and redoes across stories: an undone comment is left out of the save", async () => {
		const opened = await open(PLAIN)
		const { editor } = opened
		const store = docxComments(editor)

		select(editor, 5, 8)
		await editor.execute({ type: "comment.add", text: "one" })
		await editor.execute({ type: "comment.edit", id: "0", text: "one, edited" })
		expect(store.comment("0")?.text).toBe("one, edited")

		expect(await editor.execute({ type: "history.undo" })).toBe(true)
		expect(store.comment("0")?.text).toBe("one")
		expect(await editor.execute({ type: "history.undo" })).toBe(true)
		expect(store.threads()).toEqual([])
		expect(await changedParts(opened)).toEqual([])

		expect(await editor.execute({ type: "history.redo" })).toBe(true)
		expect(await editor.execute({ type: "history.redo" })).toBe(true)
		expect(await reopenComments(await save(opened))).toEqual([
			{ id: "0", author: "Ann Lee", done: false, text: "one, edited", anchored: true }
		])
	})

	it("keeps a new comment inside a hyperlink and a tracked insertion", async () => {
		const opened = await open({
			body:
				'<w:p><w:hyperlink w:anchor="x"><w:r><w:t>linked text</w:t></w:r></w:hyperlink>' +
				'<w:ins w:id="5" w:author="Bo" w:date="2020-01-01T00:00:00Z"><w:r><w:t>inserted text</w:t></w:r></w:ins></w:p>'
		})
		const { editor } = opened

		select(editor, 2, 5)
		expect(await editor.execute({ type: "comment.add", text: "in link" })).toBe(true)

		const insertion = editor.session.state.doc.textContent.indexOf("inserted")
		let at = -1

		editor.session.state.doc.descendants((node, pos) => {
			if (at < 0 && node.isText && node.text?.startsWith("inserted") === true) at = pos

			return at < 0
		})
		expect(insertion).toBeGreaterThan(0)
		select(editor, at + 2, at + 6)
		expect(await editor.execute({ type: "comment.add", text: "in insertion" })).toBe(true)

		const document = (await read(await save(opened), "word/document.xml")) ?? ""

		expect(document.match(/<w:hyperlink/g)).toHaveLength(1)
		expect(document).toMatch(
			/<w:hyperlink w:anchor="x">.*<w:commentRangeStart w:id="0"\/>.*<w:commentReference w:id="0"\/>.*<\/w:hyperlink>/
		)
		expect(document.match(/<w:ins /g)).toHaveLength(1)
		expect(document).toMatch(/<w:ins [^>]*>.*<w:commentRangeStart w:id="1"\/>.*<w:commentReference w:id="1"\/>.*<\/w:ins>/)
	})
})

describe("comments: threads, resolving and deleting", () => {
	it("lists source threads in document order with their replies and text, the same objects while unchanged", async () => {
		const opened = await open(W2013)
		const store = docxComments(opened.editor)
		const threads = store.threads()

		expect(threads).toHaveLength(1)
		expect(threads[0]?.comment).toMatchObject({
			id: "0",
			author: "Bo",
			text: "First",
			added: false,
			canEdit: true,
			canReply: true,
			canResolve: true
		})
		expect(threads[0]?.replies.map(reply => [reply.id, reply.parentId, reply.text])).toEqual([["1", "0", "Reply"]])
		expect(store.threads()).toBe(threads)
		opened.editor.session.dispatch(opened.editor.session.state.tr.insertText("x", 1))
		expect(store.threads()).toBe(threads)
	})

	it("replies under the thread, anchored with its first comment, and links them in commentsExtended", async () => {
		const opened = await open(W2013)

		expect(await opened.editor.execute({ type: "comment.reply", id: "1", text: "Me too" })).toBe(true)
		expect(
			docxComments(opened.editor)
				.threads()[0]
				?.replies.map(reply => [reply.id, reply.parentId, reply.author])
		).toEqual([
			["1", "0", "Cy"],
			["2", "0", "Ann Lee"]
		])

		const bytes = await save(opened)
		const document = (await read(bytes, "word/document.xml")) ?? ""

		expect(document).toContain(
			'<w:commentRangeStart w:id="0"/><w:commentRangeStart w:id="1"/><w:commentRangeStart w:id="2"/><w:r><w:t>beta</w:t></w:r>' +
				'<w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r><w:commentRangeEnd w:id="1"/><w:r><w:commentReference w:id="1"/></w:r>' +
				'<w:commentRangeEnd w:id="2"/><w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="2"/></w:r>'
		)
		expect(await read(bytes, "word/commentsExtended.xml")).toMatch(
			/<w15:commentEx w15:paraId="[0-9A-F]{8}" w15:paraIdParent="11111111" w15:done="0"\/><\/w15:commentsEx>$/
		)
		expect(await reopenComments(bytes)).toEqual([
			{ id: "0", author: "Bo", done: false, text: "First", anchored: true },
			{ id: "1", author: "Cy", parent: "0", done: false, text: "Reply", anchored: true },
			{ id: "2", author: "Ann Lee", parent: "0", done: false, text: "Me too", anchored: true }
		])
	})

	it("resolves and reopens a whole thread, splicing w15:done into the source entries", async () => {
		const opened = await open(W2013)
		const { editor } = opened

		expect(await editor.execute({ type: "comment.resolve", id: "1" })).toBe(true)
		expect(docxComments(editor).threads()[0]?.done).toBe(true)

		const resolved = await save(opened)

		expect(await read(resolved, "word/commentsExtended.xml")).toBe(
			'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w15:commentsEx xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml">' +
				'<w15:commentEx w15:paraId="11111111" w15:done="1"/><w15:commentEx w15:paraId="22222222" w15:paraIdParent="11111111" w15:done="1"/></w15:commentsEx>'
		)
		expect(await read(resolved, "word/document.xml")).toBe(await read(buildDocx(W2013), "word/document.xml"))
		expect((await reopenComments(resolved)).map(comment => comment.done)).toEqual([true, true])

		expect(await editor.execute({ type: "comment.reopen", id: "0" })).toBe(true)
		expect(await changedParts(opened)).toEqual([])
		expect(await editor.execute({ type: "history.undo" })).toBe(true)
		expect(docxComments(editor).threads()[0]?.done).toBe(true)
	})

	it("resolves a comment of a document without commentsExtended by making the part", async () => {
		const opened = await open({ body: W2013.body ?? "", comments: W2013.comments ?? "" })

		expect(await opened.editor.execute({ type: "comment.resolve", id: "0" })).toBe(true)

		const bytes = await save(opened)

		expect(await read(bytes, "word/commentsExtended.xml")).toContain('<w15:commentEx w15:paraId="11111111" w15:done="1"/>')
		// Without commentsExtended the two are separate threads; only the first is resolved.
		expect((await reopenComments(bytes)).map(comment => comment.done)).toEqual([true, false])
	})

	it("gives a source comment without a paragraph id one to resolve it", async () => {
		const opened = await open({
			body: '<w:p><w:commentRangeStart w:id="3"/><w:r><w:t>text</w:t></w:r><w:commentRangeEnd w:id="3"/><w:r><w:commentReference w:id="3"/></w:r></w:p>',
			comments: '<w:comment w:id="3" w:author="Bo"><w:p><w:r><w:t>Old</w:t></w:r></w:p></w:comment>'
		})

		expect(await opened.editor.execute({ type: "comment.resolve", id: "3" })).toBe(true)

		const bytes = await save(opened)
		const paraId = /<w:p w14:paraId="([0-9A-F]{8})">/.exec((await read(bytes, "word/comments.xml")) ?? "")?.[1]

		expect(paraId).toBeDefined()
		expect(await read(bytes, "word/commentsExtended.xml")).toContain(`<w15:commentEx w15:paraId="${paraId ?? ""}" w15:done="1"/>`)
		expect((await reopenComments(bytes))[0]?.done).toBe(true)
	})

	it("deletes a thread with its replies from every part and its anchors from the story", async () => {
		const opened = await open(W2019)

		expect(await opened.editor.execute({ type: "comment.delete", id: "0" })).toBe(true)
		expect(docxComments(opened.editor).threads()).toEqual([])

		const bytes = await save(opened)

		expect(await read(bytes, "word/document.xml")).not.toContain("comment")
		expect(await read(bytes, "word/comments.xml")).not.toContain("<w:comment ")
		expect(await read(bytes, "word/commentsExtended.xml")).not.toContain("commentEx ")
		expect(await read(bytes, "word/commentsIds.xml")).not.toContain("commentId ")
		expect(await read(bytes, "word/commentsExtensible.xml")).not.toContain("commentExtensible ")
		expect(await reopenComments(bytes)).toEqual([])

		expect(await opened.editor.execute({ type: "history.undo" })).toBe(true)
		expect(await changedParts(opened)).toEqual([])
	})

	it("deletes a reply alone", async () => {
		const opened = await open(W2013)

		expect(await opened.editor.execute({ type: "comment.delete", id: "1" })).toBe(true)

		const bytes = await save(opened)

		expect(await reopenComments(bytes)).toEqual([{ id: "0", author: "Bo", done: false, text: "First", anchored: true }])
		expect(await read(bytes, "word/commentsExtended.xml")).not.toContain("22222222")
	})

	it("takes another writer's element keyed on a deleted comment's paragraph out of commentsExtended too", async () => {
		const opened = await open({
			...W2013,
			commentsExtended: (W2013.commentsExtended ?? "").replace(
				"</w15:commentsEx>",
				'<w15:commentExNG w15:paraId="22222222" w15:done="0"/></w15:commentsEx>'
			)
		})

		expect(await opened.editor.execute({ type: "comment.delete", id: "1" })).toBe(true)

		const extended = (await read(await save(opened), "word/commentsExtended.xml")) ?? ""

		expect(extended).not.toContain("22222222")
		expect(extended).toContain('<w15:commentEx w15:paraId="11111111" w15:done="0"/>')
	})

	it("removes a deleted comment while the save rewrites another comment of its part", async () => {
		const opened = await open(W2013)

		expect(await opened.editor.execute({ type: "comment.edit", id: "0", text: "First, edited" })).toBe(true)
		expect(await opened.editor.execute({ type: "comment.delete", id: "1" })).toBe(true)

		const bytes = await save(opened)
		const comments = await reopenComments(bytes)

		expect(comments.map(comment => [comment.id, comment.text, comment.anchored])).toEqual([["0", "First, edited", true]])
		expect(await read(bytes, "word/comments.xml")).not.toContain('w:id="1"')
		expect(await read(bytes, "word/commentsExtended.xml")).not.toContain("22222222")
	})

	it("removes a deleted comment whose own text was edited in the same save", async () => {
		const opened = await open(W2013)

		expect(await opened.editor.execute({ type: "comment.edit", id: "1", text: "Second, edited" })).toBe(true)
		expect(await opened.editor.execute({ type: "comment.edit", id: "0", text: "First, edited" })).toBe(true)
		expect(await opened.editor.execute({ type: "comment.delete", id: "1" })).toBe(true)

		const comments = await reopenComments(await save(opened))

		expect(comments.map(comment => [comment.id, comment.text])).toEqual([["0", "First, edited"]])
	})
})

describe("comments: editing", () => {
	it("rewrites only the paragraphs whose text changed and keeps the last one's paragraph id", async () => {
		const opened = await open({
			...W2013,
			comments:
				'<w:comment w:id="0" w:author="Bo"><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Kept bold</w:t></w:r></w:p><w:p><w:r><w:t>Middle</w:t></w:r></w:p>' +
				'<w:p w14:paraId="11111111"><w:r><w:annotationRef/></w:r><w:r><w:t>Last</w:t></w:r></w:p></w:comment>' +
				'<w:comment w:id="1" w:author="Cy"><w:p w14:paraId="22222222"><w:r><w:t>Reply</w:t></w:r></w:p></w:comment>'
		})

		expect(await opened.editor.execute({ type: "comment.edit", id: "0", text: "Kept bold\nNew middle\nAnother\nLast, edited" })).toBe(
			true
		)
		expect(await read(await save(opened), "word/comments.xml")).toContain(
			"<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Kept bold</w:t></w:r></w:p><w:p><w:r><w:t>New middle</w:t></w:r></w:p><w:p><w:r><w:t>Another</w:t></w:r></w:p>" +
				'<w:p w14:paraId="11111111"><w:r><w:annotationRef/></w:r><w:r><w:t>Last, edited</w:t></w:r></w:p>'
		)
	})

	it("plans the smallest paragraph change", () => {
		const paragraphs = ["a", "b", "c"].map(text => nodes.paragraph.create({ src: 7 }, docxSchema.text(text)))
		const state = EditorState.create({ doc: nodes.doc.create(null, paragraphs) })
		const apply = (next: readonly string[]) => {
			const tr = editText(state, next, null)

			if (tr === undefined) throw new Error("not plain")

			const doc = state.apply(tr).doc

			return { doc, texts: Array.from({ length: doc.childCount }, (_, k) => doc.child(k).textContent) }
		}

		const inserted = apply(["a", "x", "b", "c"])

		expect(inserted.texts).toEqual(["a", "x", "b", "c"])
		expect([0, 2, 3].map(k => inserted.doc.child(k))).toEqual([paragraphs[0], paragraphs[1], paragraphs[2]].map(node => node))
		expect(inserted.doc.child(0)).toBe(paragraphs[0])
		expect(inserted.doc.child(2)).toBe(paragraphs[1])

		const shortened = apply(["only"])

		expect(shortened.texts).toEqual(["only"])
		expect(shortened.doc.child(0).attrs["src"]).toBe(7)
		expect(apply(["a", "b", "c"]).doc).toBe(state.doc)
	})
})

describe("comments: the selection and stepping", () => {
	it("tells the comment at the caret, the same object while it stays, and steps through comments", async () => {
		const opened = await open(W2013)
		const { editor } = opened

		select(editor, 9)

		const first = editor.snapshot().context.comment

		expect(first).toEqual({ id: "1", thread: "0", done: false, ids: ["1", "0"] })
		select(editor, 10)
		expect(editor.snapshot().context.comment).toBe(first)
		select(editor, 2)
		expect(editor.snapshot().context.comment).toBeNull()

		expect(await editor.execute({ type: "comment.next" })).toBe(true)
		expect(editor.session.state.doc.textBetween(editor.session.state.selection.from, editor.session.state.selection.to)).toBe("beta")
		expect(await editor.execute({ type: "comment.prev" })).toBe(true)
		expect(editor.snapshot().context.comment?.thread).toBe("0")
	})

	it("finds the comment at the caret from the index's comment entries alone", async () => {
		const opened = await open({
			body:
				'<w:p><w:ins w:id="7" w:author="Bo" w:date="2020-01-01T00:00:00Z"><w:r><w:t>inserted</w:t></w:r></w:ins></w:p>' +
				(W2013.body ?? ""),
			comments: W2013.comments ?? ""
		})
		const index = opened.editor.session.reviewIndex
		const entry = vi.spyOn(index, "entry")
		const start = opened.editor.session.state.doc.child(0).nodeSize

		expect(commentsAt(index, start + 9)).toEqual(["1", "0"])
		expect(commentsAt(index, start + 2)).toEqual([])
		expect(commentsAt(index, 3)).toEqual([])
		expect(entry).not.toHaveBeenCalled()
	})

	it("reads anchors and what the commands can do from the comment entries alone, among tracked changes", async () => {
		const ins = (id: number, text: string): string =>
			`<w:ins w:id="${String(id)}" w:author="Bo" w:date="2020-01-01T00:00:00Z"><w:r><w:t>${text}</w:t></w:r></w:ins>`
		const opened = await open({
			body:
				Array.from({ length: 6 }, (_, k) => `<w:p>${ins(100 + k, `inserted ${String(k)}`)}</w:p>`).join("") +
				'<w:commentRangeStart w:id="3"/>' +
				'<w:p><w:r><w:t xml:space="preserve">Alpha </w:t></w:r><w:commentRangeStart w:id="0"/><w:r><w:t>beta</w:t></w:r></w:p>' +
				`<w:p>${ins(200, "gamma")}<w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r>` +
				'<w:r><w:t xml:space="preserve"> delta</w:t></w:r><w:commentRangeEnd w:id="3"/><w:r><w:commentReference w:id="3"/></w:r></w:p>' +
				'<w:p><w:fldSimple w:instr="PAGE"><w:commentRangeStart w:id="5"/><w:r><w:t>1</w:t></w:r></w:fldSimple><w:r><w:t>x</w:t></w:r>' +
				'<w:commentRangeEnd w:id="5"/><w:r><w:commentReference w:id="5"/></w:r>' +
				'<w:commentRangeStart w:id="6"/><w:r><w:t>y</w:t></w:r><w:commentRangeEnd w:id="6"/>' +
				'<w:fldSimple w:instr="PAGE"><w:r><w:commentReference w:id="6"/></w:r></w:fldSimple></w:p>' +
				Array.from({ length: 6 }, (_, k) => `<w:p>${ins(300 + k, `more ${String(k)}`)}</w:p>`).join(""),
			comments: [0, 3, 5, 6]
				.map(
					id =>
						`<w:comment w:id="${String(id)}" w:author="Bo"><w:p w14:paraId="0000000${String(id)}"><w:r><w:t>c${String(id)}</w:t></w:r></w:p></w:comment>`
				)
				.join("")
		})
		const { editor } = opened
		const index = editor.session.reviewIndex
		const doc = editor.session.state.doc
		// The anchors as a walk over every entry finds them, the first of each kind.
		const walked = new Map<string, { start: number; end: number; reference: number }>()

		for (let k = 0; k < index.size; k++) {
			const entry = index.entry(k)

			if (entry === undefined || entry.kind > 2) continue

			const found = walked.get(entry.id) ?? { start: -1, end: -1, reference: -1 }
			const slots: readonly ("start" | "end" | "reference")[] = ["start", "end", "reference"]
			const slot = slots[entry.kind] ?? "start"

			if (found[slot] < 0) found[slot] = entry.from

			walked.set(entry.id, found)
		}

		expect(index.revisionCount).toBeGreaterThanOrEqual(13)
		expect([...walked.keys()].sort()).toEqual(["0", "3", "5", "6"])

		const entry = vi.spyOn(index, "entry")
		const store = docxComments(editor)

		for (const [id, found] of walked) {
			const from = found.start >= 0 ? found.start : found.reference

			expect(store.anchor(id)).toEqual({
				story: editor.session.story.story.index,
				from,
				to: found.end >= 0 ? Math.max(from, found.end) : from,
				reference: found.reference
			})
		}

		// The block-level start sits before its paragraph, the comment spans two paragraphs.
		expect(doc.resolve(walked.get("3")?.start ?? 0).depth).toBe(0)
		expect(doc.resolve(walked.get("0")?.start ?? 0).index(0)).not.toBe(doc.resolve(walked.get("0")?.end ?? 0).index(0))
		expect(store.threads().map(thread => thread.id)).toEqual(["3", "0", "5", "6"])

		const flags = (id: string) => {
			const comment = store.comment(id)

			return [comment?.canDelete, comment?.canReply]
		}

		expect(flags("0")).toEqual([true, true])
		expect(flags("3")).toEqual([true, true])
		// Anchors held by a field are its bytes.
		expect(flags("5")).toEqual([false, true])
		expect(flags("6")).toEqual([false, false])
		expect(store.select("0")).toBe(true)
		expect(textOf(editor, editor.session.state.selection)).toBe("betagamma")
		expect(store.step(true)).toBe(true)
		expect(editor.snapshot().context.comment?.thread).toBe("5")
		expect(entry).not.toHaveBeenCalled()
	})

	it("hears changes of the threads, a microtask later", async () => {
		const opened = await open(W2013)
		const store = docxComments(opened.editor)
		let heard = 0

		store.subscribe(() => heard++)
		await opened.editor.execute({ type: "comment.resolve", id: "0" })
		await Promise.resolve()
		await Promise.resolve()
		expect(heard).toBe(1)
		opened.editor.session.dispatch(opened.editor.session.state.tr.insertText("x", 1))
		await Promise.resolve()
		await Promise.resolve()
		expect(heard).toBe(1)
	})
	it("does not read the comments again for typing while tracking, which changes tracked changes only", async () => {
		const opened = await open({
			body:
				'<w:p><w:commentRangeStart w:id="0"/><w:r><w:t>Commented</w:t></w:r><w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r></w:p>' +
				"<w:p><w:r><w:t>Plain paragraph</w:t></w:r></w:p>",
			comments: '<w:comment w:id="0" w:author="Ann"><w:p><w:r><w:t>Note</w:t></w:r></w:p></w:comment>'
		})
		const { editor } = opened
		const store = docxComments(editor)
		let heard = 0

		store.subscribe(() => heard++)
		expect(await editor.execute({ type: "review.track", on: true })).toBe(true)

		const threads = store.threads()
		const version = store.version
		// Reading the comments again asks the host for the body's session first.
		const read = vi.spyOn(editor, "storySession")
		const plain = editor.session.state.doc.child(0).nodeSize + 3

		for (let k = 0; k < 3; k++) {
			editor.session.dispatch(editor.session.state.tr.insertText("x", plain + k))
			await Promise.resolve()
			await Promise.resolve()
		}

		expect(editor.session.reviewIndex.revisionCount).toBe(1)
		expect(read).not.toHaveBeenCalled()
		expect(heard).toBe(0)
		expect(store.version).toBe(version)
		expect(store.threads()).toBe(threads)
	})
})

describe("comments: Gate 2", () => {
	it("refuses a new reference without a comment", async () => {
		const opened = await open(PLAIN)
		const session = opened.editor.session

		session.dispatch(session.state.tr.insert(1, nodes.comment_ref.create({ id: "5" })))
		expect(await refusal(opened)).toEqual({ reason: "danglingReference", message: "A new reference to comment 5 has no comment" })
	})

	it("refuses a new range without a comment or without an end", async () => {
		const opened = await open(PLAIN)
		const session = opened.editor.session

		session.dispatch(markInternal(session.state.tr.insert(1, nodes.marker.create({ kind: "commentRangeStart", id: "5" }))))
		expect(await refusal(opened)).toEqual({ reason: "danglingReference", message: "A new range of comment 5 has no comment" })
	})

	it("refuses a paragraph id that is already taken", async () => {
		const opened = await open(W2013)

		select(opened.editor, 2, 4)
		await opened.editor.execute({ type: "comment.add", text: "x" })

		const comment = opened.editor.sessions.find(candidate => candidate.story.story.kind === "comment" && candidate.story.story.item < 0)
		const last = comment?.state.doc.lastChild

		if (comment === undefined || last === null || last === undefined) throw new Error("no comment")

		const at = comment.state.doc.content.size - last.nodeSize
		const tr = comment.state.tr
			.removeNodeMark(at, docxSchema.marks.para_id)
			.addNodeMark(at, docxSchema.marks.para_id.create({ id: "11111111" }))

		comment.dispatch(markInternal(tr))
		expect(await refusal(opened)).toMatchObject({ reason: "duplicateId", message: expect.stringMatching(/11111111 appears 2 times/) })
	})

	it("refuses an author e-mail, a dangling entry or a person twice that another writer adds", async () => {
		const opened = await open(W2013)
		const replace = (name: string, change: (xml: string) => string): PartContributor => ({
			async contribute(parts) {
				parts.replace(name, new TextEncoder().encode(change(decoder.decode(await opened.pkg.opc.read(name)))))
			}
		})

		expect(
			await refusal(opened, [replace("word/people.xml", xml => xml.replace('w15:author="Bo"', 'w15:author="Bo" w15:authorEmail=""'))])
		).toEqual({
			reason: "content",
			message: "word/people.xml: an author e-mail, presence or foreign attribute was added"
		})
		expect(
			await refusal(opened, [
				replace("word/commentsExtended.xml", xml =>
					xml.replace("</w15:commentsEx>", '<w15:commentEx w15:paraId="7ABCDEF0" w15:done="1"/></w15:commentsEx>')
				)
			])
		).toEqual({ reason: "danglingReference", message: "commentsExtended names paragraph 7ABCDEF0, which no part has" })
		expect(
			await refusal(opened, [
				replace("word/people.xml", xml => xml.replace("</w15:people>", '<w15:person w15:author="Bo"/></w15:people>'))
			])
		).toEqual({
			reason: "duplicateId",
			message: "word/people.xml: Bo appears 2 times"
		})
		expect(await refusal(opened, [commentParts])).toBeUndefined()
	})
})

describe("comments: Gate 2 on new comments", () => {
	it("refuses a new comment without an author or with an author e-mail", async () => {
		const opened = await open(W2013)

		select(opened.editor, 2, 4)
		await opened.editor.execute({ type: "comment.add", text: "x" })

		const writing = (attributes: string): PartContributor => ({
			...commentParts,
			container(story, doc) {
				const container = commentParts.container?.(story, doc)

				return container === undefined ? undefined : { ...container, open: `<w:comment w:id="2"${attributes}>` }
			}
		})

		expect(await refusal(opened, [writing(' w:author="Ann" w:authorEmail=""')])).toEqual({
			reason: "content",
			message: "A new comment 2 has an author e-mail or a foreign attribute"
		})
		expect(await refusal(opened, [writing("")])).toEqual({ reason: "content", message: "A new comment 2 has no author" })
		expect(await refusal(opened)).toBeUndefined()
	})
})

describe("comments: Word's markup", () => {
	it("starts a new comment with Word's annotation mark, in the document's comment styles", async () => {
		const opened = await open({
			body: p("one two three"),
			parts: [
				STYLES_PART(
					'<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
						'<w:style w:type="paragraph" w:styleId="Kommentartext"><w:name w:val="annotation text"/></w:style>' +
						'<w:style w:type="character" w:styleId="Kommentarzeichen"><w:name w:val="annotation reference"/><w:rPr><w:sz w:val="16"/></w:rPr></w:style>'
				)
			],
			relationships: [{ id: "rIdS", type: "styles", target: "styles.xml" }]
		})

		select(opened.editor, 5, 8)
		await opened.editor.execute({ type: "comment.add", text: "First\nSecond" })
		// Editing the comment keeps the mark at its start.
		await opened.editor.execute({ type: "comment.edit", id: "0", text: "Only" })

		const bytes = await save(opened)

		expect(await read(bytes, "word/comments.xml")).toMatch(
			/<w:comment [^>]*><w:p w14:paraId="[0-9A-F]{8}"><w:pPr><w:pStyle w:val="Kommentartext"\/><\/w:pPr><w:r><w:rPr><w:rStyle w:val="Kommentarzeichen"\/><\/w:rPr><w:annotationRef\/><\/w:r><w:r><w:t>Only<\/w:t><\/w:r><\/w:p><\/w:comment>/
		)
		expect(await read(bytes, "word/document.xml")).toContain(
			'<w:r><w:rPr><w:rStyle w:val="Kommentarzeichen"/></w:rPr><w:commentReference w:id="0"/></w:r>'
		)
		expect((await reopenComments(bytes))[0]?.text).toBe("Only")
	})
})

describe("comments: Word's comment styles where the document lacks them", () => {
	it("defines Word's comment text and reference styles, under Word's ids made unique", async () => {
		const opened = await open({
			body: p("one two three"),
			parts: [
				STYLES_PART(
					'<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
						'<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/></w:style>' +
						'<w:style w:type="paragraph" w:styleId="CommentText"><w:name w:val="Something else"/></w:style>'
				)
			],
			relationships: [{ id: "rIdS", type: "styles", target: "styles.xml" }]
		})

		select(opened.editor, 5, 8)
		expect(await opened.editor.execute({ type: "comment.add", text: "Note" })).toBe(true)

		const bytes = await save(opened)
		const styles = (await read(bytes, "word/styles.xml")) ?? ""

		expect(styles).toMatch(
			/<w:style w:type="paragraph" w:styleId="CommentText1"><w:name w:val="annotation text"\/><w:basedOn w:val="Normal"\/>.*<w:sz w:val="20"\/><w:szCs w:val="20"\/>.*?<\/w:style>/
		)
		expect(styles).toMatch(
			/<w:style w:type="character" w:styleId="CommentReference"><w:name w:val="annotation reference"\/><w:basedOn w:val="DefaultParagraphFont"\/>.*<w:sz w:val="16"\/><w:szCs w:val="16"\/>.*?<\/w:style>/
		)
		expect(await read(bytes, "word/comments.xml")).toContain(
			'<w:pPr><w:pStyle w:val="CommentText1"/></w:pPr><w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:annotationRef/></w:r>'
		)
		expect(await read(bytes, "word/document.xml")).toContain(
			'<w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="0"/>'
		)
		expect((await reopenComments(bytes))[0]?.text).toBe("Note")
	})

	it("gives a source comment's new paragraphs its own style, defining none", async () => {
		const opened = await open(W2013)

		expect(await opened.editor.execute({ type: "comment.edit", id: "0", text: "First\nMore" })).toBe(true)
		expect(await changedParts(opened)).toEqual(["word/comments.xml"])
	})
})

describe("comments: what the commands can do", () => {
	it("reads a header's comments from its own session, made once needed, and offers what will run", async () => {
		const opened = await open({
			body:
				'<w:p><w:fldSimple w:instr="PAGE"><w:commentRangeStart w:id="5"/><w:r><w:t>1</w:t></w:r></w:fldSimple><w:r><w:t>x</w:t></w:r>' +
				'<w:commentRangeEnd w:id="5"/><w:r><w:commentReference w:id="5"/></w:r>' +
				'<w:commentRangeStart w:id="6"/><w:r><w:t>y</w:t></w:r><w:commentRangeEnd w:id="6"/>' +
				'<w:fldSimple w:instr="PAGE"><w:r><w:commentReference w:id="6"/></w:r></w:fldSimple></w:p>' +
				'<w:sectPr><w:headerReference w:type="default" r:id="rIdH"/></w:sectPr>',
			headers: {
				rIdH: '<w:p><w:commentRangeStart w:id="7"/><w:r><w:t>Head</w:t></w:r><w:commentRangeEnd w:id="7"/><w:r><w:commentReference w:id="7"/></w:r></w:p>'
			},
			comments: [5, 6, 7]
				.map(
					id =>
						`<w:comment w:id="${String(id)}" w:author="Bo"><w:p w14:paraId="0000000${String(id)}"><w:r><w:t>c${String(id)}</w:t></w:r></w:p></w:comment>`
				)
				.join("")
		})
		const store = docxComments(opened.editor)
		const flags = (id: string) => {
			const comment = store.comment(id)

			return [comment?.canDelete, comment?.canReply, comment?.canResolve]
		}

		// Anchors held by a field are its bytes: the comment cannot lose them, nor take a reply next to them.
		expect(flags("5")).toEqual([false, true, true])
		expect(flags("6")).toEqual([false, false, true])
		// The header's comment is listed as the file has it until its story has a session (none is made to open).
		expect(opened.editor.sessions.some(session => session.story.story.kind === "header")).toBe(false)
		expect(flags("7")).toEqual([false, false, false])
		opened.editor.storySession(store.comment("7")?.story ?? -1)
		expect(flags("7")).toEqual([true, true, true])
		expect(await opened.editor.execute({ type: "comment.delete", id: "5" })).toBe(false)
		expect(await opened.editor.execute({ type: "comment.reply", id: "6", text: "no" })).toBe(false)
		expect(await opened.editor.execute({ type: "comment.delete", id: "7" })).toBe(true)
		expect((await reopenComments(await save(opened))).map(comment => [comment.id, comment.anchored])).toEqual([
			["5", true],
			["6", true]
		])
	})
})

describe("comments: 2007-era parts", () => {
	const OLD = '<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" w:foo="1">'
	const spec: SyntheticDocx = {
		body: '<w:p><w:commentRangeStart w:id="1"/><w:r><w:t>text</w:t></w:r><w:commentRangeEnd w:id="1"/><w:r><w:commentReference w:id="1"/></w:r></w:p>',
		parts: [
			{
				name: "word/comments.xml",
				contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml",
				data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${OLD}<w:comment w:id="1" w:author="Bo"><w:p><w:r><w:t>Old</w:t></w:r></w:p></w:comment></w:comments>`
			}
		],
		relationships: [{ id: "rIdC", type: "comments", target: "comments.xml" }]
	}

	it("declares w14 on the root once a paragraph needs an id, keeping everything else", async () => {
		const opened = await open(spec)
		const session = opened.editor.storySession(opened.context.model.comments[0]?.story ?? -1)

		if (session === undefined) throw new Error("no comment session")

		expect(commentDeclarations(session.story.part, { sessions: [session], docs: [session.state.doc], stories: [] })).toBeUndefined()
		// The save declares w14 on the root, so such a comment is threaded and resolved like any other.
		expect(docxComments(opened.editor).comment("1")).toMatchObject({ canReply: true, canResolve: true, canDelete: true })

		const last = session.state.doc.lastChild

		if (last === null) throw new Error("no paragraph")

		session.dispatch(
			markInternal(
				session.state.tr.addNodeMark(
					session.state.doc.content.size - last.nodeSize,
					docxSchema.marks.para_id.create({ id: "12345678" })
				)
			)
		)
		expect(commentDeclarations(session.story.part, { sessions: [session], docs: [session.state.doc], stories: [] })).toEqual({
			open:
				'<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" w:foo="1" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"' +
				' xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="w14">',
			prefixes: new Map([["http://schemas.microsoft.com/office/word/2010/wordml", "w14"]])
		})
	})

	it("saves a reply and a resolved comment there with w14 declared on the root", async () => {
		const opened = await open(spec)

		expect(await opened.editor.execute({ type: "comment.reply", id: "1", text: "Reply" })).toBe(true)
		expect(await opened.editor.execute({ type: "comment.resolve", id: "1" })).toBe(true)

		const bytes = await save(opened)
		const comments = (await read(bytes, "word/comments.xml")) ?? ""

		expect(comments).toContain(
			'<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" w:foo="1" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"' +
				' xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="w14">'
		)
		expect(comments).toMatch(/<w:p w14:paraId="[0-9A-F]{8}">/)
		expect(await reopenComments(bytes)).toMatchObject([
			{ id: "1", done: true, text: "Old" },
			{ parent: "1", text: "Reply" }
		])
	})

	it("lets the root change by namespace declarations alone (Gate 2)", async () => {
		const opened = await open(spec)
		const rewrite = (root: string): PartContributor => ({
			async contribute(parts) {
				const xml = decoder.decode(await opened.pkg.opc.read("word/comments.xml")).replace(OLD, root)

				parts.replace("word/comments.xml", new TextEncoder().encode(xml))
			}
		})
		const declared =
			'<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" w:foo="1" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"' +
			' xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="w14">'

		expect(await refusal(opened, [rewrite(declared)])).toBeUndefined()
		expect(await refusal(opened, [rewrite(OLD.replace('w:foo="1"', 'w:foo="2"'))])).toEqual({
			reason: "content",
			message: "word/comments.xml: its root's w:foo changed"
		})
		expect(await refusal(opened, [rewrite(OLD.replace(">", ' xmlns:x="urn:x">'))])).toEqual({
			reason: "content",
			message: "word/comments.xml: its root's xmlns:x changed"
		})
		expect(await refusal(opened, [rewrite(`<w:comments ${NAMESPACES}>`)])).toMatchObject({ reason: "content" })
	})
})

describe("comments: revertible units", () => {
	it("takes back only the comment the writer refuses", async () => {
		const opened = await open(PLAIN)
		const { editor } = opened

		select(editor, 1, 4)
		await editor.execute({ type: "comment.add", text: "good" })
		select(editor, 9, 14)
		await editor.execute({ type: "comment.add", text: "bad" })

		const body = editor.body.session
		const refers = (doc: ProseMirrorNode | undefined, id: string): boolean => {
			let found = false

			doc?.descendants(node => {
				if (node.type === nodes.comment_ref && node.attrs["id"] === id) found = true

				return !found
			})

			return found
		}
		expect(COMMENT_UNITS.edited(body)).toEqual([0, 1])
		expect(refers(COMMENT_UNITS.withReverted(body, [1]).state.doc, "1")).toBe(false)
		expect(refers(COMMENT_UNITS.withReverted(body, [1]).state.doc, "0")).toBe(true)
		expect(refers(body.state.doc, "1")).toBe(true)

		// The search finds a set the writer accepts (blocks are tried first, see unsavable.ts).
		const found = await findUnsavableBlocks(
			editor.sessions,
			async sessions => !refers(sessions.find(session => session.story.story === body.story.story)?.state.doc, "1")
		)

		expect(found?.flatMap(entry => entry.units)).toEqual([{ kind: "comment", key: 1 }])

		expect(COMMENT_UNITS.revert(body, [1])).toBe(1)
		expect(refers(body.state.doc, "0")).toBe(true)
		expect(refers(body.state.doc, "1")).toBe(false)
		expect(Object.keys(commentRecords(body.state.doc))).toEqual([])
		expect((await reopenComments(await save(opened))).map(comment => comment.text)).toEqual(["good"])
	})
})

// Positions of the first comment anchor and after the last of a story's document.
function anchorSpan(doc: ProseMirrorNode): { from: number; to: number } {
	let from = -1
	let to = -1

	doc.descendants((node, pos) => {
		if (node.type === nodes.comment_ref || (node.type === nodes.marker && String(node.attrs["kind"]).startsWith("comment"))) {
			if (from < 0) from = pos
			to = pos + 1
		}

		return true
	})

	return { from, to }
}

function countIn(text: string | undefined, part: string): number {
	return (text ?? "").split(part).length - 1
}

describe("comments: deleting a reply that has replies", () => {
	it("re-parents its replies to the thread's first comment, in the session and in commentsExtended", async () => {
		const opened = await open(CHAIN)
		const store = docxComments(opened.editor)
		const shape = () => store.threads().map(thread => [thread.id, thread.replies.map(reply => reply.id)])

		expect(shape()).toEqual([["0", ["1", "2", "3"]]])
		expect(await opened.editor.execute({ type: "comment.delete", id: "1" })).toBe(true)
		expect(shape()).toEqual([["0", ["2", "3"]]])

		const bytes = await save(opened)

		expect(await parents(bytes)).toEqual([
			["00000001", "-"],
			["00000003", "00000001"],
			["00000004", "00000001"]
		])
		expect((await reopenComments(bytes)).map(comment => [comment.id, comment.parent, comment.done])).toEqual([
			["0", undefined, false],
			["2", "0", false],
			["3", "0", true]
		])
	})

	it("refuses a save that leaves a reply answering a comment it removed (Gate 2)", async () => {
		const opened = await open(CHAIN)

		await opened.editor.execute({ type: "comment.delete", id: "1" })

		// The family as a writer that only drops the removed comment's entry would write it.
		const stale = new TextEncoder().encode(
			(CHAIN.commentsExtended ?? "").replace('<w15:commentEx w15:paraId="00000002" w15:paraIdParent="00000001" w15:done="0"/>', "")
		)
		const dangling: PartContributor = {
			...commentParts,
			async contribute(parts, written) {
				const replace = parts.replace.bind(parts)

				parts.replace = (name, bytes) => replace(name, name === "word/commentsExtended.xml" ? stale : bytes)
				await commentParts.contribute?.(parts, written)
			}
		}

		expect(await refusal(opened, [dangling])).toEqual({
			reason: "danglingReference",
			message: "commentsExtended: 00000003 replies to paragraph 00000002, which the save removed"
		})
	})
})

// The root's anchors deleted alone (raw steps, as keys typed and deleted around adjacent anchors can leave it).
function dropAnchors(editor: PagedEditor, id: string): void {
	const doc = editor.session.state.doc
	const tr = editor.session.state.tr
	const at: number[] = []

	doc.descendants((node, pos) => {
		if ((node.type === nodes.marker || node.type === nodes.comment_ref) && node.attrs["id"] === id) at.push(pos)

		return true
	})

	for (const pos of at.reverse()) tr.delete(pos, pos + 1)

	expect(editor.session.dispatch(tr)).toBe(true)
}

describe("comments: a reply whose thread's first comment lost its anchors", () => {
	it("is a thread of its own in the list and in the file, and every save goes on", async () => {
		const opened = await open(PLAIN)
		const { editor } = opened
		const store = docxComments(editor)

		select(editor, 1, 4)
		expect(await editor.execute({ type: "comment.add", text: "Root" })).toBe(true)

		const root = store.threads()[0]?.id ?? ""

		expect(await editor.execute({ type: "comment.reply", id: root, text: "Reply" })).toBe(true)

		const reply = store.threads()[0]?.replies[0]?.id ?? ""

		dropAnchors(editor, root)
		expect(store.threads().map(thread => [thread.id, thread.replies.length])).toEqual([[reply, 0]])

		const bytes = await save(opened)

		expect((await parents(bytes)).map(([, parent]) => parent)).toEqual(["-"])
		expect((await reopenComments(bytes)).map(comment => [comment.id, comment.parent, comment.text])).toEqual([
			[reply, undefined, "Reply"]
		])

		// Undone, the thread is whole again, in the list and in the file (the reply still records its parent).
		expect(await editor.execute({ type: "history.undo" })).toBe(true)
		expect(store.threads().map(thread => [thread.id, thread.replies.map(item => item.id)])).toEqual([[root, [reply]]])

		const whole = await parents(await save(opened))

		expect(whole.map(([, parent]) => parent)).toEqual(["-", whole[0]?.[0]])
	})

	it("answers no comment of the file the save removes, a reply added to a source thread", async () => {
		const opened = await open(W2013)
		const { editor } = opened

		expect(await editor.execute({ type: "comment.reply", id: "0", text: "New reply" })).toBe(true)
		dropAnchors(editor, "0")

		const bytes = await save(opened)

		// The source reply and the new one each a thread of their own; comment 0 and its entry gone.
		expect(await parents(bytes)).toEqual([
			["22222222", "-"],
			[expect.stringMatching(/^[0-9A-F]{8}$/), "-"]
		])
		expect((await reopenComments(bytes)).map(comment => [comment.id, comment.parent])).toEqual([
			["1", undefined],
			["2", undefined]
		])
	})
})

describe("comments: the last paragraph keeps the comment's paragraph id", () => {
	async function edited(how: "after" | "split"): Promise<Uint8Array> {
		const opened = await open(W2013)
		const story = opened.context.model.stories.find(candidate => candidate.kind === "comment" && candidate.id === "0")
		const session = story === undefined ? undefined : opened.editor.storySession(story.index)

		if (session === undefined) throw new Error("no comment session")

		const tr = session.state.tr
		const size = session.state.doc.content.size

		if (how === "after") tr.insert(size, nodes.paragraph.create(null, docxSchema.text("Added")))
		else tr.split(size - 2)

		expect(session.dispatch(tr)).toBe(true)

		return save(opened)
	}

	const paraIds = async (bytes: Uint8Array): Promise<(string | undefined)[]> => {
		const comment = /<w:comment w:id="0"[^>]*>(.*?)<\/w:comment>/.exec((await read(bytes, "word/comments.xml")) ?? "")?.[1] ?? ""

		return [...comment.matchAll(/<w:p(?: w14:paraId="([0-9A-F]{8})")?>/g)].map(match => match[1])
	}

	it("moves it to a paragraph added after it, the thread kept in commentsExtended", async () => {
		const bytes = await edited("after")
		const ids = await paraIds(bytes)

		expect(ids).toHaveLength(2)
		expect(ids[1]).toBe("11111111")
		expect(ids[0]).toMatch(/^[0-9A-F]{8}$/)
		expect(ids[0]).not.toBe("11111111")
		expect(await parents(bytes)).toEqual([
			["11111111", "-"],
			["22222222", "11111111"]
		])
		expect((await reopenComments(bytes)).map(item => [item.id, item.parent])).toEqual([
			["0", undefined],
			["1", "0"]
		])
	})

	it("points the comment's entries, and its replies', at a new id its last paragraph was given", async () => {
		const opened = await open(W2013)
		const story = opened.context.model.stories.find(candidate => candidate.kind === "comment" && candidate.id === "0")
		const session = story === undefined ? undefined : opened.editor.storySession(story.index)

		if (session === undefined) throw new Error("no comment session")

		const last = session.state.doc.lastChild

		if (last === null) throw new Error("no paragraph")

		const at = session.state.doc.content.size - last.nodeSize

		expect(session.dispatch(markInternal(session.state.tr.addNodeMark(at, docxSchema.marks.para_id.create({ id: "3ABCDEF0" }))))).toBe(
			true
		)

		const bytes = await save(opened)

		expect(await paraIds(bytes)).toEqual(["3ABCDEF0"])
		expect(await parents(bytes)).toEqual([
			["3ABCDEF0", "-"],
			["22222222", "3ABCDEF0"]
		])
	})

	// MS-DOCX 2.5.3.1: commentsExtended (and commentsIds) key on the comment's last paragraph.
	it("moves it to the second half of a split, the first half taking a new one", async () => {
		const bytes = await edited("split")
		const ids = await paraIds(bytes)

		expect(ids).toHaveLength(2)
		expect(ids[1]).toBe("11111111")
		expect(ids[0]).toMatch(/^[0-9A-F]{8}$/)
		expect(ids[0]).not.toBe("11111111")
		expect(await parents(bytes)).toEqual([
			["11111111", "-"],
			["22222222", "11111111"]
		])
	})
})

describe("comments: people", () => {
	// A revision's author compared as it reads, however the file writes it (an apostrophe as is, a character
	// reference): its person stays.
	// Only attributes of start tags name authors: author= in an XML comment (where a raw & is legal) or in text.
	it.each([
		["an XML comment holding a raw ampersand", '<!-- author="a & b" -->'],
		["text with an apostrophe after it", '<w:p><w:r><w:t xml:space="preserve">the author=\'s note</w:t></w:r></w:p>']
	])("reads revision authors past author= in %s", async (_name, stray) => {
		const opened = await open({
			...W2013,
			body:
				W2013.body +
				stray +
				'<w:p><w:ins w:id="9" w:author="Ed" w:date="2020-01-03T00:00:00Z"><w:r><w:t>Added</w:t></w:r></w:ins></w:p>',
			people: (W2013.people ?? "").replace("</w15:people>", '<w15:person w15:author="Ed"/></w15:people>')
		})
		const session = opened.editor.session

		session.dispatch(session.state.tr.insertText("Typed ", 1))

		expect((await read(await save(opened), "word/people.xml")) ?? "").toContain('w15:author="Ed"')
	})

	it.each([
		["an apostrophe written as is", "Di O'Hara", "Di O'Hara"],
		["a character reference", "Jos&#233;", "José"]
	])("keeps the person of a tracked change's author written with %s", async (_name, written, author) => {
		const opened = await open({
			...W2013,
			body:
				W2013.body +
				`<w:p><w:del w:id="9" w:author="${written}" w:date="2020-01-03T00:00:00Z"><w:r><w:delText>gone</w:delText></w:r></w:del></w:p>`,
			people: (W2013.people ?? "").replace("</w15:people>", `<w15:person w15:author="${author}"/></w15:people>`)
		})
		const session = opened.editor.session

		session.dispatch(session.state.tr.insertText("Typed ", 1))

		const people = (await read(await save(opened), "word/people.xml")) ?? ""

		expect(people).toContain(`w15:author="${author}"`)
	})

	it("removes the person of an author whose last comment was deleted, keeping the others", async () => {
		const opened = await open(W2013)

		expect(await opened.editor.execute({ type: "comment.delete", id: "1" })).toBe(true)
		expect(await read(await save(opened), "word/people.xml")).toBe(
			'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w15:people xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml">' +
				'<w15:person w15:author="Bo"/></w15:people>'
		)
	})

	it("keeps the person of an author a tracked change still names, and removes it once the change is accepted", async () => {
		const opened = await open({
			...W2013,
			body: W2013.body + '<w:p><w:ins w:id="9" w:author="Cy" w:date="2020-01-03T00:00:00Z"><w:r><w:t>Added</w:t></w:r></w:ins></w:p>'
		})

		expect(await opened.editor.execute({ type: "comment.delete", id: "1" })).toBe(true)
		expect(await read(await save(opened), "word/people.xml")).toContain('w15:author="Cy"')

		expect(await opened.editor.execute({ type: "review.acceptAll" })).toBe(true)
		expect(await read(await save(opened), "word/people.xml")).not.toContain('w15:author="Cy"')
	})

	it("removes a person only a change named once it is rejected, and leaves an unedited file as it was", async () => {
		const spec: SyntheticDocx = {
			...W2013,
			body:
				W2013.body +
				'<w:p><w:r><w:t xml:space="preserve">Kept </w:t></w:r><w:del w:id="9" w:author="Di" w:date="2020-01-03T00:00:00Z"><w:r><w:delText>gone</w:delText></w:r></w:del></w:p>',
			people: (W2013.people ?? "").replace("</w15:people>", '<w15:person w15:author="Di"/></w15:people>')
		}
		const opened = await open(spec)

		expect(await changedParts(opened)).toEqual([])
		editorType(opened.editor)
		expect(await read(await save(opened), "word/people.xml")).toContain('w15:author="Di"')

		expect(await opened.editor.execute({ type: "review.rejectAll" })).toBe(true)

		const people = (await read(await save(opened), "word/people.xml")) ?? ""

		expect(people).not.toContain('w15:author="Di"')
		expect(people).toContain('<w15:person w15:author="Bo"/><w15:person w15:author="Cy"/>')
	})
})

// Typing at the start of the body.
function editorType(editor: PagedEditor): void {
	editor.dispatch(editor.session.state.tr.insertText("Typed ", 1))
}

describe("comments: where one can be added", () => {
	it("adds only in the main document's text; a header's comments still take replies and resolving", async () => {
		const opened = await open({
			body: p("Body text") + '<w:sectPr><w:headerReference w:type="default" r:id="rIdH"/></w:sectPr>',
			headers: {
				rIdH: '<w:p><w:commentRangeStart w:id="7"/><w:r><w:t>Head</w:t></w:r><w:commentRangeEnd w:id="7"/><w:r><w:commentReference w:id="7"/></w:r></w:p>'
			},
			comments: '<w:comment w:id="7" w:author="Bo"><w:p w14:paraId="00000007"><w:r><w:t>c7</w:t></w:r></w:p></w:comment>'
		})
		const { editor } = opened
		const header = opened.context.model.stories.find(story => story.kind === "header")

		expect(editor.enterStory(header?.index ?? -1, -1)).toBe(true)
		select(editor, 2, 4)
		expect(editor.snapshot().enabled["comment.add"]).toBe(false)
		expect(await editor.execute({ type: "comment.add", text: "no" })).toBe(false)
		expect(await editor.execute({ type: "comment.reply", id: "7", text: "yes" })).toBe(true)
		expect(await editor.execute({ type: "comment.resolve", id: "7" })).toBe(true)

		expect(editor.enterStory(editor.body.session.story.story.index, -1)).toBe(true)
		select(editor, 2, 4)
		expect(editor.snapshot().enabled["comment.add"]).toBe(true)
		expect(await editor.execute({ type: "comment.add", text: "body" })).toBe(true)
		expect((await reopenComments(await save(opened))).map(comment => [comment.text, comment.parent, comment.done])).toEqual([
			["c7", undefined, true],
			["yes", "7", true],
			["body", undefined, false]
		])
	})
})

describe("comments: line breaks within a paragraph", () => {
	const BROKEN: SyntheticDocx = {
		...W2013,
		comments:
			'<w:comment w:id="0" w:author="Bo"><w:p><w:r><w:t>one</w:t><w:br/><w:t>two</w:t></w:r></w:p>' +
			'<w:p w14:paraId="11111111"><w:r><w:t>Last</w:t></w:r></w:p></w:comment>' +
			'<w:comment w:id="1" w:author="Cy"><w:p w14:paraId="22222222"><w:r><w:t>Reply</w:t></w:r></w:p></w:comment>'
	}

	it("reads them as U+2028, keeps an untouched paragraph's bytes and writes U+2028 as a break", async () => {
		const opened = await open(BROKEN)
		const store = docxComments(opened.editor)

		expect(store.comment("0")?.text).toBe("one two\nLast")
		expect(await opened.editor.execute({ type: "comment.edit", id: "0", text: "one two\nLast line" })).toBe(true)

		const bytes = await save(opened)
		const xml = (await read(bytes, "word/comments.xml")) ?? ""

		expect(xml).toContain('<w:p><w:r><w:t>one</w:t><w:br/><w:t>two</w:t></w:r></w:p><w:p w14:paraId="11111111">')
		expect(xml).toMatch(/<w:p w14:paraId="11111111"><w:r><w:t>Last<\/w:t><w:br\/><w:t>line<\/w:t><\/w:r><\/w:p>/)
		expect((await reopenComments(bytes))[0]?.text).toBe("one two\nLast line")
	})

	it("writes them in a new comment", async () => {
		const opened = await open(PLAIN)

		select(opened.editor, 1, 4)
		expect(await opened.editor.execute({ type: "comment.add", text: "a b" })).toBe(true)

		const bytes = await save(opened)

		expect(await read(bytes, "word/comments.xml")).toContain("<w:t>a</w:t><w:br/><w:t>b</w:t>")
		expect((await reopenComments(bytes))[0]?.text).toBe("a b")
	})
})

describe("comments: dates", () => {
	it.each([
		["UTC", "2026-10-12T10:30:00Z"],
		["Europe/Berlin", "2026-10-12T12:30:00Z"],
		["America/New_York", "2026-10-12T06:30:00Z"]
	])("writes w:date as %s wall-clock time with a Z, as Word does, and w16cex:dateUtc in UTC", async (zone, local) => {
		vi.stubEnv("TZ", zone)

		const opened = await open(W2019)
		const { editor } = opened
		const second = editor.session.state.doc.child(0).nodeSize

		select(editor, second + 1, second + 7)
		expect(await editor.execute({ type: "comment.add", text: "New" })).toBe(true)
		expect(docxComments(editor).comment("2")).toMatchObject({ date: local, dateUtc: "2026-10-12T10:30:00Z" })

		const bytes = await save(opened)

		expect(await read(bytes, "word/comments.xml")).toContain(
			`<w:comment w:id="2" w:author="Ann Lee" w:date="${local}" w:initials="AL">`
		)
		expect(await read(bytes, "word/commentsExtensible.xml")).toMatch(
			/w16cex:durableId="[0-9A-F]{8}" w16cex:dateUtc="2026-10-12T10:30:00Z"\/>/
		)
	})

	it("tells a source comment's UTC date where commentsExtensible has it", async () => {
		const opened = await open(W2019)

		expect(docxComments(opened.editor).comment("1")).toMatchObject({ date: "2020-01-02T00:00:00Z", dateUtc: "2020-01-02T00:00:00Z" })
		expect(docxComments((await open(W2013)).editor).comment("1")?.dateUtc).toBeUndefined()
	})
})

describe("comments: deleting the text they comment on", () => {
	it("deletes the comments whose ranges and references a deletion takes, from every part, until undone", async () => {
		const opened = await open(W2019)
		const session = opened.editor.session
		const { from, to } = anchorSpan(session.state.doc)

		session.dispatch(session.state.tr.delete(from, to))
		expect(docxComments(opened.editor).threads()).toEqual([])

		const bytes = await save(opened)

		expect(await read(bytes, "word/comments.xml")).not.toContain("<w:comment ")
		expect(await read(bytes, "word/commentsExtended.xml")).not.toContain("commentEx ")
		expect(await read(bytes, "word/commentsIds.xml")).not.toContain("commentId ")
		expect(await read(bytes, "word/commentsExtensible.xml")).not.toContain("commentExtensible ")
		expect(await reopenComments(bytes)).toEqual([])

		expect(await opened.editor.execute({ type: "history.undo" })).toBe(true)
		expect(await changedParts(opened)).toEqual([])
	})

	it("keeps a comment whose text alone is deleted", async () => {
		const opened = await open(W2013)
		const session = opened.editor.session
		const { from, to } = anchorSpan(session.state.doc)

		// Inside the range: the commented text, not the markers.
		session.dispatch(session.state.tr.delete(from + 2, to - 4))
		expect((await reopenComments(await save(opened))).map(comment => [comment.id, comment.anchored])).toEqual([
			["0", true],
			["1", true]
		])
	})

	it("keeps comments a tracked deletion takes until the deletion is accepted", async () => {
		const opened = await open(W2013)
		const { editor } = opened
		const session = editor.session
		const { from, to } = anchorSpan(session.state.doc)

		expect(await editor.execute({ type: "review.track", on: true })).toBe(true)
		session.dispatch(session.state.tr.delete(from - 2, to + 2))
		expect(
			docxComments(editor)
				.threads()
				.map(thread => thread.id)
		).toEqual(["0"])
		expect((await reopenComments(await save(opened))).map(comment => [comment.id, comment.anchored])).toEqual([
			["0", true],
			["1", true]
		])

		expect(await editor.execute({ type: "review.acceptAll" })).toBe(true)
		expect(docxComments(editor).threads()).toEqual([])
		expect(await reopenComments(await save(opened))).toEqual([])
	})

	it("deletes a comment on own inserted text with it, rejected or deleted for real while tracking", async () => {
		for (const how of ["reject", "delete", "delete with other text"] as const) {
			const opened = await open(PLAIN)
			const { editor } = opened
			const session = editor.session

			expect(await editor.execute({ type: "review.track", on: true })).toBe(true)
			session.dispatch(session.state.tr.insertText("XYZ ", 5))
			select(editor, 6, 7)
			expect(await editor.execute({ type: "comment.add", text: "on Y" })).toBe(true)
			expect(docxComments(editor).threads()).toHaveLength(1)

			const span = anchorSpan(session.state.doc)

			if (how === "reject") expect(await editor.execute({ type: "review.rejectAll" })).toBe(true)
			else session.dispatch(session.state.tr.delete(how === "delete" ? span.from - 1 : 2, span.to + 1))

			expect(docxComments(editor).threads(), how).toEqual([])
			expect(await reopenComments(await save(opened)), how).toEqual([])
		}
	})

	it("deletes a comment on exactly the author's own insertion with it, rejected or deleted while tracking", async () => {
		for (const how of ["reject", "delete"] as const) {
			for (const at of [6, 11]) {
				const opened = await open({ body: p("alpha beta") + p("next") })
				const { editor } = opened
				const session = editor.session

				expect(await editor.execute({ type: "review.track", on: true })).toBe(true)
				select(editor, at)
				session.dispatch(session.state.tr.insertText(" NEWTEXT"))
				select(editor, at, at + 8)
				expect(await editor.execute({ type: "comment.add", text: "on the insertion" })).toBe(true)

				// The anchors stand next to the insertion, outside it.
				const span = anchorSpan(session.state.doc)

				expect([span.from, span.to - 3]).toEqual([at, at + 8])

				if (how === "reject") expect(await editor.execute({ type: "review.rejectAll" })).toBe(true)
				else {
					select(editor, at + 1, at + 9)
					session.dispatch(session.state.tr.deleteSelection())
				}

				expect(docxComments(editor).threads(), `${how} ${String(at)}`).toEqual([])
				expect(session.state.doc.child(0).textContent).toBe("alpha beta")
				expect(await reopenComments(await save(opened))).toEqual([])
			}
		}
	})

	it("deletes a source comment on the author's own inserted text when that text is deleted while tracking", async () => {
		for (const wider of [false, true]) {
			const opened = await open({
				body:
					'<w:p><w:r><w:t xml:space="preserve">one </w:t></w:r><w:ins w:id="9" w:author="Ann Lee" w:date="2026-01-01T00:00:00Z"><w:r><w:t>X</w:t></w:r></w:ins>' +
					'<w:commentRangeStart w:id="0"/><w:ins w:id="10" w:author="Ann Lee" w:date="2026-01-01T00:00:00Z"><w:r><w:t>Y</w:t></w:r></w:ins><w:commentRangeEnd w:id="0"/>' +
					'<w:ins w:id="11" w:author="Ann Lee" w:date="2026-01-01T00:00:00Z"><w:r><w:commentReference w:id="0"/></w:r><w:r><w:t>Z</w:t></w:r></w:ins>' +
					'<w:r><w:t xml:space="preserve"> two</w:t></w:r></w:p>',
				comments: W2013.comments ?? ""
			})
			const { editor } = opened
			const session = editor.session
			const span = anchorSpan(session.state.doc)

			expect(await editor.execute({ type: "review.track", on: true })).toBe(true)
			session.dispatch(session.state.tr.delete(wider ? 2 : span.from - 1, span.to + 1))
			expect(docxComments(editor).threads(), String(wider)).toEqual([])
		}
	})

	it("leaves out a comment's anchors pasted into a story the comment is not in", async () => {
		const header =
			'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
			p("Head text") +
			"</w:hdr>"
		const opened = await open({
			...W2013,
			body: `${W2013.body}<w:sectPr><w:headerReference w:type="default" r:id="rIdH"/></w:sectPr>`,
			parts: [
				{
					name: "word/header1.xml",
					contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml",
					data: header
				}
			],
			relationships: [{ id: "rIdH", type: "header", target: "header1.xml" }]
		})
		const { editor } = opened
		const body = editor.session
		const { from, to } = anchorSpan(body.state.doc)
		const slice = body.state.doc.slice(from - 2, to + 2)
		const story = opened.context.model.stories.findIndex(item => item.kind === "header")

		expect(editor.enterStory(story, 0)).toBe(true)

		const session = editor.session

		session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, 3)).replaceSelection(slice))
		expect(anchorSpan(session.state.doc).from).toBe(-1)
		expect(session.state.doc.textContent).toContain("beta")

		const bytes = await save(opened)

		expect(await read(bytes, "word/header1.xml")).not.toContain("comment")
		expect((await reopenComments(bytes)).map(comment => [comment.id, comment.anchored])).toEqual([
			["0", true],
			["1", true]
		])
	})

	it("keeps a comment that starts in a rejected inserted row, shortened to what stays", async () => {
		const cell = (text: string): string => `<w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/></w:tcPr>${p(text)}</w:tc>`
		const opened = await open({
			body:
				'<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="3000"/></w:tblGrid>' +
				`<w:tr>${cell("first")}</w:tr></w:tbl>` +
				p("after the table")
		})
		const { editor } = opened
		const session = editor.session

		expect(await editor.execute({ type: "review.track", on: true })).toBe(true)
		select(editor, 4)
		expect(await editor.execute({ type: "table.row.insertBelow" })).toBe(true)
		session.dispatch(session.state.tr.insertText("new row", 13))
		select(editor, 14, session.state.doc.content.size - 3)
		expect(await editor.execute({ type: "comment.add", text: "across" })).toBe(true)
		expect(await editor.execute({ type: "review.rejectAll" })).toBe(true)
		expect(
			docxComments(editor)
				.threads()
				.map(thread => thread.id)
		).toHaveLength(1)
		expect((await reopenComments(await save(opened))).map(comment => comment.anchored)).toEqual([true])
	})

	it("leaves out a comment's anchors copied from one footnote into another", async () => {
		const opened = await open(NOTED)
		const { editor, context } = opened
		const notes = context.model.stories.flatMap((story, index) =>
			story.kind === "footnote" && story.id !== undefined && Number(story.id) > 0 ? [index] : []
		)

		expect(editor.enterStory(notes[0] ?? -1, 0)).toBe(true)

		const { from, to } = anchorSpan(editor.session.state.doc)
		const slice = editor.session.state.doc.slice(from - 2, to)

		expect(editor.enterStory(notes[1] ?? -1, 0)).toBe(true)

		const session = editor.session

		session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, 3)).replaceSelection(slice))
		expect(anchorSpan(session.state.doc).from).toBe(-1)
		expect(session.state.doc.textContent).toContain("ed")

		const bytes = await save(opened)

		expect((await reopenComments(bytes)).map(comment => [comment.id, comment.anchored])).toEqual([["5", true]])
	})

	it("keeps a comment whose range end alone a cut takes, and saves the pasted text without a new end", async () => {
		const opened = await open(W2013)
		const session = opened.editor.session
		let end = -1

		session.state.doc.descendants((node, pos) => {
			if (node.type === nodes.marker && node.attrs["kind"] === "commentRangeEnd" && end < 0) end = pos

			return end < 0
		})

		const slice = session.state.doc.slice(end - 2, end + 2)

		session.dispatch(session.state.tr.delete(end - 2, end + 2))

		const at = session.state.doc.content.size - 1

		session.dispatch(session.state.tr.replace(at, at, slice))
		expect(await refusal(opened)).toBeUndefined()
		expect((await reopenComments(await save(opened))).map(comment => [comment.id, comment.anchored])).toEqual([
			["0", true],
			["1", true]
		])
	})

	it("moves comments cut and pasted back, and a copy pasted again takes no id twice", async () => {
		const opened = await open(W2019)
		const session = opened.editor.session
		const { from, to } = anchorSpan(session.state.doc)
		const slice = session.state.doc.slice(from, to)

		session.dispatch(session.state.tr.delete(from, to))

		const end = session.state.doc.content.size - 1

		session.dispatch(session.state.tr.replace(end, end, slice))
		expect(
			docxComments(opened.editor)
				.threads()
				.map(thread => [thread.id, thread.replies.map(reply => reply.id)])
		).toEqual([["0", ["1"]]])
		// The range went with the text.
		expect(docxComments(opened.editor).anchor("0")?.from).toBeGreaterThan(session.state.doc.child(0).nodeSize)
		expect(textOf(opened.editor, docxComments(opened.editor).anchor("1"))).toBe("beta")

		const moved = await save(opened)

		expect((await reopenComments(moved)).map(comment => [comment.id, comment.text, comment.anchored])).toEqual([
			["0", "First", true],
			["1", "Reply", true]
		])
		expect(await read(moved, "word/commentsIds.xml")).toBe(await read(buildDocx(W2019), "word/commentsIds.xml"))

		session.dispatch(session.state.tr.replace(1, 1, slice))

		const copied = (await read(await save(opened), "word/document.xml")) ?? ""

		expect([countIn(copied, '<w:commentReference w:id="0"/>'), countIn(copied, '<w:commentRangeStart w:id="1"/>')]).toEqual([1, 1])
	})
})

const COMMENT_FILES = [
	"docx/oxsdk__Comment025.docx",
	"docx/oxsdk__Comment028.docx",
	"docx/oxsdk__Comment033.docx",
	"docx/oxsdk__Comment045.docx",
	"docm/oxsdk__Comment061.docm",
	"dotm/oxsdk__Comment063.dotm",
	"dotx/oxsdk__Comment064.dotx",
	"docx/lo__redline-range-comment.docx",
	"docx/lo__tdf61000.docx",
	"docx/lo__wDateValueFormat.docx",
	"docx/docx4j__loadAndSave.docx",
	"docx/oxpt__HC031-Complicated-Document.docx",
	"docx/oxsdk__Invalid_Word15Comments.docx",
	"docx/oxpt__CA009-altChunk.docx"
]

// Files of COMMENT_FILES that open for editing and reach every assertion (measured on the corpus).
const COMMENT_FILES_REACHED = 14
let commentFilesReached = 0

describe.skipIf(!existsSync(join(CORPUS_DIR, "docx")))("comments over the corpus", () => {
	it.for(COMMENT_FILES)(
		"adds, replies, resolves and deletes in %s through Gate 2, and reads it back",
		{ timeout: 120_000 },
		async (file, context) => {
			const path = join(CORPUS_DIR, file)

			if (!existsSync(path)) return context.skip(`${file} is not in the corpus`)

			const opened = await open(new Uint8Array(readFileSync(path)))
			const { editor } = opened

			if (editor.body.session.readOnly) return context.skip(`${file} opens read-only`)

			const store = docxComments(editor)
			const before = store.threads()
			const body = editor.body.session.story.story.index
			let at = -1

			editor.session.state.doc.descendants((node, pos) => {
				if (at < 0 && node.isText) at = pos + 1

				return at < 0
			})
			select(editor, at)
			expect(await editor.execute({ type: "comment.add", text: "Added\ncomment" })).toBe(true)

			const added = store.threads().find(thread => thread.comment.added)?.id ?? ""
			const canReply = store.comment(added)?.canReply === true

			expect(await editor.execute({ type: "comment.reply", id: added, text: "A reply" })).toBe(canReply)

			const resolving = before.find(thread => thread.comment.canResolve && !thread.done && thread.comment.story === body)
			const deleting = before.find(thread => thread !== resolving && thread.comment.canDelete && thread.comment.story === body)

			if (resolving !== undefined) expect(await editor.execute({ type: "comment.resolve", id: resolving.id })).toBe(true)
			if (deleting !== undefined) expect(await editor.execute({ type: "comment.delete", id: deleting.id })).toBe(true)

			const reopened = await reopenComments(await save(opened))
			const live = reopened.filter(comment => comment.anchored)
			const made = live.find(comment => comment.text === "Added\ncomment")

			expect(made).toMatchObject({ author: "Ann Lee" })

			if (canReply) expect(live.find(comment => comment.text === "A reply")).toMatchObject({ parent: made?.id })
			if (resolving !== undefined) expect(reopened.find(comment => comment.id === resolving.id)?.done).toBe(true)
			if (deleting !== undefined)
				for (const id of [deleting.id, ...deleting.replies.map(reply => reply.id)])
					expect(
						live.some(comment => comment.id === id),
						id
					).toBe(false)

			// Every other comment reads back as it was.
			for (const comment of before.filter(thread => thread !== deleting).flatMap(thread => [thread.comment, ...thread.replies]))
				expect(reopened.find(candidate => candidate.id === comment.id)?.text, comment.id).toBe(comment.text)

			commentFilesReached++
		}
	)

	it("reaches the assertions in every file that should", () => {
		expect(commentFilesReached).toBeGreaterThanOrEqual(COMMENT_FILES_REACHED)
	})
})

const REPARENT_FILES = [
	"docm/oxsdk__Comment061.docm",
	"dotm/oxsdk__Comment063.dotm",
	"dotx/oxsdk__Comment064.dotx",
	"docx/oxsdk__Invalid_Word15Comments.docx"
]
// Files of REPARENT_FILES with a reply that has replies, open for editing (measured on the corpus).
const REPARENT_FILES_REACHED = 4
let reparentFilesReached = 0

describe.skipIf(!existsSync(join(CORPUS_DIR, "docx")))("comments over the corpus: replies to deleted replies", () => {
	it.for(REPARENT_FILES)("re-parents the replies of a deleted reply in %s", { timeout: 120_000 }, async (file, context) => {
		const path = join(CORPUS_DIR, file)

		if (!existsSync(path)) return context.skip(`${file} is not in the corpus`)

		const opened = await open(new Uint8Array(readFileSync(path)))
		const comments = opened.context.model.comments
		const middle = comments.find(
			comment => comment.parentId !== undefined && comments.some(other => other.parentId === comment.id && other.anchor >= 0)
		)

		if (middle === undefined) return context.skip(`${file} has no reply with replies`)
		if (opened.editor.body.session.readOnly) return context.skip(`${file} opens read-only`)

		const root = middle.parentId ?? ""
		const children = comments.filter(comment => comment.parentId === middle.id).map(comment => comment.id)

		expect(await opened.editor.execute({ type: "comment.delete", id: middle.id })).toBe(true)

		const bytes = await save(opened)
		const written = await parents(bytes)
		const paraIds = new Set(written.map(([paraId]) => paraId))

		for (const [, parent] of written) if (parent !== "-") expect(paraIds.has(parent ?? ""), parent).toBe(true)

		const reopened = await reopenComments(bytes)

		expect(reopened.some(comment => comment.id === middle.id)).toBe(false)
		for (const id of children) expect(reopened.find(comment => comment.id === id)?.parent, id).toBe(root)

		reparentFilesReached++
	})

	it("reaches the assertions in every file that should", () => {
		expect(reparentFilesReached).toBeGreaterThanOrEqual(REPARENT_FILES_REACHED)
	})
})

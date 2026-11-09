import { Fragment, Slice, type Node } from "prosemirror-model"
import { describe, expect, it } from "vitest"
import { bytesSource, OpcPackage, Relationships } from "@filen/office/core/opc"
import { encodeUtf8, parseXml } from "@filen/office/core/xml"
import { DocxEditorSession, docxSchema, type NewStoryKind, type StoryDoc } from "@filen/office/core/docx/edit"
import type { Story } from "@filen/office/core/docx"
import {
	DocxVerifyError,
	saveDocx,
	serializeDocx,
	StoryWriter,
	verifyDocxParts,
	writerProof,
	zipDocxSave,
	type DocxCheck,
	type PartContributor,
	type WriteEnvironment
} from "@filen/office/core/docx/write"
import { ModelTables, buildPart } from "../core/docx/model/index"
import { partReader } from "../core/docx/model/reader"
import { openBytes, openSpec, type Opened } from "./docxEditFixtures"
import { NAMESPACES, buildDocx, p } from "./docxSynthetic"
import { pagedEditor } from "./pagedFixtures"

const decoder = new TextDecoder()
const nodes = docxSchema.nodes
const marks = docxSchema.marks

function env(document: Opened): WriteEnvironment {
	return { context: document.context, nextRevisionId: () => 100, numId: id => id, hyperlink: () => "rId100" }
}

function session(document: Opened): DocxEditorSession {
	return new DocxEditorSession(document.context, { proof: writerProof(document.context) })
}

async function read(bytes: Uint8Array, name: string): Promise<string> {
	return decoder.decode(await (await OpcPackage.open(bytesSource(bytes))).read(name))
}

// The body with its first paragraph's content replaced by `content`.
function withFirst(doc: Node, content: readonly Node[]): Node {
	const first = doc.child(0)

	return doc.replace(0, first.nodeSize, new Slice(Fragment.from(first.copy(Fragment.fromArray([...content]))), 0, 0))
}

// `doc` with the first node `pick` accepts replaced by `change(node)`.
function changeFirst(doc: Node, pick: (node: Node) => boolean, change: (node: Node) => Node): Node {
	let at = -1
	let found: Node | undefined

	doc.descendants((node, pos) => {
		if (found !== undefined) return false
		if (pick(node)) {
			found = node
			at = pos

			return false
		}

		return true
	})

	if (found === undefined) throw new Error("Nothing to change")

	return doc.replace(at, at + found.nodeSize, new Slice(Fragment.from(change(found)), 0, 0))
}

// What writing `doc` as the story of `edit` throws (reason and message), or undefined.
function writeError(document: Opened, edit: DocxEditorSession, doc: Node): unknown {
	try {
		new StoryWriter(env(document), edit.story).writeStory(doc)

		return undefined
	} catch (error) {
		const { reason, message } = error as { reason?: unknown; message?: unknown }

		return { reason, message }
	}
}

async function refusal(save: Promise<unknown>): Promise<unknown> {
	return save.then(
		() => undefined,
		(error: unknown) => {
			const { reason, message } = error as { reason?: unknown; message?: unknown }

			return { reason, message }
		}
	)
}

const COMMENTS = '<w:comment w:id="0" w:author="Ann" w:initials="A"><w:p><w:r><w:t>first comment</w:t></w:r></w:p></w:comment>'
const BODY =
	'<w:p><w:commentRangeStart w:id="0"/><w:r><w:t>commented text</w:t></w:r><w:commentRangeEnd w:id="0"/>' +
	'<w:r><w:commentReference w:id="0"/></w:r></w:p>' +
	p("second paragraph")

async function withComments(): Promise<Opened & { bytes: Uint8Array }> {
	const bytes = buildDocx({ body: BODY, comments: COMMENTS })

	return { ...(await openBytes(bytes)), bytes }
}

// A story the editor added (context.newStories), holding `text`: on `part`, item -1.
function addedStory(document: Opened, kind: NewStoryKind, id: string | undefined, part: StoryDoc["part"], text: string): StoryDoc {
	const story: Story = {
		index: document.model.stories.length + document.context.newStories.size,
		kind,
		part: part.index,
		item: -1,
		id,
		noteType: kind === "footnote" || kind === "endnote" ? "normal" : undefined,
		parent: -1,
		owner: -1
	}
	const doc = nodes.doc.create({ story: story.index }, nodes.paragraph.create(null, docxSchema.text(text)))

	document.context.newStories.set(story, { kind, id, target: part.name })

	return { doc, story, part, pristine: new WeakSet(), stats: { paragraphs: 1, tables: 0, lockedBlocks: 0, lockReasons: {} } }
}

// The story part of an existing comments part.
function commentsPart(document: Opened): StoryDoc["part"] {
	const existing = document.model.stories.find(story => story.kind === "comment")
	const part = existing === undefined ? undefined : document.model.parts[existing.part]

	if (part === undefined) throw new Error("No comments part")

	return part
}

// A part the package does not have yet, from minimal markup (what the editor builds a new story against).
function templatePart(document: Opened, name: string, xml: string): StoryDoc["part"] {
	return buildPart(partReader(parseXml(encodeUtf8(xml))), new ModelTables(), document.model.parts.length, name, new Relationships([]))
}

// Stands in for the editing session of a story no session can open yet.
function storySession(story: StoryDoc, doc: Node = story.doc): DocxEditorSession {
	return { readOnly: false, story, state: { doc }, newLists: new Map(), missingStyles: new Map() } as unknown as DocxEditorSession
}

// Places new comments at `at` (given the part and its root) and says every added story is referenced.
function comments(at: (part: StoryDoc["part"], root: number) => number, id = "7"): PartContributor {
	return {
		references: () => true,
		container(story) {
			if (story.story.item >= 0 || story.story.kind !== "comment") return undefined

			return {
				open: `<w:comment w:id="${id}" w:author="Bo" w:initials="B">`,
				close: "</w:comment>",
				at: at(story.part, story.part.document.documentElement())
			}
		}
	}
}

const END = (part: StoryDoc["part"], root: number): number => part.document.contentEnd(root)
const FIRST = (part: StoryDoc["part"], root: number): number => part.document.start(part.document.firstChildElement(root))

describe("docx writer extension points: new elements", () => {
	it("refuses new atoms, markers and wrappers it has no writer for, as it always did", async () => {
		const document = await openSpec({ body: p("hello world") })
		const edit = session(document)
		const doc = edit.state.doc
		const write = (changed: Node): unknown => {
			try {
				new StoryWriter(env(document), edit.story).writeStory(changed)

				return undefined
			} catch (error) {
				const { reason, message } = error as { reason?: unknown; message?: unknown }

				return { reason, message }
			}
		}
		expect(write(withFirst(doc, [nodes.math.create()]))).toEqual({ reason: "missingSource", message: "A new math" })
		expect(write(withFirst(doc, [nodes.drawing.create()]))).toEqual({ reason: "missingSource", message: "A new drawing" })
		expect(write(withFirst(doc, [nodes.comment_ref.create()]))).toEqual({
			reason: "missingSource",
			message: "A new comment reference without an id"
		})
		expect(write(withFirst(doc, [nodes.note_ref.create({ kind: "endnote" })]))).toEqual({
			reason: "missingSource",
			message: "A new endnote reference without an id"
		})
		expect(write(withFirst(doc, [nodes.marker.create({ kind: "bookmarkStart", id: "5" })]))).toEqual({
			reason: "missingSource",
			message: "A new marker"
		})
		expect(write(withFirst(doc, [docxSchema.text("tracked", [marks.insertion.create()])]))).toEqual({
			reason: "missingSource",
			message: "A new insertion wrapper"
		})

		const first = doc.child(0)
		const marked = doc.replace(
			0,
			first.nodeSize,
			new Slice(
				Fragment.from(first.type.create({ ...first.attrs, before: [{ src: -1, kind: "bookmarkStart", id: "5" }] }, first.content)),
				0,
				0
			)
		)

		expect(write(marked)).toEqual({ reason: "missingSource", message: "A new range marker" })
		// What it could write before it still writes: a new link, a tab, a field.
		expect(
			write(
				withFirst(doc, [
					docxSchema.text("link", [marks.link.create({ target: "https://filen.io" })]),
					nodes.tab.create(),
					nodes.field.create({ instruction: "PAGE", result: "1" })
				])
			)
		).toBeUndefined()
	})

	it("refuses what a feature recorded on a block or an atom that it cannot write yet", async () => {
		const document = await openSpec({
			body:
				p("first paragraph") +
				'<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="4000"/></w:tblGrid>' +
				"<w:tr><w:tc><w:p><w:r><w:t>cell text</w:t></w:r></w:p></w:tc></w:tr></w:tbl>" +
				'<w:sdt><w:sdtPr><w:id w:val="5"/></w:sdtPr><w:sdtContent><w:p><w:r><w:t>control text</w:t></w:r></w:p></w:sdtContent></w:sdt>' +
				p("last paragraph")
		})
		const edit = session(document)
		const doc = edit.state.doc
		const write = (changed: Node): unknown => writeError(document, edit, changed)
		const marked = (type: string, mark: string, value: unknown): unknown =>
			write(
				changeFirst(
					doc,
					node => node.type.name === type,
					node => node.mark([...node.marks, docxSchema.mark(mark, { value })])
				)
			)

		expect(write(doc)).toBeUndefined()
		expect(marked("paragraph", "paragraph_change", { style: "x" })).toEqual({
			reason: "missingSource",
			message: "A paragraph_change mark on a paragraph"
		})
		expect(marked("paragraph", "section_change", { section: 0 })).toEqual({
			reason: "missingSource",
			message: "A section_change mark on a paragraph"
		})
		// Table commands' records are written (write/tables.ts); keys the writer does not know are refused.
		expect(marked("table_row", "row_props", { header: true })).toBeUndefined()
		expect(marked("table_cell", "cell_props", { fill: "FF0000" })).toEqual({
			reason: "unsupported",
			message: "A cell change the writer does not know: fill"
		})
		expect(
			write(
				changeFirst(
					doc,
					node => node.type === nodes.table,
					node => node.type.create({ ...node.attrs, props: { align: "center" } }, node.content)
				)
			)
		).toBeUndefined()
		expect(
			write(
				changeFirst(
					doc,
					node => node.type === nodes.table,
					node => node.type.create({ ...node.attrs, props: { float: true } }, node.content)
				)
			)
		).toEqual({ reason: "unsupported", message: "A table change the writer does not know: float" })
		// A source control's state is spliced into its w:sdtPr (write/sdt.ts); a new one needs its definition.
		expect(
			write(
				changeFirst(
					doc,
					node => node.type === nodes.sdt,
					node => node.type.create({ ...node.attrs, state: { checked: true } }, node.content)
				)
			)
		).toBeUndefined()
		expect(
			write(
				changeFirst(
					doc,
					node => node.type === nodes.sdt,
					node => node.type.create({ ...node.attrs, src: -1, state: { checked: true } }, node.content)
				)
			)
		).toEqual({ reason: "missingSource", message: "A changed content control without its source" })
		// A formatting change tracked changes recorded is written (w:rPrChange).
		expect(
			write(
				changeFirst(
					doc,
					node => node.isText && node.text === "first paragraph",
					node => node.mark([...node.marks, marks.format_change.create({ author: "Bo", base: 0 })])
				)
			)
		).toBeUndefined()
		expect(write(withFirst(doc, [nodes.field_char.create({ kind: "middle" })]))).toEqual({
			reason: "unsupported",
			message: 'A field character "middle"'
		})
	})

	it("refuses changes to drawings that cannot have them; writes a source equation a command changed", async () => {
		const document = await openSpec({
			body:
				'<w:p><w:r><w:drawing><wp:inline><wp:extent cx="100" cy="100"/><wp:docPr w:id="1" id="1" name="x"/></wp:inline></w:drawing></w:r></w:p>' +
				"<w:p><m:oMath><m:r><m:t>x</m:t></m:r></m:oMath></w:p>"
		})
		const edit = session(document)
		const doc = edit.state.doc
		const write = (changed: Node): unknown => writeError(document, edit, changed)

		expect(write(doc)).toBeUndefined()
		expect(
			write(
				changeFirst(
					doc,
					node => node.type === nodes.drawing,
					node => node.type.create({ ...node.attrs, overrides: { cx: 200 } }, null, node.marks)
				)
			)
		).toEqual({ reason: "unsupported", message: "A resized drawing that cannot be resized" })
		expect(
			write(
				changeFirst(
					doc,
					node => node.type === nodes.math,
					node => node.type.create({ ...node.attrs, omml: "<m:oMath/>" }, null, node.marks)
				)
			)
		).toBeUndefined()
	})

	it("gives a paragraph the w14:paraId a feature set, never a copy its source's", async () => {
		const document = await openSpec({
			body: '<w:p w14:paraId="0000ABCD" w14:textId="0000DCBA"><w:r><w:t>source</w:t></w:r></w:p>' + p("other")
		})
		const edit = session(document)
		const doc = edit.state.doc
		const id = (value: string): readonly ReturnType<typeof marks.para_id.create>[] => [marks.para_id.create({ id: value })]
		const source = doc.child(0)
		const fresh = nodes.paragraph.create(null, docxSchema.text("new"), id("1A2B3C4D"))
		const copy = source.type.create(source.attrs, source.content, id("0000ABCD"))
		const written = decoder.decode(
			new StoryWriter(env(document), edit.story).writeStory(doc.copy(doc.content.append(Fragment.fromArray([fresh, copy])))).bytes
		)

		expect(written).toContain('<w:p w14:paraId="1A2B3C4D"><w:r><w:t>new</w:t></w:r></w:p>')
		expect(written.match(/w14:paraId="0000ABCD"/g)).toHaveLength(1)

		// The paragraph that owns its source gets the new id in place of its own, and loses its text hash.
		const renamed = decoder.decode(
			new StoryWriter(env(document), edit.story).writeStory(
				doc.replace(0, source.nodeSize, new Slice(Fragment.from(source.mark(id("2B3C4D5E"))), 0, 0))
			).bytes
		)

		expect(renamed).toContain('<w:p w14:paraId="2B3C4D5E">')
		expect(renamed).not.toContain("0000ABCD")
		expect(renamed).not.toContain("w14:textId")

		const append = (paragraph: Node): unknown => writeError(document, edit, doc.copy(doc.content.append(Fragment.from(paragraph))))

		expect(append(nodes.paragraph.create(null, null, id("8A2B3C4D")))).toMatchObject({ reason: "invalidValue" })
		expect(append(nodes.paragraph.create(null, null, id("00000000")))).toMatchObject({ reason: "invalidValue" })

		const plain = await openSpec({
			document: `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${p("plain")}</w:body></w:document>`
		})
		const plainEdit = session(plain)
		const plainDoc = plainEdit.state.doc

		expect(
			writeError(
				plain,
				plainEdit,
				plainDoc.copy(plainDoc.content.append(Fragment.from(nodes.paragraph.create(null, null, id("1A2B3C4D")))))
			)
		).toMatchObject({
			reason: "unsupported"
		})
	})
})

describe("docx writer extension points: new stories and parts", () => {
	it("inserts a referenced new story into its part where its contributor places it", async () => {
		const document = await withComments()
		const story = addedStory(document, "comment", "7", commentsPart(document), "a reply")
		const result = await saveDocx({
			pkg: document.pkg,
			context: document.context,
			sessions: [storySession(story)],
			parts: [comments(END)]
		})

		if (result.bytes === undefined) throw new Error("No bytes")

		expect(result.changedParts).toEqual(["word/comments.xml"])
		expect(await read(result.bytes, "word/comments.xml")).toContain(
			`${COMMENTS}<w:comment w:id="7" w:author="Bo" w:initials="B"><w:p><w:r><w:t>a reply</w:t></w:r></w:p></w:comment></w:comments>`
		)
		expect(
			(await openBytes(result.bytes)).model.stories.filter(candidate => candidate.kind === "comment").map(candidate => candidate.id)
		).toEqual(["0", "7"])

		// Before the first comment, in slices.
		const sliced = await serializeDocx(
			{ pkg: document.pkg, context: document.context, sessions: [storySession(story)], parts: [comments(FIRST)] },
			{ slicing: { sliceMs: 0, now: () => performance.now(), pause: () => Promise.resolve() } }
		)
		const at = FIRST(story.part, story.part.document.documentElement())

		expect(sliced.stories[0]?.range).toEqual({ from: at, to: at })
	})

	it("adds the part a referenced new story needs, with its relationship and content type", async () => {
		const document = await openSpec({ body: p("text") })
		const commentPart = templatePart(document, "word/comments.xml", `<w:comments ${NAMESPACES}></w:comments>`)
		const comment = addedStory(document, "comment", "0", commentPart, "a comment")
		const headerPart = templatePart(document, "word/header1.xml", `<w:hdr ${NAMESPACES}></w:hdr>`)
		const header = addedStory(document, "header", undefined, headerPart, "a header")
		let relationship: string | undefined
		const contributor: PartContributor = {
			...comments(END, "0"),
			async contribute(parts) {
				relationship = parts.storyRelationship("word/header1.xml")
			}
		}
		const result = await saveDocx({
			pkg: document.pkg,
			context: document.context,
			sessions: [new DocxEditorSession(document.context), storySession(comment), storySession(header)],
			parts: [contributor]
		})

		if (result.bytes === undefined) throw new Error("No bytes")

		expect([...result.changedParts].sort()).toEqual(
			["[Content_Types].xml", "word/_rels/document.xml.rels", "word/comments.xml", "word/header1.xml"].sort()
		)
		expect(await read(result.bytes, "word/header1.xml")).toBe(`<w:hdr ${NAMESPACES}><w:p><w:r><w:t>a header</w:t></w:r></w:p></w:hdr>`)

		const types = await read(result.bytes, "[Content_Types].xml")
		const rels = await read(result.bytes, "word/_rels/document.xml.rels")

		expect(types).toContain(
			'PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"'
		)
		expect(types).toContain(
			'PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"'
		)
		expect(rels).toContain('Target="comments.xml"')
		expect(rels).toContain(
			`Id="${String(relationship)}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"`
		)

		const reopened = await openBytes(result.bytes)

		expect(reopened.model.stories.filter(candidate => candidate.kind === "comment").map(candidate => candidate.id)).toEqual(["0"])
	})

	it("leaves a new story nothing refers to out of the save: no part, relationship or content type", async () => {
		const document = await withComments()
		const existing = addedStory(document, "comment", "7", commentsPart(document), "unreferenced")
		const header = addedStory(
			document,
			"header",
			undefined,
			templatePart(document, "word/header1.xml", `<w:hdr ${NAMESPACES}></w:hdr>`),
			"x"
		)
		const result = await saveDocx({
			pkg: document.pkg,
			context: document.context,
			sessions: [new DocxEditorSession(document.context), storySession(existing), storySession(header)],
			parts: [{ ...comments(END), references: () => false }]
		})

		expect(result.changedParts).toEqual([])
		expect(result.bytes).toEqual(document.bytes)
	})

	it.each(["comment", "footnote", "endnote", "header", "footer"] as const)(
		"saves nothing for a %s the paged editor adds while nothing refers to it",
		async kind => {
			const bytes = buildDocx({ body: p("text") })
			const { editor, pkg, context } = await pagedEditor(bytes)
			const added = editor.addStory(kind)

			expect(added).toBeDefined()
			added?.dispatch(added.state.tr.insertText("typed", 1))

			const result = await saveDocx({ pkg, context, sessions: editor.sessions })

			expect(result.changedParts).toEqual([])
			editor.dispose()
		}
	)

	// Documents with and without the part a new comment or note goes into.
	const SEPARATORS =
		'<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>' +
		'<w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>'
	const NOTE = (kind: string): string => `<w:${kind} w:id="1"><w:p><w:r><w:t>first note</w:t></w:r></w:p></w:${kind}>`
	const WITH_PART: Record<"comment" | "footnote" | "endnote", Parameters<typeof buildDocx>[0]> = {
		comment: { body: BODY, comments: COMMENTS },
		footnote: {
			body: '<w:p><w:r><w:t>noted</w:t></w:r><w:r><w:footnoteReference w:id="1"/></w:r></w:p>',
			footnotes: SEPARATORS + NOTE("footnote")
		},
		endnote: {
			body: '<w:p><w:r><w:t>noted</w:t></w:r><w:r><w:endnoteReference w:id="1"/></w:r></w:p>',
			endnotes: SEPARATORS.replace(/footnote/g, "endnote") + NOTE("endnote")
		}
	}
	// Places new comments and notes at the end of their part.
	const places: PartContributor = {
		container(story) {
			const kind = story.story.kind

			if (story.story.item >= 0 || (kind !== "comment" && kind !== "footnote" && kind !== "endnote")) return undefined

			const id = story.story.id ?? ""
			const open = kind === "comment" ? `<w:comment w:id="${id}" w:author="Bo" w:initials="B">` : `<w:${kind} w:id="${id}">`

			return { open, close: `</w:${kind}>`, at: story.part.document.contentEnd(story.part.document.documentElement()) }
		}
	}

	it.each([
		["comment", true],
		["comment", false],
		["footnote", true],
		["footnote", false],
		["endnote", true],
		["endnote", false]
	] as const)("saves a %s the paged editor adds and the body refers to (part present: %s)", async (kind, present) => {
		const bytes = buildDocx(present ? WITH_PART[kind] : { body: p("text") })
		const { editor, pkg, context } = await pagedEditor(bytes)
		// A note's id comes after the separator notes' (-1 and 0) in a notes part of its own.
		const added = editor.addStory(kind, kind === "comment" ? undefined : "2")

		if (added === undefined) throw new Error("No story")

		added.dispatch(added.state.tr.insertText(`added ${kind}`, 1))

		const id = context.newStories.get(added.story.story)?.id
		const body = editor.body.session
		const reference = kind === "comment" ? nodes.comment_ref.create({ id }) : nodes.note_ref.create({ kind, id })

		body.dispatch(body.state.tr.insert(body.state.doc.child(0).nodeSize - 1, reference))
		let references = 0

		body.state.doc.descendants(node => {
			if (node.type === reference.type && node.attrs["id"] === id) references++
		})
		expect(references).toBe(1)

		const result = await saveDocx({ pkg, context, sessions: editor.sessions, parts: [places] })

		editor.dispose()

		if (result.bytes === undefined) throw new Error("No bytes")

		const part = kind === "comment" ? "word/comments.xml" : `word/${kind}s.xml`

		expect(result.changedParts).toContain(part)
		expect(result.changedParts.includes("[Content_Types].xml")).toBe(!present)

		const reopened = await openBytes(result.bytes)
		const story = reopened.model.stories.find(candidate => candidate.kind === kind && candidate.id === id)

		if (story === undefined) throw new Error(`No ${kind} ${String(id)} read back`)

		expect(new DocxEditorSession(reopened.context, { story }).state.doc.textContent).toBe(`added ${kind}`)
		expect(
			reopened.model.stories.filter(
				candidate => candidate.kind === kind && candidate.noteType !== "separator" && candidate.noteType !== "continuationSeparator"
			).length
		).toBe(present ? 2 : 1)
	})

	it.each(["footnote", "endnote"] as const)("refuses a new %s whose id a separator note has", async kind => {
		const { editor, pkg, context } = await pagedEditor(buildDocx({ body: p("text") }))
		const added = editor.addStory(kind, "0")
		const body = editor.body.session

		body.dispatch(body.state.tr.insert(body.state.doc.child(0).nodeSize - 1, nodes.note_ref.create({ kind, id: "0" })))

		expect(await refusal(saveDocx({ pkg, context, sessions: editor.sessions, parts: [places] }))).toEqual({
			reason: "duplicateId",
			message: `${kind}:0 appears 2 times`
		})
		expect(added).toBeDefined()
		editor.dispose()
	})

	it.each(["header", "footer"] as const)("adds the part of a %s the paged editor adds once a section refers to it", async kind => {
		const bytes = buildDocx({ body: p("text") })
		const { editor, pkg, context } = await pagedEditor(bytes)
		const added = editor.addStory(kind)

		if (added === undefined) throw new Error("No story")

		added.dispatch(added.state.tr.insertText(`added ${kind}`, 1))

		const target = context.newStories.get(added.story.story)?.target ?? ""
		let relationship: string | undefined
		const sections: PartContributor = {
			references: story => story.kind === kind,
			async contribute(parts) {
				relationship = parts.storyRelationship(target)
			}
		}
		const result = await saveDocx({ pkg, context, sessions: editor.sessions, parts: [sections] })

		editor.dispose()

		if (result.bytes === undefined) throw new Error("No bytes")

		expect([...result.changedParts].sort()).toEqual(["[Content_Types].xml", "word/_rels/document.xml.rels", target].sort())
		expect(await read(result.bytes, target)).toContain(
			`<w:p><w:r><w:t>added ${kind}</w:t></w:r></w:p></w:${kind === "header" ? "hdr" : "ftr"}>`
		)
		expect(await read(result.bytes, "word/_rels/document.xml.rels")).toContain(`Id="${String(relationship)}"`)
		expect((await openBytes(result.bytes)).pkg.has(target)).toBe(true)
	})

	it("refuses a new reference that resolves to no note or comment", async () => {
		const footnotes = buildDocx({ body: p("text"), footnotes: SEPARATORS })

		for (const id of ["-1", "0", "77"]) {
			const { editor, pkg, context } = await pagedEditor(footnotes)
			const body = editor.body.session

			body.dispatch(body.state.tr.insert(body.state.doc.child(0).nodeSize - 1, nodes.note_ref.create({ kind: "footnote", id })))
			expect(await refusal(saveDocx({ pkg, context, sessions: editor.sessions }))).toEqual({
				reason: "danglingReference",
				message: `A new reference to footnote ${id} has no note`
			})
			editor.dispose()
		}

		const document = await withComments()
		const edit = session(document)

		edit.dispatch(edit.state.tr.insert(edit.state.doc.child(0).nodeSize - 1, nodes.comment_ref.create({ id: "5" })))
		expect(await refusal(saveDocx({ pkg: document.pkg, context: document.context, sessions: [edit] }))).toEqual({
			reason: "danglingReference",
			message: "A new reference to comment 5 has no comment"
		})
	})

	it("refuses a new comment that would take over a range or reference without a comment", async () => {
		// The body's comment range and reference have no comment.
		const { editor, pkg, context } = await pagedEditor(buildDocx({ body: BODY }))
		const added = editor.addStory("comment", "0")

		expect(added).toBeDefined()
		expect(
			await refusal(saveDocx({ pkg, context, sessions: editor.sessions, parts: [{ ...places, references: () => true }] }))
		).toEqual({
			reason: "duplicateId",
			message: "A new comment 0 takes the id of a range or reference without a comment"
		})
		editor.dispose()
	})

	it("leaves out a note only a story left out of the save refers to", async () => {
		const { editor, pkg, context } = await pagedEditor(buildDocx({ body: p("text") }))
		const comment = editor.addStory("comment")
		const note = editor.addStory("footnote", "2")

		if (comment === undefined || note === undefined) throw new Error("No story")

		comment.dispatch(comment.state.tr.insert(1, nodes.note_ref.create({ kind: "footnote", id: "2" })))
		note.dispatch(note.state.tr.insertText("orphan", 1))

		const result = await saveDocx({ pkg, context, sessions: editor.sessions, parts: [places] })

		expect(result.changedParts).toEqual([])
		editor.dispose()
	})

	it("refuses a referenced new story it cannot place, with a reason", async () => {
		const document = await withComments()
		const story = addedStory(document, "comment", "7", commentsPart(document), "lost")
		const save = (parts: readonly PartContributor[], sessions = [storySession(story)]): Promise<unknown> =>
			refusal(saveDocx({ pkg: document.pkg, context: document.context, sessions, parts }))
		const references: PartContributor = { references: () => true }

		expect(await save([references])).toEqual({ reason: "write", message: "A new comment story" })
		expect(await save([comments((part, root) => part.document.openEnd(part.document.firstChildElement(root)))])).toMatchObject({
			reason: "write",
			message: expect.stringMatching(/goes inside another element/)
		})

		// On a part of its own named like the package's.
		const elsewhere = addedStory(
			document,
			"comment",
			"8",
			templatePart(document, "word/comments.xml", `<w:comments ${NAMESPACES}></w:comments>`),
			"x"
		)

		expect(await save([comments(END)], [storySession(elsewhere)])).toMatchObject({
			reason: "write",
			message: expect.stringMatching(/as the package has it/)
		})

		// A story with no container that the editor did not add.
		const stray: StoryDoc = { ...story, story: { ...story.story, index: 99 } }

		expect(await save([comments(END)], [storySession(stray)])).toMatchObject({
			reason: "write",
			message: "A comment story without a container"
		})

		// Two new stories of one new part, each on a part of its own.
		const plain = await openSpec({ body: p("text") })
		const first = addedStory(
			plain,
			"comment",
			"0",
			templatePart(plain, "word/comments.xml", `<w:comments ${NAMESPACES}></w:comments>`),
			"a"
		)
		const second = addedStory(
			plain,
			"comment",
			"1",
			templatePart(plain, "word/comments.xml", `<w:comments ${NAMESPACES}></w:comments>`),
			"b"
		)

		expect(
			await refusal(
				saveDocx({
					pkg: plain.pkg,
					context: plain.context,
					sessions: [storySession(first), storySession(second)],
					parts: [comments(END)]
				})
			)
		).toMatchObject({ reason: "write", message: expect.stringMatching(/on parts of their own/) })
	})

	it("refuses document attributes no contributor writes", async () => {
		const document = await withComments()
		const edit = session(document)
		const doc = edit.state.doc
		const changed = doc.type.create({ ...doc.attrs, comments: { "0": { done: true } } }, doc.content)
		const body = storySession(edit.story, changed)

		expect(await refusal(saveDocx({ pkg: document.pkg, context: document.context, sessions: [body], parts: [] }))).toEqual({
			reason: "write",
			message: "A document comments change"
		})
		expect(
			await refusal(
				saveDocx({ pkg: document.pkg, context: document.context, sessions: [body], parts: [{ attributes: ["comments"] }] })
			)
		).toBeUndefined()
	})

	it("lets a contributor add a part with its relationship and content type, and replace one", async () => {
		const document = await withComments()
		const edit = session(document)

		edit.dispatch(edit.state.tr.insertText("New ", 2))

		const added: PartContributor = {
			async contribute(parts, written) {
				expect(written.stories.map(story => story.part.name)).toEqual(["word/document.xml"])

				const name = parts.freeName("word/comments.xml")

				expect(name).toBe("word/comments1.xml")
				expect(parts.freeName("word/media/image.png")).toBe("word/media/image.png")
				parts.add(
					"word/people.xml",
					encodeUtf8('<?xml version="1.0"?><w15:people xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"/>'),
					"application/vnd.openxmlformats-officedocument.wordprocessingml.people+xml"
				)
				expect(
					parts.relationship("word/document.xml", {
						type: "http://schemas.microsoft.com/office/2011/relationships/people",
						target: "people.xml"
					})
				).toMatch(/^rId\d+$/)
				parts.addDefault("png", "image/png")
				expect(() => parts.add("word/comments.xml", new Uint8Array(), "x")).toThrow(/already in the package/)
				expect(() => parts.add("word/people.xml", new Uint8Array(), "x")).toThrow(/already in the package/)
				expect(() => parts.add("[Content_Types].xml", new Uint8Array(), "x")).toThrow(/the save's own/)
				expect(() => parts.replace("word/_rels/document.xml.rels", new Uint8Array())).toThrow(/the save's own/)
				expect(() => parts.replace("word/document.xml", new Uint8Array())).toThrow(/holds stories this save writes/)
				parts.replace("word/comments.xml", encodeUtf8(`<w:comments ${NAMESPACES}>${COMMENTS}</w:comments>`))
				expect(() => parts.replace("word/comments.xml", new Uint8Array())).toThrow(/written twice/)
				expect(parts.state(added, () => ({ count: 1 }))).toBe(parts.state(added, () => ({ count: 2 })))
			}
		}
		const result = await saveDocx({ pkg: document.pkg, context: document.context, sessions: [edit], parts: [added] })

		if (result.bytes === undefined) throw new Error("No bytes")

		expect([...result.changedParts].sort()).toEqual(
			["[Content_Types].xml", "word/_rels/document.xml.rels", "word/comments.xml", "word/document.xml", "word/people.xml"].sort()
		)
		expect(await read(result.bytes, "[Content_Types].xml")).toContain(
			'<Override PartName="/word/people.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.people+xml"/>'
		)
		expect(await read(result.bytes, "word/_rels/document.xml.rels")).toContain('Target="people.xml"')
	})

	it("stores a new part whose content type is compressed already and deflates the rest", async () => {
		const document = await withComments()
		const edit = session(document)

		edit.dispatch(edit.state.tr.insertText("New ", 2))

		// A 1 × 1 PNG header plus filler: deflate would shrink it, so only the content type decides.
		const png = new Uint8Array(4096)

		png.set([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0
		])

		const added: PartContributor = {
			contribute(parts) {
				parts.add("word/media/image1.png", png, "image/png")
				parts.add("word/media/image2.svg", encodeUtf8('<svg xmlns="http://www.w3.org/2000/svg"/>'), "image/svg+xml")
				parts.add("word/media/image3.png", png, "image/png", { compress: true })
				parts.add(
					"word/people.xml",
					encodeUtf8('<?xml version="1.0"?><w15:people xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"/>'),
					"application/vnd.openxmlformats-officedocument.wordprocessingml.people+xml"
				)

				return Promise.resolve()
			}
		}
		const result = await saveDocx({ pkg: document.pkg, context: document.context, sessions: [edit], parts: [added] })

		if (result.bytes === undefined) throw new Error("No bytes")

		const saved = await OpcPackage.open(bytesSource(result.bytes))

		expect(saved.entry("word/media/image1.png")?.method).toBe(0)
		expect(saved.entry("word/media/image2.svg")?.method).toBe(8)
		expect(saved.entry("word/media/image3.png")?.method).toBe(8)
		expect(saved.entry("word/people.xml")?.method).toBe(8)
		expect(await saved.read("word/media/image1.png")).toEqual(png)
	})

	it("never retypes what the package types: not in the writer, not past gate 2", async () => {
		const document = await withComments()
		const edit = session(document)

		edit.dispatch(edit.state.tr.insertText("New ", 2))

		const retype: PartContributor = {
			async contribute(parts) {
				parts.addDefault("rels", "text/plain")
			}
		}

		expect(await refusal(saveDocx({ pkg: document.pkg, context: document.context, sessions: [edit], parts: [retype] }))).toMatchObject({
			reason: "write",
			message: expect.stringMatching(/Files \.rels are typed/)
		})

		const changes = await serializeDocx({ pkg: document.pkg, context: document.context, sessions: [edit] })
		const types = decoder
			.decode(await document.pkg.opc.read("[Content_Types].xml"))
			.replace(
				'Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"',
				'Extension="rels" ContentType="text/plain"'
			)
		const tampered = { ...changes, replace: [...changes.replace, { name: "[Content_Types].xml", bytes: encodeUtf8(types) }] }

		await expect(verifyDocxParts({ original: document.pkg, context: document.context, changes: tampered })).rejects.toMatchObject({
			reason: "contentType"
		})

		// A part that is not there is never replaced, and the archive refusing a change is a save refusal.
		const missing = { ...changes, replace: [...changes.replace, { name: "word/missing.xml", bytes: encodeUtf8("<x/>") }] }

		await expect(verifyDocxParts({ original: document.pkg, context: document.context, changes: missing })).rejects.toMatchObject({
			reason: "invalidPackage"
		})
		await expect(zipDocxSave(document.pkg.opc, missing)).rejects.toMatchObject({ name: "DocxSaveError", reason: "invalidPackage" })
	})
})

describe("docx writer extension points: gate 2 checks", () => {
	it("runs the features' checks on every changed part and once at the end, and refuses what they refuse", async () => {
		const document = await withComments()
		const edit = session(document)

		edit.dispatch(edit.state.tr.insertText("New ", 2))

		const changes = await serializeDocx({ pkg: document.pkg, context: document.context, sessions: [edit] })
		const seen: string[] = []
		const recording: DocxCheck = {
			part(input, part) {
				seen.push(`${part.name}:${part.skeleton ? "skeleton" : "whole"}:${input.ids("commentReference:0")}`)
			},
			done() {
				seen.push("done")
			}
		}

		await verifyDocxParts({ original: document.pkg, context: document.context, changes, checks: [recording] })
		expect(seen).toEqual(["word/document.xml:skeleton:1", "done"])

		const refusing: DocxCheck = {
			done() {
				throw new DocxVerifyError("danglingReference", "refused")
			}
		}

		await expect(
			verifyDocxParts({ original: document.pkg, context: document.context, changes, checks: [refusing] })
		).rejects.toMatchObject({
			reason: "danglingReference"
		})

		// An id space of a check's own, over the children of a part's root: every comment is one id, so a new
		// comment duplicates it.
		const story = addedStory(document, "comment", "7", commentsPart(document), "another")
		const withComment = await serializeDocx({
			pkg: document.pkg,
			context: document.context,
			sessions: [storySession(story)],
			parts: [comments(END)]
		})
		const all: DocxCheck = { fact: { elements: ["comment"], id: () => "comment:all" } }

		await expect(
			verifyDocxParts({ original: document.pkg, context: document.context, changes: withComment, checks: [all] })
		).rejects.toMatchObject({ reason: "duplicateId", message: "comment:all appears 2 times" })
		await expect(verifyDocxParts({ original: document.pkg, context: document.context, changes: withComment })).resolves.toBeUndefined()
		// The registry's checks pass a sound save.
		await expect(verifyDocxParts({ original: document.pkg, context: document.context, changes })).resolves.toBeUndefined()
	})
})

describe("docx writer extension points: nested stories", () => {
	it("splices stories rewritten inside copied source bytes, as new markup gate 2 parses", async () => {
		const document = await openSpec({ body: p("outer hello") + p("after") })
		const edit = session(document)
		const xml = edit.story.part.document
		const bytes = xml.bytes
		const at = decoder.decode(bytes).indexOf("hello")
		const nested: WriteEnvironment = {
			...env(document),
			nested: (_part, from, to) => (at >= from && at + 5 <= to ? [{ from: at, to: at + 5, bytes: encodeUtf8("HELLO") }] : undefined)
		}
		const plain = new StoryWriter(env(document), edit.story).writeStory(edit.state.doc)
		const spliced = new StoryWriter(nested, edit.story).writeStory(edit.state.doc)

		expect(decoder.decode(spliced.bytes)).toBe(decoder.decode(plain.bytes).replace("hello", "HELLO"))
		expect(plain.trusted.length).toBeGreaterThan(0)
		// No copy that holds the splice is trusted as source bytes.
		for (let k = 0; k < spliced.trusted.length; k += 4) {
			expect((spliced.trusted[k + 2] ?? 0) > at || (spliced.trusted[k + 3] ?? 0) <= at).toBe(true)
		}
	})
})

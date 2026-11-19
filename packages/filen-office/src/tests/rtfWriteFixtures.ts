import type { Node } from "prosemirror-model"
import { TextSelection } from "prosemirror-state"
import { layoutDocument, openDocxPackage, type DocxPackage } from "@filen/office/core/docx"
import {
	DocxEditorSession,
	docxSchema,
	openDocxEditContext,
	type DocxEditContext,
	type DocxEditorCommand
} from "@filen/office/core/docx/edit"
import { DocumentEdits, PagedEditor } from "@filen/office/core/docx/paged"
import { prepareDocxSave, writerProof } from "@filen/office/core/docx/write"
import { bytesSource, joinBytes } from "@filen/office/core/opc"
import { HitTester } from "@filen/office/core/text"
import type { XmlDocument } from "@filen/office/core/xml"
import { rtfBlockProof } from "../core/rtf/write/proof"
import { openRtfSource, proveRtf, writeRtf, type RtfEdits, type RtfSource, type RtfWritten } from "../core/rtf/write/writer"
import { HmtxMeasurer, loadDocx } from "./layoutFixtures"

export { latin1 } from "./rtfLatin1"

// Editing RTF documents in tests as the web editor does: the translation opened in the docx editor, edits made
// with its commands, the parts the docx writer writes handed to the RTF writer.

const nodes = docxSchema.nodes

export interface RtfEditing {
	readonly source: RtfSource
	readonly opened: { readonly pkg: DocxPackage; readonly context: DocxEditContext }
	// The paged editor (section, page and picture commands act through it) and its body's session.
	readonly editor: PagedEditor
	readonly session: DocxEditorSession
	// Top-level blocks Gate 1 locked.
	readonly locked: number
}

async function partXml(pkg: DocxPackage, kind: string): Promise<XmlDocument | undefined> {
	const name = pkg.part(kind)

	return name === undefined || !pkg.has(name) ? undefined : pkg.xml(name)
}

// Opens as the editor does: laid out, Gate 1 the docx writer's proof and the RTF writer's.
export async function editRtf(bytes: Uint8Array): Promise<RtfEditing> {
	const source = await openRtfSource(bytes)

	if (source === undefined) throw new Error("not RTF")

	const docx = source.read.docx
	const loaded = await loadDocx(docx)
	const opened = await openDocxPackage(bytesSource(docx))

	if (!opened.ok) throw new Error(opened.message)

	const context = await openDocxEditContext(opened.package, loaded.model, { store: loaded.store, resolver: loaded.resolver })
	const edits = new DocumentEdits(loaded.model)

	edits.define({ context, styles: await partXml(opened.package, "styles"), numbering: await partXml(opened.package, "numbering") })

	const layout = layoutDocument(edits.model, loaded.resolver, loaded.fonts, new HmtxMeasurer(), {
		store: loaded.store,
		sliceMs: Infinity,
		recordMaps: true,
		edits
	})

	await layout.done

	const proof = await proveRtf(source)
	const gate = rtfBlockProof(proof.locked, writerProof(context))
	const session = new DocxEditorSession(context, { proof: gate })
	const editor = new PagedEditor({
		session,
		edits,
		layout,
		tester: new HitTester(layout.styles),
		sessionOptions: { proof: gate }
	})

	context.identity.author = "Filen"

	return { source, opened: { pkg: opened.package, context }, editor, session, locked: proof.locked.length }
}

// The parts a save of the editing would write.
export async function editsOf(editing: RtfEditing, sessions: readonly DocxEditorSession[] = editing.editor.sessions): Promise<RtfEdits> {
	const prepared = await prepareDocxSave({ pkg: editing.opened.pkg, context: editing.opened.context, sessions })
	const parts = new Map<string, Uint8Array>()

	for (const change of [...prepared.replace, ...prepared.add]) parts.set(change.name, await joinBytes(change.bytes))

	return { parts, ...(prepared.remove === undefined ? {} : { removed: prepared.remove }) }
}

export async function saveRtf(editing: RtfEditing, sessions?: readonly DocxEditorSession[]): Promise<RtfWritten> {
	return writeRtf(editing.source, await editsOf(editing, sessions))
}

// Paragraphs of the body with text, outside tables or in them.
export function paragraphs(doc: Node, inTables = false): { node: Node; pos: number }[] {
	const out: { node: Node; pos: number }[] = []

	doc.descendants((node, pos, parent) => {
		if (node.type === nodes.paragraph) {
			if ((parent?.type === nodes.table_cell) === inTables && node.textContent.length >= 3 && node.firstChild?.isText === true)
				out.push({ node, pos })

			return false
		}

		return !node.isInline
	})

	return out
}

function select(session: DocxEditorSession, from: number, to = from): void {
	session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, from, to)))
}

// A 2 x 2 PNG (red, green; blue, white).
export const PNG = Uint8Array.from(
	atob("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP4z8DAAMIM/4EAAB/uBfsL2WiLAAAAAElFTkSuQmCC"),
	character => character.charCodeAt(0)
)

// The scripted edits: typing, bold, a paragraph deleted, a table row inserted, a list toggled, a built-in heading
// style applied (theme fonts and colours), a new table, two cells merged, a table nested in a cell, a section break,
// the page set up anew (orientation, margins, columns) and a picture inserted. Each on its own paragraph (or the first
// table); returns the names of those that applied.
export async function scriptedEdits(editing: Pick<RtfEditing, "session" | "editor">): Promise<string[]> {
	const { session, editor } = editing
	const done: string[] = []
	const text = (): { node: Node; pos: number }[] => paragraphs(session.state.doc)
	const attempt = async (
		name: string,
		at: { node: Node; pos: number } | undefined,
		command: DocxEditorCommand,
		to?: number
	): Promise<void> => {
		if (at === undefined) return

		select(session, at.pos + 1, to ?? at.pos + 1)

		if (await editor.execute(command)) done.push(name)
	}
	const first = text()[0]

	if (first !== undefined && session.dispatch(session.state.tr.insertText("Filen Größe – ", first.pos + 1))) done.push("type")

	const second = text()[1]

	if (second !== undefined) await attempt("format", second, { type: "format.bold" }, second.pos + 3)

	const third = text()[2]

	if (third !== undefined && session.dispatch(session.state.tr.delete(third.pos, third.pos + third.node.nodeSize))) done.push("delete")

	await attempt("row", paragraphs(session.state.doc, true)[0], { type: "table.row.insertBelow" })
	await attempt("list", text()[3], { type: "list.bullet" })
	await attempt("heading", text()[4], { type: "style.set", style: "heading1" })
	await attempt("table", text()[5], { type: "table.insert", rows: 2, cols: 3 })

	const cells = paragraphs(session.state.doc, true)

	if (cells[0] !== undefined && cells[1] !== undefined) await attempt("merge", cells[0], { type: "table.cells.merge" }, cells[1].pos + 2)

	await attempt("nested", paragraphs(session.state.doc, true)[0], { type: "table.insert", rows: 1, cols: 2 })
	await attempt("section", text()[6], { type: "insert.sectionBreak", kind: "nextPage" })
	await attempt("page", text()[0], {
		type: "page.setup",
		orientation: "landscape",
		margins: { left: 1080 },
		columns: { count: 2, space: 360, separator: true }
	})

	const media = session.context.media.add(PNG)

	if (media !== undefined) await attempt("picture", text()[7] ?? text()[0], { type: "image.insert", media, altText: "Three dots" })

	return done
}

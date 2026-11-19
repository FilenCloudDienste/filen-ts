import { layoutDocument, openDocxPackage, type DocxPackage } from "@filen/office/core/docx"
import type { Node } from "prosemirror-model"
import { TextSelection } from "prosemirror-state"
import { DocxEditorSession, openDocxEditContext, type DocxEditContext, type DocxEditorCommand } from "@filen/office/core/docx/edit"
import { DocumentEdits, PagedEditor } from "@filen/office/core/docx/paged"
import { prepareDocxSave, writerProof } from "@filen/office/core/docx/write"
import { ZipArchive, bytesSource, joinBytes } from "@filen/office/core/opc"
import { HitTester } from "@filen/office/core/text"
import { decodeUtf8, type XmlDocument } from "@filen/office/core/xml"
import { rtfBlockProof } from "../core/rtf/write/proof"
import { openOdtSource, type OdtSource } from "../core/odt/write/source"
import { proveOdt, writeOdt, type OdtEdits, type OdtWritten } from "../core/odt/write/writer"
import { HmtxMeasurer, loadDocx } from "./layoutFixtures"
import { PNG, paragraphs } from "./rtfWriteFixtures"

// Editing ODF text documents in tests as the web editor does: the translation opened in the docx editor, edits made
// with its commands, the parts the docx writer writes handed to the ODT writer.

export interface OdtEditing {
	readonly source: OdtSource
	readonly opened: { readonly pkg: DocxPackage; readonly context: DocxEditContext }
	readonly editor: PagedEditor
	readonly session: DocxEditorSession
	// Top-level blocks Gate 1 locked.
	readonly locked: number
}

async function partXml(pkg: DocxPackage, kind: string): Promise<XmlDocument | undefined> {
	const name = pkg.part(kind)

	return name === undefined || !pkg.has(name) ? undefined : pkg.xml(name)
}

export async function odtSource(bytes: Uint8Array): Promise<OdtSource> {
	const opened = await openOdtSource(bytes)

	if (!opened.ok) throw new Error(opened.message)

	return opened.source
}

// Opens as the editor does: laid out, Gate 1 the docx writer's proof and the ODT writer's. Takes the file, or a
// source already opened (a refusal to open is then the caller's, and anything thrown here is a failure).
export async function editOdt(input: Uint8Array | OdtSource, options: { readonly prove?: boolean } = {}): Promise<OdtEditing> {
	const source = input instanceof Uint8Array ? await odtSource(input) : input
	const docx = source.docx
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

	const locked = options.prove === false ? [] : (await proveOdt(source)).locked
	const gate = rtfBlockProof(locked, writerProof(context))
	const session = new DocxEditorSession(context, { proof: gate })
	const editor = new PagedEditor({
		session,
		edits,
		layout,
		tester: new HitTester(layout.styles),
		sessionOptions: { proof: gate }
	})

	context.identity.author = "Filen"

	return { source, opened: { pkg: opened.package, context }, editor, session, locked: locked.length }
}

// The parts a save of the editing would write.
export async function odtEditsOf(editing: OdtEditing): Promise<OdtEdits> {
	const prepared = await prepareDocxSave({ pkg: editing.opened.pkg, context: editing.opened.context, sessions: editing.editor.sessions })
	const parts = new Map<string, Uint8Array>()

	for (const change of [...prepared.replace, ...prepared.add]) parts.set(change.name, await joinBytes(change.bytes))

	return { parts, ...(prepared.remove === undefined ? {} : { removed: prepared.remove }) }
}

export async function saveOdt(editing: OdtEditing): Promise<OdtWritten> {
	return writeOdt(editing.source, await odtEditsOf(editing))
}

// The position of the paragraph `index` in document order. `intoTables: false` counts only paragraphs outside tables.
export function paragraphAt(editing: OdtEditing, index: number, options: { readonly intoTables?: boolean } = {}): number {
	const intoTables = options.intoTables ?? true
	let found = -1
	let k = 0

	editing.session.state.doc.descendants((node, pos) => {
		if (found >= 0) return false
		if (node.type.name === "paragraph") {
			if (k++ === index) found = pos

			return false
		}

		return intoTables || node.type.name !== "table"
	})

	if (found < 0) throw new Error(`no paragraph ${index}`)

	return found
}

// A part of a saved package as text.
export async function zipPartText(bytes: Uint8Array, name = "content.xml"): Promise<string> {
	const archive = await ZipArchive.open(bytesSource(bytes))
	const entry = archive.get(name)

	if (entry === undefined) throw new Error(name)

	return decodeUtf8(await archive.read(entry))
}

function select(session: DocxEditorSession, from: number, to = from): void {
	session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, from, to)))
}

export const ODT_EDITS = ["type", "format", "delete", "row", "list", "heading", "picture", "track", "page", "section"] as const

export type OdtEditName = (typeof ODT_EDITS)[number]

// The scripted edits: typing, bold, a paragraph deleted, a table row inserted, a list toggled, a built-in heading
// style applied, a picture inserted, the page set up anew, a section break, typing tracked; each on its own paragraph
// (or the first table). `only`: just those. Returns those that applied.
export async function scriptedOdtEdits(editing: OdtEditing, only: readonly OdtEditName[] = ODT_EDITS): Promise<OdtEditName[]> {
	const { session, editor } = editing
	const done: OdtEditName[] = []
	const text = (): { node: Node; pos: number }[] => paragraphs(session.state.doc)
	const attempt = async (
		name: OdtEditName,
		at: { node: Node; pos: number } | undefined,
		command: DocxEditorCommand,
		to?: number
	): Promise<void> => {
		if (at === undefined || !only.includes(name)) return

		select(session, at.pos + 1, to ?? at.pos + 1)

		if (await editor.execute(command)) done.push(name)
	}
	const first = text()[0]

	if (only.includes("type") && first !== undefined && session.dispatch(session.state.tr.insertText("Filen Größe – ", first.pos + 1)))
		done.push("type")

	const second = text()[1]

	await attempt("format", second, { type: "format.bold" }, second === undefined ? undefined : second.pos + 3)

	const third = text()[2]

	if (
		only.includes("delete") &&
		third !== undefined &&
		session.dispatch(session.state.tr.delete(third.pos, third.pos + third.node.nodeSize))
	)
		done.push("delete")

	await attempt("row", paragraphs(session.state.doc, true)[0], { type: "table.row.insertBelow" })
	await attempt("list", text()[3], { type: "list.bullet" })
	await attempt("heading", text()[4], { type: "style.set", style: "heading1" })

	const media = only.includes("picture") ? session.context.media.add(PNG) : undefined

	if (media !== undefined) await attempt("picture", text()[5] ?? text()[0], { type: "image.insert", media, altText: "Three dots" })

	await attempt("page", text()[0], {
		type: "page.setup",
		orientation: "landscape",
		margins: { left: 1080 },
		columns: { count: 2, space: 360, separator: false }
	} as DocxEditorCommand)

	// A next-page section break after a later paragraph.
	await attempt("section", text()[7] ?? text()[2], { type: "insert.sectionBreak", kind: "nextPage" } as DocxEditorCommand)

	// Typed with tracking on: a tracked insertion.
	const tracked = text()[6] ?? text()[1]

	if (only.includes("track") && tracked !== undefined) {
		session.context.identity.author = "Filen"
		session.context.review.tracking = true

		if (session.dispatch(session.state.tr.insertText("tracked ", tracked.pos + 1))) done.push("track")

		session.context.review.tracking = false
	}

	return done
}

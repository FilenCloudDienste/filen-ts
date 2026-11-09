import { spawnSync, type SpawnSyncReturns } from "node:child_process"
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { unzipSync } from "fflate"
import type { Node, NodeType } from "prosemirror-model"
import type { XmlDocument } from "@filen/office/core/xml"
import { bytesSource } from "@filen/office/core/opc"
import {
	RevisionView,
	buildDocxModel,
	layoutDocument,
	openDocxPackage,
	type DocxModel,
	type DocxPackage,
	type Story
} from "@filen/office/core/docx"
import {
	DocxEditorSession,
	NO_SOURCE,
	docxSchema,
	openDocxEditContext,
	survivorsOf,
	type BlockProof,
	type DocxEditContext,
	type DocxEditorCommand,
	type MarkerList,
	type MarkerNodeAttrs,
	type NewStoryKind,
	type DocxEditorOptions
} from "@filen/office/core/docx/edit"
import { DocumentEdits, PagedEditor } from "@filen/office/core/docx/paged"
import { DocxSaveError, saveDocx, writerProof } from "@filen/office/core/docx/write"
import { HitTester } from "@filen/office/core/text"
import { writtenJustification } from "../../core/docx/write/paragraph"
import { SCHEMA_CACHE, transitionalSchemas } from "../../scripts/wmlOrder"
import { HmtxMeasurer, loadDocx, type LoadedDocx } from "../layoutFixtures"
import type { FuzzConfig } from "./config"
import { digestPage } from "./digest"

// The fuzzers' adapter to the editing, layout and writing APIs: every call they make into the package goes
// through this file, so an API change is adapted here. Also the schema oracle (xmllint).

export {
	DOCX_PARAGRAPH_STYLES,
	DocxEditorSession,
	docxSchema,
	freshSlice,
	type DocxEditorCommand,
	type DocxParagraphStyle,
	type NewStoryKind
} from "@filen/office/core/docx/edit"
export { joinBackward, splitParagraph, type PagedEditor } from "@filen/office/core/docx/paged"

export function isSaveRefusal(error: unknown): error is DocxSaveError {
	return error instanceof DocxSaveError
}

export type View = FuzzConfig["view"]

const VIEWS = { final: RevisionView.Final, markup: RevisionView.Markup, original: RevisionView.Original } as const

function revisionView(view: View): { view?: RevisionView } {
	return view === undefined ? {} : { view: VIEWS[view] }
}

// ---- paged editing ----

export type PagedMode = "sync" | "race" | "proof"

export interface PagedRun {
	readonly editor: PagedEditor
	readonly pkg: DocxPackage
	readonly context: DocxEditContext
	readonly loaded: LoadedDocx
	readonly view: View
}

async function partXml(pkg: DocxPackage, kind: string): Promise<XmlDocument | undefined> {
	const name = pkg.part(kind)

	return name === undefined || !pkg.has(name) ? undefined : pkg.xml(name)
}

// A paged editor over the laid-out document, or why it cannot be edited. "race" lays out in 2 ms slices on
// a fake clock and gives edits a 1 ms budget, so edits land while layout is still running; "proof" uses the
// writer's Gate 1 instead of the conservative one.
export async function openPaged(bytes: Uint8Array, mode: PagedMode, view: View): Promise<PagedRun | { refused: string }> {
	const opened = await openDocxPackage(bytesSource(bytes))

	if (!opened.ok) return { refused: `unopenable (${opened.reason})` }

	let loaded: LoadedDocx

	try {
		loaded = await loadDocx(bytes)
	} catch (error) {
		return { refused: `unopenable (${error instanceof Error ? error.message.slice(0, 120) : String(error)})` }
	}

	const context = await openDocxEditContext(opened.package, loaded.model, { store: loaded.store, resolver: loaded.resolver })

	if (context.gate.length > 0) return { refused: `view-only (${context.gate.join(", ")})` }

	const edits = new DocumentEdits(loaded.model, view === undefined ? RevisionView.Final : VIEWS[view])

	edits.define({ context, styles: await partXml(opened.package, "styles"), numbering: await partXml(opened.package, "numbering") })

	let clock = 0
	const race = mode === "race"
	const layout = layoutDocument(edits.model, loaded.resolver, loaded.fonts, new HmtxMeasurer(), {
		store: loaded.store,
		sliceMs: race ? 2 : Infinity,
		recordMaps: true,
		edits,
		...revisionView(view),
		...(race ? { now: () => clock++, yield: () => new Promise<void>(resolve => setImmediate(resolve)) } : {})
	})

	await layout.done

	const options: Omit<DocxEditorOptions, "story"> = mode === "proof" ? { proof: writerProof(context) } : {}
	const editor = new PagedEditor({
		session: new DocxEditorSession(context, options),
		edits,
		layout,
		tester: new HitTester(layout.styles),
		options: race ? { budgetMs: 1, now: () => clock++ } : { budgetMs: Infinity },
		sessionOptions: options
	})

	return { editor, pkg: opened.package, context, loaded, view }
}

const turn = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

// Lets layout work left for later finish and every page refresh.
export async function settle(editor: PagedEditor): Promise<void> {
	const layout = editor.layout

	for (let k = 0; k < 30; k++) await turn()

	for (let round = 0; round < 200; round++) {
		while (!layout.final) if (layout.advance(Infinity) === "fonts") await layout.prepareFonts()

		await turn()
		editor.setVisible(0, Math.max(0, layout.pages.length - 1))

		if (layout.final && layout.stale.size === 0) break
	}

	await turn()
}

// A package's parts by name, read once (pictures are told by their bytes, see digestPage).
function partsOf(bytes: Uint8Array): (name: string) => Uint8Array | undefined {
	let entries: Record<string, Uint8Array> | undefined

	return name => (entries ??= unzipSync(bytes))[name]
}

// The pages the editor shows; `source`: the document as opened (new pictures come from the editor's media).
export function shownPages(editor: PagedEditor, source: Uint8Array): string[] {
	const out: string[] = []
	const media = partsOf(source)

	for (let i = 0; i < editor.pageCount; i++) {
		const page = editor.page(i)

		out.push(page === undefined ? "<missing>" : digestPage(editor.layout, page, media))
	}

	return out
}

// A fresh layout of `bytes`.
// A fresh layout of `bytes` in the view the editor shows.
export async function freshPages(bytes: Uint8Array, editor: PagedEditor): Promise<string[]> {
	const loaded = await loadDocx(bytes)
	const layout = layoutDocument(loaded.model, loaded.resolver, loaded.fonts, new HmtxMeasurer(), {
		sliceMs: Infinity,
		store: loaded.store,
		view: editor.view
	})

	await layout.done

	const media = partsOf(bytes)

	return layout.pages.map(page => digestPage(layout, page, media))
}

export async function savePaged(run: PagedRun): Promise<{ bytes: Uint8Array; changedParts: readonly string[] }> {
	const result = await saveDocx({ pkg: run.pkg, context: run.context, sessions: run.editor.sessions })

	if (result.bytes === undefined) throw new Error("Save returned no bytes")

	return { bytes: result.bytes, changedParts: result.changedParts }
}

// Hears the typed reasons each of the editor's sessions refuses a user edit with (sessions added later are
// subscribed on the next call).
export function refusalListener(editor: PagedEditor, onReason: (reason: string) => void): () => void {
	const heard = new WeakSet<DocxEditorSession>()

	return () => {
		for (const session of editor.sessions) {
			if (heard.has(session)) continue

			heard.add(session)
			session.onRefused(onReason)
		}
	}
}

// Every story's current document: a step applied an edit when any of them changed.
export function documents(editor: PagedEditor): readonly Node[] {
	return editor.sessions.map(session => session.state.doc)
}

export function storiesOf(editor: PagedEditor): readonly Story[] {
	return editor.body.session.context.model.stories
}

// Moves editing into story `index` (shown on the first page), as a click into a header or note does.
export function enterStory(editor: PagedEditor, index: number): boolean {
	return editor.enterStory(index, 0)
}

export function exitStory(editor: PagedEditor): void {
	editor.exitStory()
}

// Editor-level commands: story commands go to the active story, undo and redo follow edits across stories.
export function editorExecute(editor: PagedEditor, command: DocxEditorCommand): boolean | Promise<boolean> {
	return editor.execute(command)
}

// Switches the revision view in place; false when it already shows it.
export function setView(editor: PagedEditor, view: NonNullable<View>): boolean {
	return editor.setView(VIEWS[view])
}

export function viewName(editor: PagedEditor): string {
	return Object.entries(VIEWS).find(([, value]) => value === editor.view)?.[0] ?? String(editor.view)
}

// Suspends layout (another surface shows the document) or resumes it; true when it is now suspended.
export function toggleSuspended(editor: PagedEditor): boolean {
	if (editor.suspended) editor.resume()
	else editor.suspend()

	return editor.suspended
}

export function isSuspended(editor: PagedEditor): boolean {
	return editor.suspended
}

export function resume(editor: PagedEditor): void {
	editor.resume()
}

// A new, unreferenced story of `kind` (what inserting a note, comment, header or footer starts with).
export function addStory(editor: PagedEditor, kind: NewStoryKind): DocxEditorSession | undefined {
	return editor.addStory(kind)
}

export function storyIndex(session: DocxEditorSession): number {
	return session.story.story.index
}

// ---- editing without layout (damage fuzz) ----

export interface Editable {
	readonly pkg: DocxPackage
	readonly model: DocxModel
	readonly context: DocxEditContext
	readonly mainPart: string
	readonly numIds: readonly number[]
	readonly styleIds: readonly string[]
}

async function partText(pkg: DocxPackage, kind: string): Promise<string> {
	const name = pkg.part(kind)

	return name === undefined ? "" : new TextDecoder().decode(await pkg.opc.read(name))
}

// The document opened for editing, or why it is not: unopenable, no body, view-only, or an exception (which
// the fuzz reports as a failure unless the reason is expected; see config.expectedRefusal).
export async function openEditable(bytes: Uint8Array): Promise<Editable | { refused: string }> {
	const opened = await openDocxPackage(bytesSource(bytes))

	if (!opened.ok) return { refused: `unopenable (${opened.reason})` }

	const pkg = opened.package
	let model: DocxModel
	let context: DocxEditContext

	try {
		model = await buildDocxModel(pkg)
		context = await openDocxEditContext(pkg, model)
	} catch (error) {
		return { refused: `open threw (${error instanceof Error ? error.message.slice(0, 200) : String(error)})` }
	}

	if (model.body === undefined) return { refused: "no body" }
	if (context.gate.length > 0) return { refused: `view-only (${context.gate.join(", ")})` }

	const numIds: number[] = []
	const styleIds: string[] = []

	try {
		for (const match of (await partText(pkg, "numbering")).matchAll(/<w:num w:numId="(\d+)"/g)) numIds.push(Number(match[1]))
	} catch {
		// An unreadable part leaves the op without ids to pick.
	}

	try {
		for (const match of (await partText(pkg, "styles")).matchAll(/w:styleId="([^"]+)"/g)) styleIds.push(match[1] ?? "")
	} catch {
		// As above.
	}

	return { pkg, model, context, mainPart: pkg.mainPart, numIds, styleIds }
}

// The writer's Gate 1, memoised per source block: a damage sequence asks for the same blocks again and again.
export function memoisedProof(context: DocxEditContext): BlockProof {
	const proof = writerProof(context)
	const memo = new Map<string, ReturnType<BlockProof["check"]>>()

	return {
		check(node, story) {
			const key = `${story.story.index}:${String(node.attrs["src"])}:${node.type.name}`

			if (memo.has(key)) return memo.get(key)

			const verdict = proof.check(node, story)

			memo.set(key, verdict)

			return verdict
		}
	}
}

export function bodySession(editable: Editable, proof: BlockProof): DocxEditorSession {
	return new DocxEditorSession(editable.context, { proof })
}

// The stories besides the body (headers, footers, notes, comments, text boxes).
export function otherStories(editable: Editable): readonly Story[] {
	return editable.model.stories.filter(story => story !== editable.model.body)
}

export function storySession(editable: Editable, story: Story, proof: BlockProof): DocxEditorSession {
	return new DocxEditorSession(editable.context, { story, proof })
}

export function sessionDescription(session: DocxEditorSession): string {
	const story = session.story.story

	return `session ${story.kind} ${story.id} part ${story.part} parent ${story.parent}`
}

// Whether the session still holds the document it opened with.
export function sessionPristine(session: DocxEditorSession): boolean {
	return session.state.doc === session.story.doc
}

export function sessionUnchanged(session: DocxEditorSession): boolean {
	return session.state.doc.eq(session.story.doc)
}

export async function saveSessions(
	editable: Editable,
	sessions: readonly DocxEditorSession[]
): Promise<{ bytes: Uint8Array; changedParts: readonly string[] }> {
	const result = await saveDocx({ pkg: editable.pkg, context: editable.context, sessions })

	if (result.bytes === undefined) throw new Error("Save returned no bytes")

	return { bytes: result.bytes, changedParts: result.changedParts }
}

// Reopens saved bytes as the viewer would: undefined when they open, else why not.
export async function reopenProblem(bytes: Uint8Array): Promise<string | undefined> {
	const opened = await openDocxPackage(bytesSource(bytes))

	if (!opened.ok) return `reopen: ${opened.reason}`

	const model = await buildDocxModel(opened.package)

	return model.malformed ? `malformed: ${model.malformedParts.join(", ")}` : undefined
}

// Block types (other than paragraphs, which a split shares) that appear twice under one source id.
export function duplicateSources(session: DocxEditorSession): string[] {
	const seen = new Set<number>()
	const out: string[] = []

	session.state.doc.descendants(node => {
		if (node.isInline) return false

		const src = node.attrs["src"]

		if (typeof src === "number" && src >= 0) {
			if (seen.has(src) && node.type !== docxSchema.nodes.paragraph) out.push(node.type.name)

			seen.add(src)
		}

		return node.type !== docxSchema.nodes.locked_block
	})

	return out
}

export interface ParagraphSignature {
	readonly props: string
	readonly text: string
	readonly fmt: string
}

function toggleValue(mark: { readonly attrs: Readonly<Record<string, unknown>> } | undefined): string {
	if (mark === undefined) return ""

	const value = mark.attrs["value"]

	return value === true ? "1" : value === false ? "0" : ""
}

// The file's names of the marker kinds the editor names otherwise.
const FILE_MARKER_NAMES: Readonly<Record<string, string>> = { permissionStart: "permStart", permissionEnd: "permEnd" }

const MARKERS =
	/<w:(bookmarkStart|bookmarkEnd|commentRangeStart|commentRangeEnd|commentReference|permStart|permEnd|moveFromRangeStart|moveToRangeStart)\b([^>]*)>/g
const MARKER_ID = /\bw:id="([^"]*)"/
const MARKER_NAME = /\bw:name="([^"]*)"/
const MOVE_STARTS: ReadonlySet<string> = new Set(["moveFromRangeStart", "moveToRangeStart"])

// The key of a marker of the file element `kind`: "<kind>:<w:id>", or "<kind>:name:<w:name>" for a new move range
// start (the save writes one with a w:id of its own, a revision id, and keeps its name).
function markerKey(kind: string, id: string, newMove: string | null): string {
	return newMove === null ? `${kind}:${id}` : `${kind}:name:${newMove}`
}

// The move range starts of written bytes, as "<kind>:<w:id>:<w:name>".
export function moveStarts(bytes: Uint8Array): Set<string> {
	const out = new Set<string>()

	for (const match of new TextDecoder().decode(bytes).matchAll(MARKERS)) {
		const attributes = match[2] ?? ""

		if (MOVE_STARTS.has(match[1] ?? ""))
			out.add(`${match[1] ?? ""}:${MARKER_ID.exec(attributes)?.[1] ?? ""}:${MARKER_NAME.exec(attributes)?.[1] ?? ""}`)
	}

	return out
}

// Range markers and comment references in written bytes, keyed by markerKey, added to `out`. With
// `sourceMoves` (moveStarts of the source), the bytes are a save's: a move range start not among them is new.
export function markerCounts(bytes: Uint8Array, out = new Map<string, number>(), sourceMoves?: ReadonlySet<string>): Map<string, number> {
	for (const match of new TextDecoder().decode(bytes).matchAll(MARKERS)) {
		const kind = match[1] ?? ""
		const attributes = match[2] ?? ""
		const id = MARKER_ID.exec(attributes)?.[1]

		if (id === undefined) continue

		const name = MARKER_NAME.exec(attributes)?.[1] ?? ""
		const newMove =
			sourceMoves !== undefined && MOVE_STARTS.has(kind) && name !== "" && !sourceMoves.has(`${kind}:${id}:${name}`) ? name : null
		const key = markerKey(kind, id, newMove)

		out.set(key, (out.get(key) ?? 0) + 1)
	}

	return out
}

// `document` without the content of its text boxes.
export function withoutTextBoxes(document: Uint8Array): Uint8Array {
	const text = new TextDecoder().decode(document)

	return text.includes("<w:txbxContent")
		? new TextEncoder().encode(text.replace(/<w:txbxContent\b[\s\S]*?<\/w:txbxContent>/g, ""))
		: document
}

// Blocks and atoms the writer copies as their source bytes, whatever stories sit in them (text boxes, the
// mc:Fallback copy of one): their markers are counted in those bytes.
const BYTE_COPIES: ReadonlySet<NodeType> = new Set([
	docxSchema.nodes.locked_block,
	docxSchema.nodes.drawing,
	docxSchema.nodes.run_object,
	docxSchema.nodes.opaque_inline
])

// Range markers and comment references a session's story is written with (inline, in block and story lists,
// in atoms and locked blocks kept as bytes), keyed by markerKey as the damage fuzz counts a
// written file's. `textBoxes` false leaves out those in the text boxes of drawings kept as bytes.
export function editorMarkers(session: DocxEditorSession, textBoxes = true): Map<string, number> {
	const out = new Map<string, number>()
	const part = session.context.model.parts[session.story.story.part]
	const add = (list: unknown): void => {
		if (!Array.isArray(list)) return

		for (const marker of list as MarkerList) {
			if (marker.id === null) continue

			const kind = FILE_MARKER_NAMES[marker.kind] ?? marker.kind
			const name = (marker as Partial<MarkerNodeAttrs>).name
			const newMove = marker.src === NO_SOURCE && MOVE_STARTS.has(kind) && typeof name === "string" && name !== "" ? name : null
			const key = markerKey(kind, marker.id, newMove)

			out.set(key, (out.get(key) ?? 0) + 1)
		}
	}
	// Counts a byte copy's markers in its source bytes; false when it has none.
	const copied = (node: Node): boolean => {
		const item = node.attrs["src"] as number | null

		if (part === undefined || item === null || item < 0) return false

		const bytes = part.document.bytes.subarray(part.start(item), part.byteEnd(item))

		markerCounts(textBoxes ? bytes : withoutTextBoxes(bytes), out)

		return true
	}
	const doc = session.state.doc

	add(doc.attrs["end"])
	doc.descendants(node => {
		if (node.isInline) {
			if (!BYTE_COPIES.has(node.type) || !copied(node)) add(survivorsOf(node))
		} else {
			add(node.attrs["before"])
			add(node.attrs["end"])

			if (node.isLeaf && !(BYTE_COPIES.has(node.type) && copied(node))) add(node.attrs["markers"])
		}

		return true
	})

	return out
}

// The editor's paragraphs as the independent reader signs a written paragraph: style, list, alignment (as written:
// start and end as left and right), text
// and per-character bold/italic/underline/strike/deleted. Paragraphs of locked blocks are left out.
export function editorSignatures(doc: Node): ParagraphSignature[] {
	const marks = docxSchema.marks
	const out: ParagraphSignature[] = []

	doc.descendants(node => {
		if (node.type === docxSchema.nodes.locked_block) return false
		if (node.type !== docxSchema.nodes.paragraph) return !node.isInline

		const numId = node.attrs["numId"] as number | null
		const props = JSON.stringify([
			node.attrs["styleId"],
			numId === null ? null : numId < 0 ? "NEW" : numId,
			node.attrs["ilvl"],
			typeof node.attrs["align"] === "string" ? writtenJustification(node.attrs["align"]) : node.attrs["align"]
		])
		let text = ""
		let fmt = ""
		// Text after a field's begin in this paragraph (a table of contents' first entry) is the field's, as the
		// reader takes it.
		let fields = 0

		node.forEach(child => {
			if (child.type === docxSchema.nodes.field_char) {
				if (child.attrs["kind"] === "begin") fields++
				else if (child.attrs["kind"] === "end" && fields > 0) fields--

				return
			}

			if (!child.isText || fields > 0) return

			const set = child.marks
			const underline = marks.underline.isInSet(set)
			const format =
				[
					toggleValue(marks.bold.isInSet(set)),
					toggleValue(marks.italic.isInSet(set)),
					underline === undefined ? "" : String(underline.attrs["style"]),
					toggleValue(marks.strike.isInSet(set))
				].join("|") + (marks.deletion.isInSet(set) ? "|D" : "")
			// Written run by run, a lone surrogate (a raw edit can split a pair) as U+FFFD.
			const value = (child.text ?? "").toWellFormed()

			text += value
			fmt += `${format};`.repeat(value.length)
		})

		out.push({ props, text, fmt })

		return false
	})

	return out
}

// ---- schema oracle: xmllint against the ECMA-376 Transitional schemas ----

// The pinned Part 4 archive: FILEN_OFFICE_WML_SCHEMAS, else the cache `pnpm run generate:wml-order --fetch` fills.
export const SCHEMA_ARCHIVE = process.env["FILEN_OFFICE_WML_SCHEMAS"] || SCHEMA_CACHE
export const XMLLINT = spawnSync("xmllint", ["--version"]).status === 0

// The XML namespace's attributes as XML 1.0 defines them; wml.xsd imports the namespace without a location.
const XML_SCHEMA =
	'<?xml version="1.0"?><xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="http://www.w3.org/XML/1998/namespace">' +
	'<xs:attribute name="space"><xs:simpleType><xs:restriction base="xs:NCName"><xs:enumeration value="default"/><xs:enumeration value="preserve"/></xs:restriction></xs:simpleType></xs:attribute>' +
	'<xs:attribute name="lang" type="xs:language"/></xs:schema>'
// Word's extensions (w14, w15, mc...) are outside the schema: errors about them say nothing of the writer.
const EXTENSIONS = /\{http:\/\/schemas\.microsoft\.com\/|\{http:\/\/schemas\.openxmlformats\.org\/markup-compatibility\//

// Writes the schemas to a new temporary directory and returns it.
export function schemaDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "filen-office-wml-"))

	for (const [name, bytes] of transitionalSchemas(new Uint8Array(readFileSync(SCHEMA_ARCHIVE)))) {
		const text = new TextDecoder().decode(bytes)

		writeFileSync(
			join(directory, name),
			text.replace(
				'<xsd:import namespace="http://www.w3.org/XML/1998/namespace"/>',
				'<xsd:import namespace="http://www.w3.org/XML/1998/namespace" schemaLocation="xml.xsd"/>'
			)
		)
	}

	writeFileSync(join(directory, "xml.xsd"), XML_SCHEMA)

	return directory
}

// One xmllint call may take this long (the largest corpus part takes seconds); longer fails the run.
const XMLLINT_TIMEOUT_MS = 300_000

// Validity errors by message (line numbers and xmllint's list of expected elements left out), counted. The
// XML goes to xmllint as a file and its report comes back in one, with no pipe to the child: piping the input
// through spawnSync's stdin hung for good now and then on macOS (xmllint had read all that was written and
// waited on a stdin node never finished writing or closed, both at 0% CPU).
export function validityErrors(schema: string, bytes: Uint8Array): Map<string, number> {
	const input = join(dirname(schema), "input.xml")
	const report = join(dirname(schema), "report.txt")

	writeFileSync(input, bytes)

	const output = openSync(report, "w")
	let result: SpawnSyncReturns<Buffer>

	try {
		result = spawnSync("xmllint", ["--noout", "--schema", schema, input], {
			stdio: ["ignore", "ignore", output],
			timeout: XMLLINT_TIMEOUT_MS,
			killSignal: "SIGKILL"
		})
	} finally {
		closeSync(output)
	}

	if (result.error !== undefined || result.signal !== null)
		throw new Error(`xmllint failed on ${bytes.length} bytes: ${result.error?.message ?? `killed by ${result.signal}`}`)

	const errors = new Map<string, number>()

	for (const line of readFileSync(report, "utf8").split("\n")) {
		if (!line.includes("validity error") || EXTENSIONS.test(line)) continue

		const message = line
			.slice(line.startsWith(input) ? input.length : 0)
			.replace(/^:\d+: /, "")
			.replace(/ Expected is .*$/, "")

		errors.set(message, (errors.get(message) ?? 0) + 1)
	}

	rmSync(input, { force: true })
	rmSync(report, { force: true })

	return errors
}

// validityErrors against wml.xsd; throws where xmllint or the schemas are missing.
export function schemaOracle(): (bytes: Uint8Array) => Map<string, number> {
	if (!XMLLINT || !existsSync(SCHEMA_ARCHIVE)) throw new Error("The schema oracle needs xmllint and the WordprocessingML schemas")

	const directory = schemaDirectory()

	process.once("exit", () => rmSync(directory, { recursive: true, force: true }))

	return bytes => validityErrors(join(directory, "wml.xsd"), bytes)
}

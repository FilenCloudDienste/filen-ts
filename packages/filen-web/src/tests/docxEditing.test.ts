import { readFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { bytesSource } from "@filen/office/core/opc"
import { buildDocxModel, openDocxPackage } from "@filen/office/core/docx"
import { TextSelection } from "prosemirror-state"
import { DocxEditorSession, openDocxEditContext } from "@filen/office/core/docx/edit"
import type { DocxPrepareOptions, DocxSaveInput } from "@filen/office/core/docx/write"
import type { DocxEditingHost } from "@filen/office/dom/docx/editing"
import { inThreadDocxZipper } from "@filen/office/dom/docx/save"

// Saving with the writer refusing some edited blocks: they are locked back to the file's own and the rest is
// written (decision 5 at save time); a refusal no lock resolves leaves the document as it was.

// `tables`: refuses a document holding a table; `from`: refuses every run from that one on.
const writer = vi.hoisted(() => ({
	refuse: "",
	always: false,
	tables: false,
	from: 0,
	runs: 0,
	during: undefined as (() => void) | undefined
}))

type Doc = DocxEditorSession["state"]["doc"]

// Whether `doc` still holds the refused text outside locked blocks.
function holds(doc: Doc, text: string): boolean {
	let found = false

	doc.descendants(node => {
		if (node.type.name === "locked_block") return false
		if (node.isTextblock && node.textContent.includes(text)) found = true

		return !found
	})

	return found
}

function hasTable(doc: Doc): boolean {
	let found = false

	doc.descendants(node => {
		if (node.type.name === "table") found = true

		return !found && !node.isTextblock
	})

	return found
}

vi.mock("@filen/office/core/docx/write", async () => {
	const actual = await vi.importActual<typeof import("@filen/office/core/docx/write")>("@filen/office/core/docx/write")
	const refused = (input: DocxSaveInput): boolean => {
		writer.runs++
		// The user types while the writer runs (from its second run: the search).
		if (writer.runs === 2) writer.during?.()

		return (
			writer.always ||
			(writer.from > 0 && writer.runs >= writer.from) ||
			(writer.tables && input.sessions.some(session => hasTable(session.state.doc))) ||
			(writer.refuse.length > 0 && input.sessions.some(session => holds(session.state.doc, writer.refuse)))
		)
	}

	return {
		...actual,
		prepareDocxSave: (input: DocxSaveInput, options?: DocxPrepareOptions) =>
			refused(input) ? Promise.reject(new actual.DocxSaveError("content", "refused")) : actual.prepareDocxSave(input, options)
	}
})
vi.mock("@/features/preview/lib/docxEngine", () => ({ DOCX_FONT_URLS: {} }))
vi.mock("@/lib/log", () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

const { writeDocx } = await import("@/features/preview/lib/docxEditing")
const { DocxSaveError, prepareDocxSave } = await import("@filen/office/core/docx/write")

// Tests run from the package's directory.
const BYTES = new Uint8Array(readFileSync(join(process.cwd(), "../filen-office/src/tests/fixtures/01-plain.docx")))

async function openSession(bytes: Uint8Array): Promise<{ session: DocxEditorSession; host: DocxEditingHost }> {
	const opened = await openDocxPackage(bytesSource(bytes))

	if (!opened.ok) throw new Error(opened.reason)

	const context = await openDocxEditContext(opened.package, await buildDocxModel(opened.package))
	const session = new DocxEditorSession(context)
	const pkg = opened.package
	const zipper = inThreadDocxZipper(pkg.opc)
	// The editing host's save path (DocxEditingHost.save / prepare) on this document, without the editor.
	const prepare = (sessions: readonly DocxEditorSession[] = [session]) => prepareDocxSave({ pkg, context, sessions }, {})
	const host = {
		saveInput: () => ({ pkg, context, sessions: [session] }),
		prepare,
		save: async (sessions?: readonly DocxEditorSession[]) => {
			const prepared = await prepare(sessions)
			const zipped = await zipper.zip(prepared)

			return { bytes: zipped.bytes, changedParts: zipped.changedParts, timings: { ...prepared, ...zipped } }
		}
	} as unknown as DocxEditingHost

	return { session, host }
}

// Appends text to the first `count` non-empty top-level paragraphs, one string each.
function editParagraphs(session: DocxEditorSession, texts: readonly string[]): void {
	const ends: number[] = []

	session.state.doc.forEach((node, offset) => {
		if (ends.length < texts.length && node.type.name === "paragraph" && node.textContent.length > 0)
			ends.push(offset + 1 + node.content.size)
	})
	ends.forEach((end, index) => {
		const text = texts[index] ?? ""
		const shift = texts.slice(0, index).reduce((sum, added) => sum + added.length, 0)

		session.dispatch(session.state.tr.insertText(text, end + shift))
	})
}

async function textOf(bytes: Uint8Array): Promise<string> {
	const { session } = await openSession(bytes)

	return session.state.doc.textBetween(0, session.state.doc.content.size, "\n", "")
}

// The top-level paragraphs' text, locked ones as "locked:".
function texts(doc: Doc): string[] {
	const out: string[] = []

	doc.forEach(node => {
		if (node.type.name === "locked_block") out.push(`locked:${String(node.attrs["text"])}`)
		else if (node.textContent.length > 0) out.push(node.textContent)
	})

	return out
}

afterEach(() => {
	writer.refuse = ""
	writer.always = false
	writer.tables = false
	writer.from = 0
	writer.runs = 0
	writer.during = undefined
})

describe("writeDocx", () => {
	it("hands on what the file's writer says it wrote otherwise than the edit has it", async () => {
		const { session, host } = await openSession(BYTES)
		const notices = [{ kind: "commentPoint", count: 2 }] as const
		const save = host.save.bind(host)
		const noting = {
			...host,
			save: async (sessions?: readonly DocxEditorSession[]) => ({ ...(await save(sessions)), notices })
		} as DocxEditingHost

		editParagraphs(session, [" more"])

		expect((await writeDocx(noting)).notices).toEqual(notices)
		expect((await writeDocx(host)).notices).toBeUndefined()
	})

	it("writes the refused blocks as last saved, and takes them back only once stored, as an undoable step", async () => {
		const { session, host } = await openSession(BYTES)

		editParagraphs(session, [" KEPT", " BAD", " ALSO"])

		const edited = session.state.doc

		writer.refuse = "BAD"

		const written = await writeDocx(host)

		expect(written.locked?.count).toBe(1)
		expect(written.locked?.text).toContain("BAD")

		const saved = await textOf(written.bytes)

		expect(saved).toContain("KEPT")
		expect(saved).toContain("ALSO")
		expect(saved).not.toContain("BAD")
		// Nothing changes in the editor before the file is stored.
		expect(session.state.doc).toBe(edited)
		written.commit()
		expect(holds(session.state.doc, "BAD")).toBe(false)
		expect(texts(session.state.doc).some(text => text.startsWith("locked:"))).toBe(true)
		expect(session.snapshot().dirty).toBe(false)
		// Undo brings the edit back (unsaved again).
		session.execute({ type: "history.undo" })
		expect(holds(session.state.doc, "BAD")).toBe(true)
		expect(session.snapshot().dirty).toBe(true)
	})

	it("reports how many blocks it really took back: one edited while the file was stored keeps that edit", async () => {
		const { session, host } = await openSession(BYTES)

		editParagraphs(session, [" BAD", " ALSO BAD"])
		writer.refuse = "BAD"

		const written = await writeDocx(host)

		expect(written.locked).toMatchObject({ count: 2, reverted: 0 })
		// Typed into the first block during the upload.
		editParagraphs(session, ["!"])
		written.commit()
		expect(written.locked?.reverted).toBe(1)
		expect(holds(session.state.doc, "BAD!")).toBe(true)
		expect(session.snapshot().dirty).toBe(true)
	})

	it("searches the document as the save found it: typing meanwhile is neither written nor taken back, and stays unsaved", async () => {
		const { session, host } = await openSession(BYTES)

		editParagraphs(session, [" KEPT", " BAD"])
		writer.refuse = "BAD"
		// Typed at the very start while the search runs: every block after it moves.
		writer.during = () => {
			session.dispatch(session.state.tr.insertText("TYPED ", 1))
		}

		const written = await writeDocx(host)
		const saved = await textOf(written.bytes)

		expect(saved).toContain("KEPT")
		expect(saved).not.toContain("BAD")
		expect(saved).not.toContain("TYPED")
		written.commit()
		expect(written.locked?.reverted).toBe(1)
		expect(holds(session.state.doc, "BAD")).toBe(false)
		expect(holds(session.state.doc, "KEPT")).toBe(true)
		expect(texts(session.state.doc)[0]?.startsWith("TYPED ")).toBe(true)
		expect(session.snapshot().dirty).toBe(true)
	})

	it("leaves the editor as it was when the upload fails (no commit)", async () => {
		const { session, host } = await openSession(BYTES)

		editParagraphs(session, [" BAD"])

		const edited = session.state.doc

		writer.refuse = "BAD"

		const written = await writeDocx(host)

		expect(written.locked?.count).toBe(1)
		// The upload failed: commit() never runs.
		expect(session.state.doc).toBe(edited)
		expect(session.snapshot().dirty).toBe(true)
	})

	it("takes a block back to how it was last saved, not to how the file opened", async () => {
		const { session, host } = await openSession(BYTES)

		editParagraphs(session, [" SAVED"])
		;(await writeDocx(host)).commit()
		editParagraphs(session, [" BAD"])
		writer.refuse = "BAD"

		const written = await writeDocx(host)

		expect(await textOf(written.bytes)).toContain("SAVED")
		written.commit()
		expect(texts(session.state.doc)[0]).toContain("SAVED")
		expect(texts(session.state.doc)[0]).not.toContain("BAD")
		expect(session.snapshot().dirty).toBe(false)
	})

	it("never searches for an autosave, and refuses a state it could not resolve at once", async () => {
		const { session, host } = await openSession(BYTES)

		editParagraphs(session, [" BAD"])
		writer.refuse = "BAD"
		await expect(writeDocx(host, { auto: true })).rejects.toBeInstanceOf(DocxSaveError)
		expect(writer.runs).toBe(1)

		writer.always = true
		writer.runs = 0

		const search = vi.fn()

		await expect(writeDocx(host, { onSearch: search })).rejects.toBeInstanceOf(DocxSaveError)
		expect(search).toHaveBeenCalledTimes(1)

		const runs = writer.runs

		// The same state again: refused without running the writer.
		await expect(writeDocx(host)).rejects.toBeInstanceOf(DocxSaveError)
		expect(writer.runs).toBe(runs)
		// Changed: tried again.
		editParagraphs(session, ["!"])
		await expect(writeDocx(host)).rejects.toBeInstanceOf(DocxSaveError)
		expect(writer.runs).toBeGreaterThan(runs)
	})

	it("refuses with the writer's error when nothing helps, leaving the document as it was", async () => {
		const { session, host } = await openSession(BYTES)

		editParagraphs(session, [" EDIT"])

		const before = session.state.doc

		writer.always = true
		await expect(writeDocx(host)).rejects.toBeInstanceOf(DocxSaveError)
		expect(session.state.doc).toBe(before)
	})
	it("writes without a table the writer refuses, takes it back once stored, and remembers a refusal it does not resolve", async () => {
		const { session, host } = await openSession(BYTES)
		const insertTable = (): void => {
			session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, 1)))
			expect(session.execute({ type: "table.insert", rows: 1, cols: 1 })).toBe(true)
		}

		expect(hasTable(session.state.doc)).toBe(false)
		insertTable()
		writer.tables = true

		const written = await writeDocx(host)

		expect(written.locked).toMatchObject({ count: 1, reverted: 0 })
		expect(hasTable(session.state.doc)).toBe(true)
		written.commit()
		expect(written.locked?.reverted).toBe(1)
		expect(hasTable(session.state.doc)).toBe(false)

		// Refused again even with the table taken back: that state is not searched again.
		insertTable()
		writer.runs = 0
		writer.from = 3
		await expect(writeDocx(host)).rejects.toBeInstanceOf(DocxSaveError)

		const runs = writer.runs

		await expect(writeDocx(host)).rejects.toBeInstanceOf(DocxSaveError)
		expect(writer.runs).toBe(runs)
	})
})

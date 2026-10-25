// @vitest-environment happy-dom

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { bytesSource } from "@filen/office/core/opc"
import { buildDocxModel, openDocxPackage } from "@filen/office/core/docx"
import { DocxEditorSession, openDocxEditContext } from "@filen/office/core/docx/edit"
import type { PagedEditor } from "@filen/office/core/docx/paged"
import type { FontExtents, TextMeasurer } from "@filen/office/core/text"
import type { DocxEditingHost } from "@filen/office/dom/docx/editing"
import { i18n } from "@/lib/i18n"
import { registerAllActions } from "@/lib/keymap/actions"

// The DOCX editor's web side on a real document: the in-thread editing host with the writer's proof, the
// toolbar's commands, dirty reporting, find, the overlay's save source and idle autosave. Text is measured by
// a stand-in (no fonts or canvas here).

const hooks = vi.hoisted(() => ({
	hosts: [] as DocxEditingHost[],
	settings: { authorName: null as string | null, autosave: true, loaded: true },
	// What the context menu's Paste reads.
	clipboard: null as { html?: string; text?: string } | null,
	// Replaces the writer when set.
	write: undefined as
		| ((
				host: DocxEditingHost,
				options?: import("@/features/preview/lib/docxEditing").WriteDocxOptions
		  ) => Promise<import("@/features/preview/lib/docxEditing").DocxSaveSnapshot>)
		| undefined
}))
const toasts = vi.hoisted(() => ({ warning: vi.fn(), info: vi.fn(), success: vi.fn(), error: vi.fn(), loading: vi.fn(), dismiss: vi.fn() }))

const measurer: TextMeasurer = {
	kerningControl: true,
	measure(font, _kerning, texts, count, widths) {
		const size = Number(/([\d.]+)px/.exec(font)?.[1] ?? "16")

		for (let i = 0; i < count; i++) widths[i] = (texts[i] ?? "").length * size * 0.5
	},
	fontExtents(font): FontExtents {
		const size = Number(/([\d.]+)px/.exec(font)?.[1] ?? "16")

		return { ascent: size * 0.8, descent: size * 0.2 }
	}
}

vi.mock("@/features/preview/lib/docxEngine", () => ({ DOCX_FONT_URLS: {} }))
vi.mock("@/features/preview/lib/docxEditing", async () => {
	const actual = await vi.importActual<typeof import("@/features/preview/lib/docxEditing")>("@/features/preview/lib/docxEditing")
	const { inThreadEditingHost } = await vi.importActual<typeof import("@filen/office/dom/docx/editing")>("@filen/office/dom/docx/editing")
	const { prepareDocxSave, writerProof } =
		await vi.importActual<typeof import("@filen/office/core/docx/write")>("@filen/office/core/docx/write")

	return {
		...actual,
		writeDocx: (host: DocxEditingHost, options?: import("@/features/preview/lib/docxEditing").WriteDocxOptions) =>
			hooks.write?.(host, options) ?? actual.writeDocx(host, options),
		docxEditingHost: () => {
			const host = inThreadEditingHost(
				() => ({
					fontHost: { addBytes: () => Promise.resolve(true), addLocal: () => Promise.resolve(false), remove: () => undefined },
					replayFonts: false,
					fontAssets: { read: () => Promise.resolve(new Uint8Array(4)) },
					measurer,
					yield: () => new Promise<void>(resolve => setTimeout(resolve, 0)),
					sliceMs: 8
				}),
				{ proof: writerProof, writer: { prepare: prepareDocxSave } }
			)

			hooks.hosts.push(host)

			return host
		}
	}
})
// Spelling checks nothing here (no dictionary for any language).
vi.mock("@/features/spellcheck/lib/spellcheck", () => ({
	defaultSpellingLanguage: () => "en-US",
	documentSpellingChecker: {
		dictionaryFor: () => undefined,
		known: () => undefined,
		check: () => Promise.resolve(),
		suggest: () => Promise.resolve([]),
		addToDictionary: () => Promise.resolve(),
		subscribe: () => () => undefined
	}
}))
vi.mock("@/features/office/lib/officeSettings", () => ({
	loadOfficeSettings: () => Promise.resolve(),
	saveOfficeAutosave: () => Promise.resolve(),
	useOfficeSettings: () => hooks.settings
}))
vi.mock("sonner", () => ({ toast: toasts }))
vi.mock("@/features/preview/components/docxEditor.logic", async () => ({
	...(await vi.importActual<typeof import("@/features/preview/components/docxEditor.logic")>(
		"@/features/preview/components/docxEditor.logic"
	)),
	AUTOSAVE_IDLE_MS: 200
}))
vi.mock("@/lib/useIsOnline", () => ({ useIsOnline: () => true }))
vi.mock("@/features/preview/lib/docxClipboard", async () => ({
	...(await vi.importActual<typeof import("@/features/preview/lib/docxClipboard")>("@/features/preview/lib/docxClipboard")),
	readEditorClipboard: () => Promise.resolve(hooks.clipboard)
}))
vi.mock("@/lib/log", () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

const { DocxEditView } = await import("@/features/preview/components/docxEditor")
const { SaveRefusedError } = await import("@/features/drive/lib/previewSave.logic")
const { DocxSaveError } = await import("@filen/office/core/docx/write")

type DocxSaveSource = NonNullable<Parameters<typeof DocxEditView>[0]["saveRef"]["current"]>

registerAllActions()

// Tests run from the package's directory.
const BYTES = new Uint8Array(readFileSync(join(process.cwd(), "../filen-office/src/tests/fixtures/01-plain.docx")))

async function openEditor(props: { writable?: boolean; onAutosave?: () => boolean } = {}) {
	const onDirtyChange = vi.fn()
	const saveRef: { current: DocxSaveSource | null } = { current: null }

	render(
		<DocxEditView
			bytes={BYTES}
			alt="report.docx"
			writable={props.writable ?? true}
			renamed={false}
			onDirtyChange={onDirtyChange}
			saveRef={saveRef}
			onAutosave={props.onAutosave ?? (() => true)}
			viewer={() => <div>viewer</div>}
		/>
	)

	const host = hooks.hosts.at(-1)

	if (host === undefined) {
		throw new Error("no editing host")
	}

	const editor: PagedEditor = await act(() => host.editor)

	await waitFor(() => {
		expect(screen.getByRole("textbox", { name: "report.docx" })).toBeTruthy()
	})

	return { editor, onDirtyChange, saveRef }
}

function typeAtStart(editor: PagedEditor, text: string): void {
	act(() => {
		let pos = 1

		editor.state.doc.descendants((node, at) => {
			if (pos === 1 && node.isTextblock && node.textContent.length > 0) {
				pos = at + 1
			}

			return pos === 1
		})
		editor.dispatch(editor.state.tr.insertText(text, pos))
	})
}

async function readBack(bytes: Uint8Array): Promise<string> {
	const opened = await openDocxPackage(bytesSource(bytes))

	if (!opened.ok) {
		throw new Error(opened.reason)
	}

	const session = new DocxEditorSession(await openDocxEditContext(opened.package, await buildDocxModel(opened.package)))

	return session.state.doc.textBetween(0, session.state.doc.content.size, "\n", "")
}

afterEach(() => {
	cleanup()
	hooks.hosts.length = 0
	hooks.settings = { authorName: null, autosave: true, loaded: true }
	hooks.write = undefined
	hooks.clipboard = null
	vi.clearAllMocks()
})

describe("DocxEditView", () => {
	it("reports edits as unsaved, saves them through the writer and marks exactly that saved", async () => {
		const { editor, onDirtyChange, saveRef } = await openEditor()

		expect(onDirtyChange).toHaveBeenLastCalledWith(false)
		typeAtStart(editor, "Edited: ")
		await waitFor(() => {
			expect(onDirtyChange).toHaveBeenLastCalledWith(true)
		})

		const save = saveRef.current

		if (save === null) {
			throw new Error("no save source")
		}

		const snapshot = await act(() => save())

		expect(await readBack(snapshot.bytes)).toContain("Edited: ")
		// An edit while the file uploads stays unsaved after the commit.
		typeAtStart(editor, "Later ")
		act(() => {
			snapshot.commit()
		})
		await waitFor(() => {
			expect(onDirtyChange).toHaveBeenLastCalledWith(true)
		})
		expect(editor.sessions.some(session => session.snapshot().dirty)).toBe(true)
	})

	it("stays editable while a save writes: what is typed meanwhile is kept, unsaved, for the next save", async () => {
		hooks.settings = { authorName: "Ann", autosave: false, loaded: true }

		const { editor, onDirtyChange, saveRef } = await openEditor()
		const actual = await vi.importActual<typeof import("@/features/preview/lib/docxEditing")>("@/features/preview/lib/docxEditing")
		let release: () => void = () => undefined
		const held = new Promise<void>(resolve => {
			release = resolve
		})

		// The writer reads the document as it starts, then takes its time.
		hooks.write = async (host, options) => {
			const written = actual.writeDocx(host, options)

			await held

			return written
		}
		typeAtStart(editor, "First ")

		const save = saveRef.current

		if (save === null) {
			throw new Error("no save source")
		}

		const saving = save()

		await waitFor(() => {
			expect(hooks.hosts.length).toBeGreaterThan(0)
		})
		// Neither the editing area nor the toolbar goes read-only.
		expect(screen.getByRole("textbox", { name: "report.docx" }).getAttribute("aria-readonly")).toBeNull()
		expect(screen.getByRole("button", { name: "Bold" }).hasAttribute("disabled")).toBe(false)
		typeAtStart(editor, "During ")
		release()

		const snapshot = await act(() => saving)

		expect(await readBack(snapshot.bytes)).toContain("First ")
		expect(await readBack(snapshot.bytes)).not.toContain("During ")
		act(() => {
			snapshot.commit()
		})
		expect(editor.sessions.some(session => session.snapshot().dirty)).toBe(true)
		await waitFor(() => {
			expect(onDirtyChange).toHaveBeenLastCalledWith(true)
		})

		hooks.write = undefined

		const next = await act(() => save())

		expect(await readBack(next.bytes)).toContain("During First ")
	})

	it("keeps the track switch unsaved when it is turned after the save read the document", async () => {
		hooks.settings = { authorName: "Ann", autosave: false, loaded: true }

		const { editor, saveRef } = await openEditor()
		const save = saveRef.current

		if (save === null) {
			throw new Error("no save source")
		}

		typeAtStart(editor, "Edited ")

		const snapshot = await act(() => save())

		// Turned on while the file uploads: the file holds it off.
		await act(() => editor.execute({ type: "review.track", on: true }))
		act(() => {
			snapshot.commit()
		})
		expect(editor.snapshot().review.tracking).toBe(true)
		expect(editor.sessions.some(session => session.snapshot().dirty)).toBe(true)
	})

	it("formats through the toolbar and keeps the commands' state in step", async () => {
		const { editor } = await openEditor()

		const bold = await screen.findByRole("button", { name: "Bold" })

		act(() => {
			editor.selectParagraph(1)
		})
		fireEvent.click(bold)
		await waitFor(() => {
			expect(editor.session.snapshot().formats.bold).toBe("on")
		})
		expect(bold.getAttribute("aria-pressed")).toBe("true")

		fireEvent.click(screen.getByRole("button", { name: "Undo" }))
		await waitFor(() => {
			expect(editor.session.snapshot().formats.bold).not.toBe("on")
		})
	})

	it("offers no save while the file cannot be saved, and refuses commands", async () => {
		const { editor, saveRef } = await openEditor({ writable: false })

		expect(saveRef.current).toBeNull()
		expect(screen.getByRole("button", { name: "View only" })).toBeTruthy()
		expect(screen.getByRole("button", { name: "Bold" }).hasAttribute("disabled")).toBe(true)
		expect(editor.session.snapshot().dirty).toBe(false)
	})

	it("saves on its own after a pause in editing, once per pause", async () => {
		const onAutosave = vi.fn(() => true)
		const { editor } = await openEditor({ onAutosave })

		typeAtStart(editor, "A")
		typeAtStart(editor, "B")
		await waitFor(
			() => {
				expect(onAutosave).toHaveBeenCalledTimes(1)
			},
			{ timeout: 2000 }
		)
		await new Promise(resolve => setTimeout(resolve, 400))
		expect(onAutosave).toHaveBeenCalledTimes(1)
		// A save that did not happen (the overlay refused or failed it) is not retried until the next edit.
		typeAtStart(editor, "C")
		await waitFor(
			() => {
				expect(onAutosave).toHaveBeenCalledTimes(2)
			},
			{ timeout: 2000 }
		)
		await new Promise(resolve => setTimeout(resolve, 400))
		expect(onAutosave).toHaveBeenCalledTimes(2)
	})

	it("tries an autosave that could not start again after the next pause, without another edit", async () => {
		const onAutosave = vi.fn().mockReturnValueOnce(false).mockReturnValue(true)
		const { editor } = await openEditor({ onAutosave })

		typeAtStart(editor, "A")
		await waitFor(
			() => {
				expect(onAutosave).toHaveBeenCalledTimes(2)
			},
			{ timeout: 2000 }
		)
		await new Promise(resolve => setTimeout(resolve, 400))
		expect(onAutosave).toHaveBeenCalledTimes(2)
	})

	it("waits for the autosave setting to be read before saving on its own", async () => {
		hooks.settings = { authorName: null, autosave: true, loaded: false }

		const onAutosave = vi.fn(() => true)
		const { editor } = await openEditor({ onAutosave })

		typeAtStart(editor, "A")
		await new Promise(resolve => setTimeout(resolve, 500))
		expect(onAutosave).not.toHaveBeenCalled()
	})

	it("tells which edits a save had to leave out once the file is stored, and offers their text", async () => {
		const { editor, saveRef } = await openEditor()

		typeAtStart(editor, "Edited: ")
		hooks.write = async host => {
			const written = await (
				await vi.importActual<typeof import("@/features/preview/lib/docxEditing")>("@/features/preview/lib/docxEditing")
			).writeDocx(host)

			return { ...written, locked: { count: 2, text: "my words", reverted: 0 } }
		}

		const save = saveRef.current

		if (save === null) {
			throw new Error("no save source")
		}

		const snapshot = await act(() => save())

		// Not before the upload succeeded (the overlay commits then).
		expect(toasts.warning).not.toHaveBeenCalled()
		act(() => {
			snapshot.commit()
		})
		expect(toasts.warning).toHaveBeenCalledTimes(1)
		expect(toasts.warning.mock.calls[0]?.[1]).toMatchObject({ action: { label: "Copy my changes" } })
		// None taken back here (edited while it was stored): no claim that they are back as saved.
		expect(String(toasts.warning.mock.calls[0]?.[0])).toContain("here, unsaved")
		expect(String(toasts.warning.mock.calls[0]?.[0])).not.toContain("back to that here")
	})

	it("holds autosave quietly when the writer refuses one, and says so until a save by the user", async () => {
		const onAutosave = vi.fn(() => true)
		const { editor, saveRef } = await openEditor({ onAutosave })

		typeAtStart(editor, "Edited: ")
		hooks.write = (_host, options) =>
			options?.auto === true ? Promise.reject(new DocxSaveError("content", "refused")) : Promise.reject(new Error("unused"))

		const save = saveRef.current

		if (save === null) {
			throw new Error("no save source")
		}

		const refusal: unknown = await act(() =>
			save({ auto: true }).then(
				() => null,
				(error: unknown) => error
			)
		)

		expect(refusal instanceof SaveRefusedError && refusal.silent).toBe(true)
		expect(screen.getByText(/aren't being saved automatically/)).toBeTruthy()

		// No autosave while held, however long the pause.
		onAutosave.mockClear()
		typeAtStart(editor, "More ")
		await new Promise(resolve => setTimeout(resolve, 500))
		expect(onAutosave).not.toHaveBeenCalled()

		// Undone back to the saved state: nothing to save, the hold ends; the next edit autosaves again.
		act(() => {
			while (editor.session.snapshot().dirty && editor.session.execute({ type: "history.undo" })) {
				// Undo until clean.
			}
		})
		await waitFor(() => {
			expect(screen.queryByText(/aren't being saved automatically/)).toBeNull()
		})
		typeAtStart(editor, "Again ")
		await waitFor(
			() => {
				expect(onAutosave).toHaveBeenCalledTimes(1)
			},
			{ timeout: 2000 }
		)
	})

	it("refuses a save the writer cannot make, keeping the edits and offering their text", async () => {
		const { editor, saveRef } = await openEditor()

		typeAtStart(editor, "Edited: ")
		hooks.write = () => Promise.reject(new DocxSaveError("content", "refused"))

		const save = saveRef.current

		if (save === null) {
			throw new Error("no save source")
		}

		const refusal: unknown = await act(() =>
			save().then(
				() => null,
				(error: unknown) => error
			)
		)

		expect(refusal).toBeInstanceOf(SaveRefusedError)
		expect(refusal instanceof SaveRefusedError ? refusal.action?.labelKey : undefined).toBe("previewDocxSaveRefusedCopy")
		expect(editor.sessions.some(session => session.snapshot().dirty)).toBe(true)
		// The editor is editable again.
		expect(screen.getByRole("button", { name: "Bold" }).hasAttribute("disabled")).toBe(false)
	})

	it("finds in the document from the toolbar and replaces every match in one step", async () => {
		const { editor } = await openEditor()

		typeAtStart(editor, "zebra zebra ")
		fireEvent.click(screen.getByRole("button", { name: "Find in document" }))
		fireEvent.click(await screen.findByRole("menuitem", { name: "Find in document" }))

		const field = await screen.findByRole("searchbox", { name: "Find" })

		fireEvent.change(field, { target: { value: "zebra" } })
		fireEvent.keyDown(field, { key: "Enter" })
		await waitFor(() => {
			expect(screen.getByRole("status").textContent).toContain("of 2")
		})

		fireEvent.click(screen.getByRole("button", { name: "Toggle replace" }))

		const replacement = screen.getByRole("textbox", { name: "Replace with" })

		fireEvent.change(replacement, { target: { value: "okapi" } })
		fireEvent.click(screen.getByRole("button", { name: "Replace all" }))
		await waitFor(() => {
			expect(editor.state.doc.textContent).toContain("okapi okapi")
		})
		expect(editor.state.doc.textContent).not.toContain("zebra")
	})

	it("pastes text the context menu's Paste read into the document (no picture in it)", async () => {
		const { editor } = await openEditor()

		hooks.clipboard = { text: "pasted words" }
		act(() => {
			editor.selectParagraph(1)
		})
		fireEvent.contextMenu(screen.getByRole("textbox", { name: "report.docx" }))
		fireEvent.click(await screen.findByRole("menuitem", { name: "Paste" }))
		await waitFor(() => {
			expect(editor.state.doc.textContent).toContain("pasted words")
		})
	})

	it("offers find and replace in Home's Find menu, and Mobile view on the View tab", async () => {
		await openEditor()

		fireEvent.click(screen.getByRole("button", { name: "Find in document" }))

		const items = (await screen.findAllByRole("menuitem")).map(item => item.textContent)

		expect(items).toEqual(["Find in document", "Find and replace"])
		fireEvent.keyDown(screen.getByRole("menuitem", { name: "Find and replace" }), { key: "Escape" })
		fireEvent.click(screen.getByRole("tab", { name: "View" }))
		expect((await screen.findByRole("button", { name: "Mobile view" })).getAttribute("aria-pressed")).toBe("false")
		expect(screen.getByRole("textbox", { name: "report.docx" })).toBeTruthy()
	})

	it("moves between the document and the ribbon with F6 and Shift+F6, landing on the File menu", async () => {
		await openEditor()

		const area = screen.getByRole("textbox", { name: "report.docx" })

		act(() => {
			area.focus()
		})
		fireEvent.keyDown(area, { key: "F6" })
		expect(document.activeElement?.textContent).toBe("File")
		fireEvent.keyDown(document.activeElement ?? area, { key: "F6", shiftKey: true })
		await waitFor(() => {
			expect(screen.getByRole("textbox", { name: "report.docx" }).contains(document.activeElement)).toBe(true)
		})
	})

	it("shows the Table tab while the caret is in a table, and the context menu offers its rows and columns", async () => {
		const { editor } = await openEditor()

		expect(screen.queryByRole("tab", { name: "Table" })).toBeNull()
		act(() => {
			editor.selectParagraph(1)
			void editor.execute({ type: "table.insert", rows: 2, cols: 3 })
		})
		act(() => {
			let inside = -1

			editor.state.doc.descendants((node, pos) => {
				if (inside < 0 && node.type.name === "table_cell") {
					inside = pos + 2
				}

				return inside < 0
			})
			editor.select({ pos: inside, affinity: 1, page: 0, line: 0, atom: false })
		})

		fireEvent.click(await screen.findByRole("tab", { name: "Table" }))
		fireEvent.click(await screen.findByRole("button", { name: "Insert row below" }))
		await waitFor(() => {
			expect(editor.snapshot().context.table?.rows).toBe(3)
		})

		fireEvent.contextMenu(screen.getByRole("textbox", { name: "report.docx" }))
		expect(await screen.findByRole("menuitem", { name: "Insert column right" })).toBeTruthy()
		fireEvent.click(screen.getByRole("menuitem", { name: "Delete table" }))
		await waitFor(() => {
			expect(editor.snapshot().context.table).toBeNull()
		})
		expect(screen.queryByRole("tab", { name: "Table" })).toBeNull()
		// Its tab gone, the ribbon shows Home again.
		expect(screen.getByRole("tab", { name: "Home" }).getAttribute("aria-selected")).toBe("true")
	})

	it("edits a header with the chip's toggles, and Close goes back to the body", async () => {
		const { editor } = await openEditor()

		act(() => {
			void editor.execute({ type: "header.edit" })
		})

		// One section: the chip says only which header it is.
		const chip = await screen.findByRole("group", { name: "Header" })

		expect(editor.snapshot().context.story.kind).toBe("header")
		fireEvent.click(screen.getByRole("button", { name: "Header and footer options" }))
		fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Different first page" }))
		await waitFor(() => {
			expect(editor.snapshot().context.story.header?.differentFirst).toBe(true)
		})
		fireEvent.click(screen.getByRole("button", { name: "Close header" }))
		await waitFor(() => {
			expect(chip.isConnected).toBe(false)
		})
		expect(editor.snapshot().context.story.kind).toBe("body")
	})

	it("sets up the pages from the Layout tab's dialog, prefilled with the section's", async () => {
		const { editor } = await openEditor()
		const execute = vi.spyOn(editor, "execute")

		fireEvent.click(screen.getByRole("tab", { name: "Layout" }))
		fireEvent.click(await screen.findByRole("button", { name: "Page setup…" }))

		const top = await screen.findByRole("textbox", { name: "Top (in)" })

		expect((top as HTMLInputElement).value).toBe("1")
		fireEvent.change(top, { target: { value: "0.5" } })
		fireEvent.click(screen.getByRole("button", { name: "Apply" }))
		await waitFor(() => {
			expect(execute).toHaveBeenCalledWith({
				type: "page.setup",
				margins: { top: 720, bottom: 1440, left: 1440, right: 1440 },
				scope: "section"
			})
		})
		expect(screen.queryByRole("dialog")).toBeNull()
	})

	it("runs commands that change nothing while the file cannot be saved", async () => {
		const { editor } = await openEditor({ writable: false })

		fireEvent.click(screen.getByRole("tab", { name: "View" }))
		fireEvent.click(await screen.findByRole("button", { name: "Show field codes" }))
		await waitFor(() => {
			expect(editor.fieldCodes).toBe(true)
		})
	})

	it("tells when a command that settles later fails", async () => {
		const { editor } = await openEditor()

		vi.spyOn(editor, "execute").mockReturnValueOnce(Promise.reject(new Error("no")))
		fireEvent.click(screen.getByRole("button", { name: "Bold" }))
		await waitFor(() => {
			expect(toasts.error).toHaveBeenCalledWith("That change couldn't be made.")
		})
	})

	it("paints the next selection made in the document with the format painter, once", async () => {
		const { editor } = await openEditor()
		const execute = vi.spyOn(editor, "execute")

		act(() => {
			editor.selectParagraph(1)
		})
		fireEvent.click(screen.getByRole("button", { name: "Format painter" }), { detail: 1 })
		await waitFor(() => {
			expect(editor.painter).toBeDefined()
		})
		expect(screen.getByRole("button", { name: "Format painter" }).getAttribute("aria-pressed")).toBe("true")
		// A right click's release opens the context menu: it paints nothing.
		fireEvent.pointerUp(screen.getByRole("textbox", { name: "report.docx" }), { isPrimary: true, button: 2 })
		await new Promise(resolve => setTimeout(resolve, 20))
		expect(execute).not.toHaveBeenCalledWith({ type: "format.paste" })
		fireEvent.pointerUp(screen.getByRole("textbox", { name: "report.docx" }), { isPrimary: true, button: 0 })
		await waitFor(() => {
			expect(execute).toHaveBeenCalledWith({ type: "format.paste" })
		})
		await waitFor(() => {
			expect(editor.painter).toBeUndefined()
		})
	})

	it("offers the markup modes once changes are tracked in a document that had none", async () => {
		hooks.settings = { authorName: "Ann", autosave: true, loaded: true }

		const { editor } = await openEditor()

		fireEvent.click(await screen.findByRole("tab", { name: "Review" }))
		expect(await screen.findByRole("button", { name: "Track changes" })).toBeTruthy()
		expect(screen.queryByRole("button", { name: "Markup" })).toBeNull()
		act(() => {
			void editor.execute({ type: "review.track", on: true })
		})
		await waitFor(() => {
			expect(editor.snapshot().review.tracking).toBe(true)
		})
		fireEvent.click(await screen.findByRole("button", { name: "Markup" }))
		expect(await screen.findByRole("menuitemradio", { name: "All markup" })).toBeTruthy()
	})

	it("opens a dropdown control's entries at the caret with Alt+Down and chooses one from the keyboard", async () => {
		const { editor } = await openEditor()

		act(() => {
			editor.selectParagraph(1)
			editor.select({ pos: editor.selection().to, affinity: 1, page: 0, line: 0, atom: false })
			void editor.execute({ type: "control.insert", kind: "dropDownList", items: [{ text: "Plum", value: "plum" }] })
		})
		await waitFor(() => {
			expect(editor.snapshot().context.control?.type).toBe("dropDownList")
		})
		fireEvent.keyDown(screen.getByRole("textbox", { name: "report.docx" }), { key: "ArrowDown", altKey: true })

		const list = await screen.findByRole("listbox", { name: "Items" })

		await waitFor(() => {
			expect(document.activeElement).toBe(list)
		})
		fireEvent.keyDown(list, { key: "End" })
		fireEvent.keyDown(list, { key: "Enter" })
		await waitFor(() => {
			expect(editor.snapshot().context.control?.value).toBe("plum")
		})
		expect(editor.state.doc.textContent).toContain("Plum")
	})

	it("keeps the split dialog open and says why when the table refuses the split", async () => {
		const { editor } = await openEditor()

		act(() => {
			editor.selectParagraph(1)
			void editor.execute({ type: "table.insert", rows: 1, cols: 1 })
		})
		vi.spyOn(editor, "execute").mockReturnValue(false)
		fireEvent.contextMenu(screen.getByRole("textbox", { name: "report.docx" }))
		fireEvent.click(await screen.findByRole("menuitem", { name: "Split cells…" }))
		fireEvent.click(await screen.findByRole("button", { name: "Split" }))
		expect((await screen.findByRole("alert")).textContent).toBe("This cell can't be split into that many rows and columns.")
		expect(screen.getByRole("dialog", { name: "Split cells" })).toBeTruthy()
	})

	it("counts matches in the locale's numbers, past the most a find shows", () => {
		expect(i18n.t("preview:previewDocxFindCountCapped", { current: 1234, total: 10_000 })).toBe("1,234/10,000+")
		expect(i18n.t("preview:previewDocxFindStatus", { current: 3, total: 1500 })).toBe("Match 3 of 1,500")
	})
})

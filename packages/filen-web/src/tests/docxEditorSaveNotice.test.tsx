// @vitest-environment happy-dom

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import type { PagedEditor } from "@filen/office/core/docx/paged"
import type { FontExtents, TextMeasurer } from "@filen/office/core/text"
import type { DocxEditingHost, DocxSealer } from "@filen/office/dom/docx/editing"
import { toast } from "sonner"
import { i18n } from "@/lib/i18n"
import { registerAllActions } from "@/lib/keymap/actions"

// What a save's own writer stored otherwise than the editor has it (an ODF 1.1 document's comment kept at the start
// of its text) is told once the file is stored, in a toast that stays.

const hooks = vi.hoisted(() => ({
	hosts: [] as DocxEditingHost[],
	notices: undefined as readonly { readonly kind: "commentPoint"; readonly count: number }[] | undefined
}))

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
			actual
				.writeDocx(host, options)
				.then(written => (hooks.notices === undefined ? written : { ...written, notices: hooks.notices })),
		docxEditingHost: (writeUnlocked = false, encryption?: DocxSealer) => {
			const host = inThreadEditingHost(
				() => ({
					fontHost: { addBytes: () => Promise.resolve(true), addLocal: () => Promise.resolve(false), remove: () => undefined },
					replayFonts: false,
					fontAssets: { read: () => Promise.resolve(new Uint8Array(4)) },
					measurer,
					yield: () => new Promise<void>(resolve => setTimeout(resolve, 0)),
					sliceMs: 8
				}),
				{
					proof: writerProof,
					writer: { prepare: prepareDocxSave },
					writeUnlocked,
					...(encryption === undefined ? {} : { encryption })
				}
			)

			hooks.hosts.push(host)

			return host
		}
	}
})
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
	useOfficeSettings: () => ({ authorName: null, autosave: false, loaded: true })
}))
vi.mock("sonner", () => ({
	toast: { warning: vi.fn(), info: vi.fn(), success: vi.fn(), error: vi.fn(), loading: vi.fn(), dismiss: vi.fn() }
}))
vi.mock("@/lib/useIsOnline", () => ({ useIsOnline: () => true }))
vi.mock("@/lib/log", () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

const { DocxEditView } = await import("@/features/preview/components/docxEditor")

type DocxSaveSource = NonNullable<Parameters<typeof DocxEditView>[0]["saveRef"]["current"]>

registerAllActions()

// Tests run from the package's directory.
const BYTES = new Uint8Array(readFileSync(join(process.cwd(), "../filen-office/src/tests/fixtures/01-plain.docx")))

async function openWritable(): Promise<{ editor: PagedEditor; save: DocxSaveSource }> {
	const saveRef: { current: DocxSaveSource | null } = { current: null }

	render(
		<DocxEditView
			bytes={BYTES}
			alt="old.odt"
			writable
			renamed={false}
			onDirtyChange={vi.fn()}
			saveRef={saveRef}
			onAutosave={() => true}
			viewer={() => <div>viewer</div>}
		/>
	)

	const host = hooks.hosts.at(-1)

	if (host === undefined) throw new Error("no editing host")

	const editor: PagedEditor = await act(() => host.editor)

	await waitFor(() => {
		expect(screen.getByRole("textbox", { name: "old.odt" })).toBeTruthy()
	})

	if (saveRef.current === null) throw new Error("no save source")

	return { editor, save: saveRef.current }
}

afterEach(() => {
	cleanup()
	hooks.hosts.length = 0
	hooks.notices = undefined
	vi.clearAllMocks()
})

describe("DocxEditView, a save its writer stored otherwise", () => {
	it("tells, once stored, that an ODF 1.1 document kept a comment at the start of its text", async () => {
		const { editor, save } = await openWritable()

		hooks.notices = [{ kind: "commentPoint", count: 1 }]
		act(() => {
			editor.dispatch(editor.state.tr.insertText("Edited ", 1))
		})

		const snapshot = await act(() => save())

		expect(toast.warning).not.toHaveBeenCalled()

		act(() => {
			snapshot.commit()
		})

		expect(toast.warning).toHaveBeenCalledWith(
			"This document's older OpenDocument version can't mark which text a comment covers, so 1 comment was saved at the start of its text.",
			{ id: "docx-save-notice-commentPoint", duration: Infinity }
		)
	})

	it("shows one toast per notice kind however many saves report it, dismissed when the document goes, not on a language change", async () => {
		const { editor, save } = await openWritable()

		hooks.notices = [{ kind: "commentPoint", count: 1 }]

		for (const text of ["One ", "Two "]) {
			act(() => {
				editor.dispatch(editor.state.tr.insertText(text, 1))
			})

			const snapshot = await act(() => save())

			act(() => {
				snapshot.commit()
			})
		}

		const ids = vi.mocked(toast.warning).mock.calls.map(call => (call[1] as { id?: string } | undefined)?.id)

		expect(ids).toEqual(["docx-save-notice-commentPoint", "docx-save-notice-commentPoint"])

		await act(() => i18n.changeLanguage("de"))
		await act(() => i18n.changeLanguage("en"))
		expect(toast.dismiss).not.toHaveBeenCalledWith("docx-save-notice-commentPoint")

		cleanup()
		expect(toast.dismiss).toHaveBeenCalledWith("docx-save-notice-commentPoint")
	})

	it("tells nothing of a save stored as edited", async () => {
		const { editor, save } = await openWritable()

		act(() => {
			editor.dispatch(editor.state.tr.insertText("Edited ", 1))
		})

		const snapshot = await act(() => save())

		act(() => {
			snapshot.commit()
		})

		expect(toast.warning).not.toHaveBeenCalled()
	})
})

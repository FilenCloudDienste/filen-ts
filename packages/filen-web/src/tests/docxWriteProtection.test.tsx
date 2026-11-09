// @vitest-environment happy-dom

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { ZipArchive, bytesSource, memorySink, planZip, writeZip } from "@filen/office/core/opc"
import type { PagedEditor } from "@filen/office/core/docx/paged"
import type { FontExtents, TextMeasurer } from "@filen/office/core/text"
import type { DocxEditingHost } from "@filen/office/dom/docx/editing"
import "@/lib/i18n"
import { registerAllActions } from "@/lib/keymap/actions"

// Password to modify and read-only recommended (w:writeProtection) in the DOCX editor: the document opens
// view-only under a bar; a wrong password keeps it so, the right one opens it again editable for the session,
// and a recommendation alone is lifted by "Edit anyway".

const hooks = vi.hoisted(() => ({
	hosts: [] as { host: DocxEditingHost; writeUnlocked: boolean }[]
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
		docxEditingHost: (writeUnlocked = false) => {
			const host = inThreadEditingHost(
				() => ({
					fontHost: { addBytes: () => Promise.resolve(true), addLocal: () => Promise.resolve(false), remove: () => undefined },
					replayFonts: false,
					fontAssets: { read: () => Promise.resolve(new Uint8Array(4)) },
					measurer,
					yield: () => new Promise<void>(resolve => setTimeout(resolve, 0)),
					sliceMs: 8
				}),
				{ proof: writerProof, writer: { prepare: prepareDocxSave }, writeUnlocked }
			)

			hooks.hosts.push({ host, writeUnlocked })

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

registerAllActions()

// Word 2016's password to modify "a" (SHA-512, 100,000 spins): LibreOffice sw/qa/uitest/data/writeprotection.docx
// (tdf#89383, MPL-2.0).
const WORD_PASSWORD =
	'<w:writeProtection w:cryptProviderType="rsaAES" w:cryptAlgorithmClass="hash" w:cryptAlgorithmType="typeAny" w:cryptAlgorithmSid="14" w:cryptSpinCount="100000" w:hash="3HjQ4PVpzZ43tfymSZNdbTW/U4pfPg1E2ztXK/t5sQ/D+mU2nFJi+8TAuKlPN9WSIY1Kq5TV/ndaKIYjV5BH6g==" w:salt="T9LnDCDcxpnWeAOWjPDWvw=="/>'
const RECOMMENDED = '<w:writeProtection w:recommended="1"/>'
const PLAIN = new Uint8Array(readFileSync(join(process.cwd(), "../filen-office/src/tests/fixtures/01-plain.docx")))

// The plain fixture with `element` first in its settings (CT_Settings order).
async function protectedDocx(element: string): Promise<Uint8Array> {
	const archive = await ZipArchive.open(bytesSource(PLAIN))
	const entry = archive.get("word/settings.xml")

	if (entry === undefined) {
		throw new Error("no settings")
	}

	const settings = new TextDecoder().decode(await archive.read(entry)).replace(/(<w:settings\b[^>]*>)/, `$1${element}`)
	const sink = memorySink()

	await writeZip(planZip(archive, { replace: [{ name: "word/settings.xml", bytes: new TextEncoder().encode(settings) }] }), archive, sink)

	return sink.bytes()
}

async function openEditor(bytes: Uint8Array): Promise<PagedEditor> {
	render(
		<DocxEditView
			bytes={bytes}
			alt="report.docx"
			writable
			renamed={false}
			onDirtyChange={vi.fn()}
			saveRef={{ current: null }}
			onAutosave={() => true}
			viewer={() => <div>viewer</div>}
		/>
	)

	return lastEditor()
}

async function lastEditor(): Promise<PagedEditor> {
	const host = hooks.hosts.at(-1)?.host

	if (host === undefined) {
		throw new Error("no editing host")
	}

	const editor = await act(() => host.editor)

	await waitFor(() => {
		expect(screen.getByRole("textbox", { name: "report.docx" })).toBeTruthy()
	})

	return editor
}

function boldButton(): HTMLButtonElement {
	return screen.getByRole("button", { name: "Bold" })
}

function submit(password: string): void {
	fireEvent.change(screen.getByLabelText("Password"), { target: { value: password } })
	fireEvent.click(screen.getByRole("button", { name: "Edit" }))
}

afterEach(() => {
	cleanup()
	hooks.hosts.length = 0
	vi.clearAllMocks()
})

describe("DocxEditView with write protection", () => {
	it("stays view-only on a wrong password and opens editable with the right one", async () => {
		const editor = await openEditor(await protectedDocx(WORD_PASSWORD))

		expect(await screen.findByText("This document needs a password to be edited. You can view it without one.")).toBeTruthy()
		expect(editor.session.readOnly).toBe(true)

		fireEvent.click(screen.getByRole("button", { name: "Edit…" }))
		await screen.findByRole("dialog")
		// The document's name quoted, as the open prompt does.
		expect(screen.getByText("Enter the password to edit “report.docx”. The document keeps its password.")).toBeTruthy()
		submit("A")

		expect(await screen.findByRole("button", { name: "Checking…" })).toBeTruthy()
		// Each check spins Word's 100,000 SHA-512 rounds, a second or more apiece on a loaded runner.
		expect(
			await screen.findByText("That password isn't right. Try again, or cancel to keep viewing.", undefined, {
				timeout: 25_000
			})
		).toBeTruthy()
		expect(hooks.hosts).toHaveLength(1)
		expect(editor.session.readOnly).toBe(true)

		submit("a")

		await waitFor(
			() => {
				expect(hooks.hosts).toHaveLength(2)
			},
			{ timeout: 25_000 }
		)
		expect(hooks.hosts[1]?.writeUnlocked).toBe(true)

		const unlocked = await lastEditor()

		expect(unlocked.session.readOnly).toBe(false)
		await waitFor(() => {
			expect(screen.queryByRole("dialog")).toBeNull()
		})
		expect(screen.queryByText("This document needs a password to be edited. You can view it without one.")).toBeNull()
	}, 60_000)

	it("lifts a read-only recommendation with Edit anyway, without opening the document again", async () => {
		const editor = await openEditor(await protectedDocx(RECOMMENDED))

		expect(await screen.findByText("The author recommends opening this document read-only.")).toBeTruthy()
		expect(editor.session.readOnly).toBe(false)
		expect(boldButton().disabled).toBe(true)
		expect(document.querySelector("[data-fo-read-only]")).not.toBeNull()

		fireEvent.click(screen.getByRole("button", { name: "Edit anyway" }))

		await waitFor(() => {
			expect(boldButton().disabled).toBe(false)
		})
		expect(document.querySelector("[data-fo-read-only]")).toBeNull()
		expect(screen.queryByText("The author recommends opening this document read-only.")).toBeNull()
		expect(hooks.hosts).toHaveLength(1)
	})

	it("offers no password prompt for a hash it cannot check", async () => {
		await openEditor(await protectedDocx('<w:writeProtection w:cryptAlgorithmSid="3" w:hash="aGFzaA==" w:salt="c2FsdA=="/>'))

		expect(
			await screen.findByText(
				"This document needs a password to be edited, and its password can't be checked here, so it can only be viewed."
			)
		).toBeTruthy()
		expect(screen.queryByRole("button", { name: "Edit…" })).toBeNull()
	})
})

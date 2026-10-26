// @vitest-environment happy-dom

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { PagedEditor } from "@filen/office/core/docx/paged"
import type { FontExtents, TextMeasurer } from "@filen/office/core/text"
import { heldSource, type DocxUnlockedDocument } from "@filen/office/dom/docx"
import type { DocxEditingHost, DocxSealer } from "@filen/office/dom/docx/editing"
import type { OfficeKeyTransfer } from "@filen/office/dom/encryption"
import { StrictMode } from "react"
import "@/lib/i18n"
import { registerAllActions } from "@/lib/keymap/actions"

// The editor on a document opened with its password: it takes its own copy and the key from where the document
// is held, its host seals every save with that key's sealer (released once the editor closes and no seal runs),
// the toolbar says the document is password-protected, and nothing but a sealed file reaches the upload.

const CFB = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 1, 2, 3])

// What a take hands the sealer (its copy and key source), and what the sealer does (docxSealer is the office
// package's).
const sealing = vi.hoisted(() => ({
	keys: [] as unknown[],
	seal: undefined as ((zip: Uint8Array) => Promise<Uint8Array>) | undefined,
	released: 0
}))

vi.mock("@filen/office/dom/docx/editing", async importOriginal => ({
	...(await importOriginal<typeof import("@filen/office/dom/docx/editing")>()),
	docxSealer: (key: unknown) => {
		sealing.keys.push(key)

		return {
			sealer: {
				released: false,
				seal: (zip: Uint8Array) =>
					sealing.seal?.(zip) ?? Promise.resolve(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))
			},
			release: () => {
				sealing.released++
			}
		}
	}
}))

const hooks = vi.hoisted(() => ({
	hosts: [] as { host: DocxEditingHost; encryption: DocxSealer | undefined }[],
	// Replaces the writer when set.
	write: undefined as
		| ((
				host: DocxEditingHost,
				options?: import("@/features/preview/lib/docxEditing").WriteDocxOptions
		  ) => Promise<import("@/features/preview/lib/docxEditing").DocxSaveSnapshot>)
		| undefined
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
			hooks.write?.(host, options) ?? actual.writeDocx(host, options),
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

			hooks.hosts.push({ host, encryption })

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

const { DocxEditView, DocxProtectedEditView } = await import("@/features/preview/components/docxEditor")
const { DocxPlaintextUploadError, assertSealedUpload, takeProtectedDocument } = await import("@/features/preview/lib/docxEditing")

type DocxSaveSource = NonNullable<Parameters<typeof DocxEditView>[0]["saveRef"]["current"]>

registerAllActions()

// Tests run from the package's directory.
const BYTES = new Uint8Array(readFileSync(join(process.cwd(), "../filen-office/src/tests/fixtures/01-plain.docx")))

async function openEditor(encryption: DocxSealer, writable = true) {
	const saveRef: { current: DocxSaveSource | null } = { current: null }

	render(
		<DocxEditView
			bytes={BYTES}
			alt="secret.docx"
			writable={writable}
			renamed={false}
			onDirtyChange={vi.fn()}
			saveRef={saveRef}
			onAutosave={() => true}
			viewer={() => <div>viewer</div>}
			encryption={encryption}
			encryptionIntegrity="verified"
		/>
	)

	const opened = hooks.hosts.at(-1)

	if (opened === undefined) {
		throw new Error("no editing host")
	}

	const editor: PagedEditor = await act(() => opened.host.editor)

	await waitFor(() => {
		expect(screen.getByRole("textbox", { name: "secret.docx" })).toBeTruthy()
	})

	return { editor, saveRef, encryption: opened.encryption }
}

async function openWritable(encryption: DocxSealer) {
	const { editor, saveRef, encryption: given } = await openEditor(encryption)
	const save = saveRef.current

	if (save === null) {
		throw new Error("no save source")
	}

	return { editor, save, encryption: given }
}

async function badgeText(): Promise<string | null> {
	fireEvent.click(screen.getByRole("button", { name: "Password-protected" }))

	return (await screen.findByText(/Opened with its password|Saved with the same password/)).textContent
}

function typeAtStart(editor: PagedEditor, text: string): void {
	act(() => {
		editor.dispatch(editor.state.tr.insertText(text, 1))
	})
}

afterEach(() => {
	cleanup()
	sealing.keys.length = 0
	sealing.seal = undefined
	sealing.released = 0
	hooks.hosts.length = 0
	hooks.write = undefined
	vi.clearAllMocks()
})

describe("DocxEditView, a password-protected document", () => {
	it("seals every save with the session's sealer and says the document is password-protected", async () => {
		const seal = vi.fn((zip: Uint8Array) => {
			// The decrypted package goes in; a compound file comes out.
			expect([zip[0], zip[1]]).toEqual([0x50, 0x4b])

			return Promise.resolve(CFB)
		})
		const sealer: DocxSealer = { seal, released: false }
		const { editor, save, encryption } = await openWritable(sealer)

		expect(encryption).toBe(sealer)
		expect(screen.getByRole("button", { name: "Password-protected" })).toBeTruthy()

		typeAtStart(editor, "Edited ")

		const snapshot = await act(() => save())

		expect(seal).toHaveBeenCalledTimes(1)
		expect(snapshot.bytes).toBe(CFB)
	})

	it("never hands a decrypted package to the upload", async () => {
		const { editor, save } = await openWritable({ seal: () => Promise.resolve(CFB), released: false })

		// A writer that (wrongly) returns the zip itself.
		hooks.write = () => Promise.resolve({ bytes: BYTES, commit: () => undefined, elapsedMs: 1 })
		typeAtStart(editor, "Edited ")

		await expect(act(() => save())).rejects.toThrow(DocxPlaintextUploadError)
	})

	it("promises saves with the same password only while the document can be saved", async () => {
		await openEditor({ seal: () => Promise.resolve(CFB), released: false })
		expect(await badgeText()).toBe("Saved with the same password.")
		cleanup()

		await openEditor({ seal: () => Promise.resolve(CFB), released: false }, false)
		expect(await badgeText()).toBe("Opened with its password, on this device only.")
	})

	it("opens on its own copy taken from where the document is held, and releases the key once it closes", async () => {
		// The key is asked for only by the sealer's first seal (docxSealer, mocked here): never on open.
		const key = vi.fn(() => Promise.resolve({ transferred: true } as unknown as OfficeKeyTransfer))
		const taken = { bytes: BYTES, key }
		const take = vi.fn(() => Promise.resolve(taken))
		const release = vi.fn()
		const dropPackage = vi.fn()
		const document: DocxUnlockedDocument = {
			scheme: "agile",
			integrity: "unchecked",
			bytes: heldSource(BYTES.length),
			host: () => {
				throw new Error("the editor does not open the held package")
			},
			take,
			dropPackage,
			release
		}
		const saveRef: { current: DocxSaveSource | null } = { current: null }
		const view = render(
			<DocxProtectedEditView
				document={document}
				alt="secret.docx"
				writable
				renamed={false}
				onDirtyChange={vi.fn()}
				saveRef={saveRef}
				onAutosave={() => true}
				viewer={() => <div>viewer</div>}
			/>
		)

		await waitFor(() => {
			expect(hooks.hosts.at(-1)?.encryption).toBeDefined()
		})
		expect(take).toHaveBeenCalledOnce()
		expect(sealing.keys).toEqual([taken])
		expect(key).not.toHaveBeenCalled()

		const opened = hooks.hosts.at(-1)
		const editor: PagedEditor = await act(() => opened?.host.editor ?? Promise.reject(new Error("no editing host")))

		// Open on its own copy: the one the viewer's engine held goes.
		await waitFor(() => {
			expect(dropPackage).toHaveBeenCalled()
		})

		// The integrity it was unlocked with is told, beside the saves' promise.
		expect(screen.getByRole("button", { name: "Password-protected" }).getAttribute("aria-describedby")).toBeTruthy()

		typeAtStart(editor, "Edited ")

		const snapshot = await act(() => saveRef.current?.() ?? Promise.reject(new Error("no save source")))

		expect(Array.from(snapshot.bytes.subarray(0, 2))).toEqual([0xd0, 0xcf])
		view.unmount()
		expect(sealing.released).toBe(1)
		// The held document is the viewer's to release.
		expect(release).not.toHaveBeenCalled()
	})

	it("leaves a document whose copy cannot be taken to the viewer", async () => {
		const document: DocxUnlockedDocument = {
			scheme: "agile",
			integrity: "verified",
			bytes: heldSource(BYTES.length),
			host: () => {
				throw new Error("unused")
			},
			take: () => Promise.reject(new Error("the worker went")),
			dropPackage: vi.fn(),
			release: vi.fn()
		}

		render(
			<DocxProtectedEditView
				document={document}
				alt="secret.docx"
				writable
				renamed={false}
				onDirtyChange={vi.fn()}
				saveRef={{ current: null }}
				onAutosave={() => true}
				viewer={() => <div>viewer</div>}
			/>
		)

		expect(await screen.findByText("viewer")).toBeTruthy()
	})
})

describe("DocxProtectedEditView under Strict Mode", () => {
	it("keeps exactly one taken sealer while mounted and releases every one on unmount", async () => {
		const take = vi.fn(() => Promise.resolve({ bytes: BYTES, key: () => Promise.resolve({} as unknown as OfficeKeyTransfer) }))
		const release = vi.fn()
		const document: DocxUnlockedDocument = {
			scheme: "agile",
			integrity: "verified",
			bytes: heldSource(BYTES.length),
			host: () => {
				throw new Error("unused")
			},
			take,
			dropPackage: vi.fn(),
			release
		}
		const view = render(
			<StrictMode>
				<DocxProtectedEditView
					document={document}
					alt="secret.docx"
					writable
					renamed={false}
					onDirtyChange={vi.fn()}
					saveRef={{ current: null }}
					onAutosave={() => true}
					viewer={() => <div>viewer</div>}
				/>
			</StrictMode>
		)

		await waitFor(() => {
			expect(screen.getByRole("textbox", { name: "secret.docx" })).toBeTruthy()
		})
		await act(() => new Promise(resolve => setTimeout(resolve, 20)))
		// Strict Mode's discarded take builds no sealer, or its sealer is released.
		expect(take).toHaveBeenCalledTimes(2)
		expect(sealing.keys.length - sealing.released).toBe(1)
		expect(release).not.toHaveBeenCalled()
		view.unmount()
		await act(() => new Promise(resolve => setTimeout(resolve, 20)))
		expect(sealing.released).toBe(sealing.keys.length)
	})
})

describe("takeProtectedDocument", () => {
	it("releases the key once closed and no seal still runs", async () => {
		let sealed: (bytes: Uint8Array) => void = () => undefined

		sealing.seal = () =>
			new Promise(resolve => {
				sealed = resolve
			})

		const session = await takeProtectedDocument(
			{
				scheme: "agile",
				integrity: "verified",
				bytes: heldSource(BYTES.length),
				host: () => {
					throw new Error("unused")
				},
				take: () => Promise.resolve({ bytes: BYTES, key: () => Promise.resolve({} as unknown as OfficeKeyTransfer) }),
				dropPackage: vi.fn(),
				release: vi.fn()
			},
			new AbortController().signal
		)
		const sealing1 = session.sealer.seal(BYTES)

		session.close()
		expect(sealing.released).toBe(0)
		sealed(CFB)
		expect(await sealing1).toBe(CFB)
		expect(sealing.released).toBe(1)
	})
})

describe("assertSealedUpload", () => {
	it("lets only a compound file leave a password-protected document's save", () => {
		expect(() => {
			assertSealedUpload(BYTES, true)
		}).toThrow(DocxPlaintextUploadError)
		expect(() => {
			assertSealedUpload(new Uint8Array(0), true)
		}).toThrow(DocxPlaintextUploadError)
		expect(() => {
			assertSealedUpload(CFB, true)
		}).not.toThrow()
		expect(() => {
			assertSealedUpload(BYTES, false)
		}).not.toThrow()
	})
})

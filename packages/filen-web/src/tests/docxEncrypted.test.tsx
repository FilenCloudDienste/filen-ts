// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render as renderUi, screen, waitFor } from "@testing-library/react"
import { StrictMode, type ReactElement } from "react"
import { createTestQueryClient, queryClientWrapper } from "@/tests/testQueryClient"
import type { ByteSource } from "@filen/office/core/opc"
import {
	heldSource,
	type DocxDocumentUnlock,
	type DocxLegacyOpen,
	type DocxListener,
	type DocxLockedDocument,
	type DocxOpenOptions,
	type DocxProtectedOpen,
	type DocxProtectionOptions,
	type DocxSessionApi,
	type DocxUnlockedDocument
} from "@filen/office/dom/docx"
import "@/lib/i18n"
import { registerAllActions } from "@/lib/keymap/actions"
import { linkedFileItem } from "@/tests/fixtures/sdk"
import { docxSessionKey } from "@/features/preview/components/docxViewer.logic"

// A password-protected Word document in the viewer: probed in the docx worker only when it is a compound file,
// the password asked (a wrong one says so, the check can be stopped), the document opened on its decrypted
// package where the worker holds it (never on the page) with the badge, files that are refused never prompting,
// and the document released once the preview lets go of it.

function render(ui: ReactElement) {
	return renderUi(ui, { wrapper: queryClientWrapper(createTestQueryClient()) })
}

const { host, files, protectOpen, legacyOpen } = vi.hoisted(() => ({
	host: { source: null as ByteSource | null, closed: 0 },
	files: { bytes: new Uint8Array(0) },
	protectOpen: vi.fn<(source: ByteSource, options?: DocxProtectionOptions) => Promise<DocxProtectedOpen>>(),
	legacyOpen: vi.fn<(source: ByteSource, options?: DocxProtectionOptions) => Promise<DocxLegacyOpen>>()
}))

const ZIP = new Uint8Array([0x50, 0x4b, 3, 4, 9, 9, 9, 9])
const CFB = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0])
const DECRYPTED_SIZE = 13

function session(onClose: () => void): DocxSessionApi {
	return {
		objects: () => Promise.resolve([]),
		media: () => Promise.resolve(null),
		locate: () => Promise.resolve(null),
		find: () => Promise.resolve(new Int32Array(0)),
		close: onClose
	}
}

vi.mock("@/lib/storage/adapter", () => ({ kvGetJson: () => Promise.resolve(null), kvSetJson: () => Promise.resolve() }))
vi.mock("@/lib/log", () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock("@/features/preview/hooks/usePreviewBytes", () => ({
	usePreviewBytes: () => ({ status: "success", bytes: files.bytes, refetch: () => undefined })
}))
vi.mock("@/features/preview/lib/docxEngine", () => ({
	prewarmDocxWorker: () => undefined,
	DOCX_FONT_URLS: {},
	docxProtection: { open: protectOpen },
	docxLegacy: { open: legacyOpen },
	docxHost: (source: ByteSource, _listener: DocxListener, _options?: DocxOpenOptions) => {
		host.source = source

		return session(() => {
			host.closed++
		})
	}
}))

const { DocxViewer } = await import("@/features/preview/components/docxViewer")

registerAllActions()

const item = linkedFileItem("secret.docx", {
	uuid: "aaaaaaaa-0000-0000-0000-000000000003",
	mime: { Decrypted: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
	size: 12n
})

// The document an unlock gives, held where it was decrypted: what its host was asked to open, its sessions'
// closes and its release (a spy).
function unlockedDocument(integrity: DocxUnlockedDocument["integrity"] = "verified") {
	const release = vi.fn()
	const opened: ByteSource[] = []
	const closes = { count: 0 }
	const document: DocxUnlockedDocument = {
		scheme: "agile",
		integrity,
		bytes: heldSource(DECRYPTED_SIZE),
		host: source => {
			opened.push(source)

			return session(() => {
				closes.count++
			})
		},
		take: () => Promise.reject(new Error("a viewer takes nothing")),
		dropPackage: vi.fn(),
		release
	}

	return { document, release, opened, closes }
}

type Unlock = (password: string, options?: DocxProtectionOptions) => Promise<DocxDocumentUnlock>

// A locked document whose unlock is `unlock` (a spy too, for its calls), and its dispose.
function lockedWith(unlock: Unlock): DocxLockedDocument & { spy: ReturnType<typeof vi.fn<Unlock>>; disposed: ReturnType<typeof vi.fn> } {
	const spy = vi.fn<Unlock>(unlock)
	const disposed = vi.fn()

	return { scheme: "agile", spinCount: 100_000, unlock: spy, dispose: disposed, spy, disposed }
}

function viewer(): ReactElement {
	return (
		<DocxViewer
			item={item}
			alt="secret.docx"
		/>
	)
}

function passwordField(): HTMLInputElement {
	return screen.getByLabelText("Password", { selector: "input" })
}

function typeAndSubmit(password: string): void {
	fireEvent.change(passwordField(), { target: { value: password } })
	fireEvent.click(screen.getByRole("button", { name: "Open" }))
}

// Lets the key's release (a turn after the preview let go) run.
function turn(): Promise<void> {
	return act(() => new Promise<void>(resolve => setTimeout(resolve, 5)))
}

beforeEach(() => {
	host.source = null
	host.closed = 0
	files.bytes = CFB
	protectOpen.mockReset()
	legacyOpen.mockReset()
})

afterEach(() => {
	cleanup()
})

describe("DocxViewer, password-protected documents", () => {
	it("opens a zip at once, never probing it", () => {
		files.bytes = ZIP
		render(viewer())

		expect(protectOpen).not.toHaveBeenCalled()
		expect(host.source?.size).toBe(ZIP.length)
	})

	it("asks for the password, says a wrong one, opens the right one decrypted with the badge, and releases the key once closed", async () => {
		const { document, release, opened, closes } = unlockedDocument()
		const locked = lockedWith(password =>
			Promise.resolve(password === "secret" ? { ok: true, document } : { ok: false, reason: "wrongPassword" })
		)

		protectOpen.mockResolvedValue({ kind: "needsPassword", locked })

		const view = render(viewer())

		expect(await screen.findByRole("dialog", { name: "Password-protected document" })).toBeTruthy()
		// Probed where the engine runs, reading the file from the page.
		expect(protectOpen.mock.calls[0]?.[0].size).toBe(CFB.length)
		expect(screen.getByText("Enter the password to open “secret.docx”.")).toBeTruthy()
		expect(host.source).toBeNull()
		expect(screen.getByRole<HTMLButtonElement>("button", { name: "Open" }).disabled).toBe(true)

		typeAndSubmit("nope")

		expect((await screen.findByRole("alert")).textContent).toBe("That password isn't right. Try again.")
		expect(passwordField().value).toBe("")
		expect(passwordField().getAttribute("aria-invalid")).toBe("true")
		expect(window.document.activeElement).toBe(passwordField())

		typeAndSubmit("secret")

		await waitFor(() => {
			expect(screen.queryByRole("dialog", { name: "Password-protected document" })).toBeNull()
		})
		expect(locked.spy).toHaveBeenLastCalledWith("secret", { signal: expect.any(AbortSignal) as AbortSignal })
		// The viewer opens the decrypted package where the worker holds it: the page neither reads nor holds it.
		expect(host.source).toBeNull()
		expect(opened[0]?.size).toBe(DECRYPTED_SIZE)
		await expect(opened[0]?.read(0, 4)).rejects.toThrow()
		expect(screen.getByRole("button", { name: "Password-protected" })).toBeTruthy()

		await turn()
		expect(release).not.toHaveBeenCalled()

		view.unmount()
		await turn()
		expect(release).toHaveBeenCalledTimes(1)
		expect(closes.count).toBe(1)
		// The unlocked document's hold is released, not disposed twice.
		expect(locked.disposed).not.toHaveBeenCalled()
	})

	it("says when the document's integrity can't be verified, in the badge's popover and description", async () => {
		const { document } = unlockedDocument("unchecked")

		protectOpen.mockResolvedValue({ kind: "needsPassword", locked: lockedWith(() => Promise.resolve({ ok: true, document })) })
		render(viewer())
		await screen.findByRole("dialog", { name: "Password-protected document" })
		typeAndSubmit("secret")

		const badge = await screen.findByRole("button", { name: "Password-protected" })
		const warning = "Its integrity can't be verified: it may have been changed after it was encrypted."
		const note = window.document.getElementById(badge.getAttribute("aria-describedby") ?? "")

		expect(note?.textContent).toBe(warning)
		fireEvent.click(badge)
		expect(await screen.findByText("Opened with its password, on this device only.")).toBeTruthy()
		expect(screen.getAllByText(warning).length).toBe(2)
	})

	it("describes no warning for a verified document", async () => {
		const { document } = unlockedDocument()

		protectOpen.mockResolvedValue({ kind: "needsPassword", locked: lockedWith(() => Promise.resolve({ ok: true, document })) })
		render(viewer())
		await screen.findByRole("dialog", { name: "Password-protected document" })
		typeAndSubmit("secret")

		expect((await screen.findByRole("button", { name: "Password-protected" })).getAttribute("aria-describedby")).toBeNull()
	})

	it("shows the check running, and Cancel stops it for another try", async () => {
		const locked = lockedWith(
			(_password, options) =>
				new Promise(resolve => {
					;(options?.signal as AbortSignal | undefined)?.addEventListener("abort", () => {
						resolve({ ok: false, reason: "aborted" })
					})
				})
		)

		protectOpen.mockResolvedValue({ kind: "needsPassword", locked })
		render(viewer())
		await screen.findByRole("dialog", { name: "Password-protected document" })
		typeAndSubmit("slow")

		expect(screen.getByRole("button", { name: "Unlocking…" })).toBeTruthy()
		expect(screen.getByRole("status").textContent).toBe("Unlocking…")
		expect(passwordField().disabled).toBe(true)

		const cancel = screen.getByRole("button", { name: "Cancel" })

		expect(window.document.activeElement).toBe(cancel)
		fireEvent.click(cancel)

		const signal = locked.spy.mock.calls[0]?.[1]?.signal

		expect(signal?.aborted).toBe(true)
		expect(screen.getByRole("dialog", { name: "Password-protected document" })).toBeTruthy()
		expect(passwordField().disabled).toBe(false)
		expect(screen.getByRole("button", { name: "Open" })).toBeTruthy()
		expect(screen.queryByRole("alert")).toBeNull()
	})

	it("drops a locked file where the worker holds it when the preview closes without unlocking it", async () => {
		const locked = lockedWith(() => Promise.resolve({ ok: false, reason: "wrongPassword" }))

		protectOpen.mockResolvedValue({ kind: "needsPassword", locked })

		const view = render(viewer())

		await screen.findByRole("dialog", { name: "Password-protected document" })
		expect(locked.disposed).not.toHaveBeenCalled()
		view.unmount()
		await turn()
		expect(locked.disposed).toHaveBeenCalledOnce()
	})

	it("leaves the lock and a button to ask again when the prompt is dismissed", async () => {
		protectOpen.mockResolvedValue({
			kind: "needsPassword",
			locked: lockedWith(() => Promise.resolve({ ok: false, reason: "wrongPassword" }))
		})
		render(viewer())
		await screen.findByRole("dialog", { name: "Password-protected document" })
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }))

		await waitFor(() => {
			expect(screen.queryByRole("dialog")).toBeNull()
		})
		expect(screen.getByText("This document is password-protected.")).toBeTruthy()

		fireEvent.click(screen.getByRole("button", { name: "Enter password" }))
		expect(await screen.findByRole("dialog", { name: "Password-protected document" })).toBeTruthy()
	})

	it.each([
		["rightsManaged", "This document is protected with rights management (IRM) and can't be opened in Filen."],
		["unsupported", "This document uses an encryption method Filen can't open."],
		["damaged", "This document is damaged or was modified after it was encrypted."]
	] as const)("refuses a %s file without asking a password", async (reason, message) => {
		protectOpen.mockResolvedValue({ kind: "refused", reason })
		render(viewer())

		expect(await screen.findByText(message)).toBeTruthy()
		expect(screen.queryByRole("dialog")).toBeNull()
		expect(host.source).toBeNull()
	})

	it("refuses a document whose integrity check fails once the password verified", async () => {
		protectOpen.mockResolvedValue({
			kind: "needsPassword",
			locked: lockedWith(() => Promise.resolve({ ok: false, reason: "damaged" }))
		})
		render(viewer())
		await screen.findByRole("dialog", { name: "Password-protected document" })
		typeAndSubmit("secret")

		expect(await screen.findByText("This document is damaged or was modified after it was encrypted.")).toBeTruthy()
		expect(screen.queryByRole("dialog")).toBeNull()
	})

	it("converts a compound file the probe finds not encrypted as a Word 97–2003 document", async () => {
		protectOpen.mockResolvedValue({ kind: "plain" })
		legacyOpen.mockResolvedValue({ kind: "refused", refusal: { reason: "legacyVersion", nFib: 0x65 } })
		render(viewer())

		expect(await screen.findByText("This document uses an older Word format that can't be opened here.")).toBeTruthy()
		expect(legacyOpen.mock.calls[0]?.[0].size).toBe(CFB.length)
		expect(host.source).toBeNull()
	})

	it("releases a key unlocked as the preview closed", async () => {
		const { document, release } = unlockedDocument()
		let finish: (result: DocxDocumentUnlock) => void = () => undefined

		protectOpen.mockResolvedValue({
			kind: "needsPassword",
			locked: lockedWith(
				() =>
					new Promise(resolve => {
						finish = resolve
					})
			)
		})

		const view = render(viewer())

		await screen.findByRole("dialog", { name: "Password-protected document" })
		typeAndSubmit("secret")
		view.unmount()
		await act(async () => {
			finish({ ok: true, document })
			await Promise.resolve()
		})

		expect(release).toHaveBeenCalledTimes(1)
	})

	// Strict Mode at the root: React runs the boundary's effects twice on mount (two probes, the first discarded).
	function strictRender(ui: ReactElement) {
		const Wrapper = queryClientWrapper(createTestQueryClient())

		return renderUi(
			<StrictMode>
				<Wrapper>{ui}</Wrapper>
			</StrictMode>
		)
	}

	function probesWith(unlock: Unlock): ReturnType<typeof lockedWith>[] {
		const made: ReturnType<typeof lockedWith>[] = []

		protectOpen.mockImplementation(() => {
			const locked = lockedWith(unlock)

			made.push(locked)

			return Promise.resolve({ kind: "needsPassword", locked })
		})

		return made
	}

	it("keeps the key through Strict Mode's remount, and releases it on unmount", async () => {
		const { document, release, opened } = unlockedDocument()
		const made = probesWith(() => Promise.resolve({ ok: true, document }))
		const view = strictRender(viewer())

		await screen.findByRole("dialog", { name: "Password-protected document" })
		typeAndSubmit("secret")
		await waitFor(() => {
			expect(opened.length).toBeGreaterThan(0)
		})
		await turn()

		// Two probes; the discarded one's lock is disposed once, the one that unlocked never.
		expect(protectOpen).toHaveBeenCalledTimes(2)
		expect(made.map(locked => locked.disposed.mock.calls.length).sort()).toEqual([0, 1])
		expect(made.find(locked => locked.spy.mock.calls.length > 0)?.disposed).not.toHaveBeenCalled()
		expect(release).not.toHaveBeenCalled()

		view.unmount()
		await turn()
		expect(release).toHaveBeenCalledTimes(1)
		expect(made.map(locked => locked.disposed.mock.calls.length).sort()).toEqual([0, 1])
	})

	it("under Strict Mode disposes the discarded probe's lock while the prompt shows, and the shown one on unmount", async () => {
		const made = probesWith(() => Promise.resolve({ ok: false, reason: "wrongPassword" }))
		const view = strictRender(viewer())

		await screen.findByRole("dialog", { name: "Password-protected document" })
		typeAndSubmit("nope")
		await screen.findByRole("alert")
		await turn()

		const shown = made.filter(locked => locked.spy.mock.calls.length > 0)

		expect(made).toHaveLength(2)
		expect(shown).toHaveLength(1)
		expect(shown[0]?.disposed).not.toHaveBeenCalled()

		for (const locked of made) if (locked !== shown[0]) expect(locked.disposed).toHaveBeenCalledOnce()

		view.unmount()
		await turn()

		for (const locked of made) expect(locked.disposed).toHaveBeenCalledOnce()
	})
})

describe("docxSessionKey", () => {
	it("releases the document a turn after it is dropped, unless held again within the turn", async () => {
		const { document, release } = unlockedDocument()
		const key = docxSessionKey(document)

		key.drop()
		key.hold()
		await new Promise(resolve => setTimeout(resolve, 5))
		expect(release).not.toHaveBeenCalled()

		key.drop()
		await new Promise(resolve => setTimeout(resolve, 5))
		expect(release).toHaveBeenCalledTimes(1)
	})
})

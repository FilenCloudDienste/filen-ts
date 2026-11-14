// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import "@/lib/i18n"
import { DocxPasswordGate } from "@/features/preview/components/docxPasswordPrompt"
import { PasswordDraft, PasswordDraftContext } from "@/features/preview/lib/passwordDraft"

// A preview opened on a version since replaced (a listing restored from disk, read once shown) moves to the newer
// version, which remounts the viewer and asks its password again: the prompt takes up what was typed, revealed or
// not, with focus in the field, or stays dismissed. Outside an overlay, after a check, or once dismissed, each
// prompt starts blank.

vi.mock("pdfjs-dist", () => ({ getDocument: vi.fn(), GlobalWorkerOptions: {}, PDFDataRangeTransport: vi.fn(), TextLayer: vi.fn() }))
// The viewer reaches the account's cached settings (whether earlier versions are kept): an empty store.
vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: () => Promise.resolve(null),
	kvSetJson: () => Promise.resolve(),
	kvKeys: () => Promise.resolve([]),
	kvDelete: () => Promise.resolve(),
	kvGet: () => Promise.resolve(null),
	kvHas: () => Promise.resolve(false),
	kvEntriesJson: () => Promise.resolve([]),
	kvEntriesJsonInSlices: () => Promise.resolve([]),
	kvDeletePrefix: () => Promise.resolve(),
	kvDeleteIfAt: () => Promise.resolve([]),
	isMissingStorageMethod: () => false
}))

const { PdfPasswordPrompt } = await import("@/features/preview/components/pdfViewer")

afterEach(() => {
	cleanup()
})

// The viewer of one version: a newer one is another `version`, remounting it.
function gate(version: string, draft: PasswordDraft | undefined, verify = () => Promise.resolve("wrong" as const)) {
	return (
		<PasswordDraftContext
			key={version}
			value={draft}
		>
			<DocxPasswordGate
				title="Document password"
				body="Enter it."
				wrongMessage="Wrong."
				label="Password"
				submitLabel="Open"
				progressLabel="Checking…"
				message="Locked."
				enterLabel="Enter password"
				verify={verify}
			/>
		</PasswordDraftContext>
	)
}

function field(): HTMLInputElement {
	return screen.getByLabelText("Password", { selector: "input" })
}

describe("a document's password prompt across a version move", () => {
	it("keeps what was typed, revealed, with focus in the field", async () => {
		const draft = new PasswordDraft()
		const { rerender } = render(gate("v1", draft))

		fireEvent.change(field(), { target: { value: "hunter" } })
		fireEvent.click(screen.getByRole("button", { name: "Show password" }))

		rerender(gate("v2", draft))

		expect(field().value).toBe("hunter")
		expect(screen.getByRole("button", { name: "Hide password" }).getAttribute("aria-pressed")).toBe("true")
		await waitFor(() => {
			expect(window.document.activeElement).toBe(field())
		})
	})

	it("starts blank outside an overlay", () => {
		const { rerender } = render(gate("v1", undefined))

		fireEvent.change(field(), { target: { value: "hunter" } })
		rerender(gate("v2", undefined))

		expect(field().value).toBe("")
	})

	it("starts blank after a check", async () => {
		const draft = new PasswordDraft()
		const { rerender } = render(gate("v1", draft))

		fireEvent.change(field(), { target: { value: "hunter" } })
		fireEvent.click(screen.getByRole("button", { name: "Open" }))
		await screen.findByText("Wrong.")

		rerender(gate("v2", draft))

		expect(field().value).toBe("")
	})

	it("stays dismissed, and opens blank when brought back", async () => {
		const draft = new PasswordDraft()
		const { rerender } = render(gate("v1", draft))

		fireEvent.change(field(), { target: { value: "hunter" } })
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
		await waitFor(() => {
			expect(screen.queryByLabelText("Password", { selector: "input" })).toBeNull()
		})

		rerender(gate("v2", draft))
		expect(screen.queryByLabelText("Password", { selector: "input" })).toBeNull()

		fireEvent.click(screen.getByRole("button", { name: "Enter password" }))
		expect(field().value).toBe("")
	})
})

function pdfPrompt(version: string, draft: PasswordDraft, onSubmit = vi.fn()) {
	return (
		<PasswordDraftContext
			key={version}
			value={draft}
		>
			<PdfPasswordPrompt
				attempt="initial"
				onSubmit={onSubmit}
			/>
		</PasswordDraftContext>
	)
}

describe("a PDF's password prompt across a version move", () => {
	it("keeps what was typed, and starts blank after a submit", async () => {
		const draft = new PasswordDraft()
		const onSubmit = vi.fn()
		const { rerender } = render(pdfPrompt("v1", draft, onSubmit))

		fireEvent.change(field(), { target: { value: "hunter" } })
		rerender(pdfPrompt("v2", draft, onSubmit))

		expect(field().value).toBe("hunter")
		await waitFor(() => {
			expect(window.document.activeElement).toBe(field())
		})
		// Focus leaves it to be typed on.
		expect(field().selectionStart).toBe("hunter".length)

		fireEvent.click(screen.getByRole("button", { name: "Unlock" }))
		expect(onSubmit).toHaveBeenCalledWith("hunter")

		rerender(pdfPrompt("v3", draft, onSubmit))
		expect(field().value).toBe("")
	})
})

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createElement, type ReactNode } from "react"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { LinkedFile } from "@filen/sdk-rs"
import type { AnonDownloadOutcome } from "@/features/publicLinks/lib/download"
import "@/lib/i18n"

// A public file link's own feedback: a failed download says so, and re-submitting the same wrong
// password checks it again rather than doing nothing.

const { getLinkedFileAnon, hasClient, ownsItem, startAnonFileDownload } = vi.hoisted(() => ({
	getLinkedFileAnon: vi.fn<(uuid: string, key: string, password: string | undefined) => Promise<LinkedFile>>(),
	hasClient: vi.fn<() => Promise<boolean>>(),
	ownsItem: vi.fn<(kind: "file" | "directory", uuid: string) => Promise<boolean>>(),
	startAnonFileDownload: vi.fn<() => Promise<AnonDownloadOutcome>>()
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { getLinkedFileAnon, hasClient, ownsItem } }))
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } }) }))
vi.mock("@/features/transfers/lib/copyToast", () => ({ startLinkedCopyWithCard: vi.fn() }))
vi.mock("@/features/drive/components/moveTargetDialog", () => ({ MoveTargetDialog: () => null }))
vi.mock("@/features/publicLinks/lib/download", () => ({ startAnonFileDownload }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }))
vi.mock("@tanstack/react-router", () => ({
	useBlocker: () => ({ status: "idle" }),
	useNavigate: () => vi.fn(),
	useRouterState: () => "/f"
}))
vi.mock("@/lib/keymap/useAction", () => ({ useAction: vi.fn(), IN_EDITORS: {}, IN_EDITORS_AND_FIELDS: {}, OUTSIDE_OVERLAYS: {} }))
vi.mock("@/lib/useIsOnline", () => ({ useIsOnline: () => true }))
// The inline preview itself is not under test: a stub stands in for it.
vi.mock("@/features/publicLinks/components/publicPreview", () => ({ PublicPreview: () => null }))

import { queryClient } from "@/queries/client"
import { FileLinkView } from "@/features/publicLinks/components/fileLinkView"
import { mockLinkedFile } from "@/tests/fixtures/sdk"

const LINK_UUID = "c1000000-0000-0000-0000-000000000000"
const WRONG_PASSWORD = { species: "sdk", kind: "WrongPassword", message: "", label: "Wrong password" }

const linkedFile = mockLinkedFile()

function wrapper({ children }: { children: ReactNode }) {
	return createElement(QueryClientProvider, { client: queryClient, children })
}

async function settle(): Promise<void> {
	await act(async () => {
		for (let i = 0; i < 10; i++) {
			await new Promise(resolve => setTimeout(resolve, 0))
		}
	})
}

async function renderLink(): Promise<void> {
	render(createElement(FileLinkView, { uuid: LINK_UUID, linkKey: "key" }), { wrapper })

	await settle()
}

async function submitPassword(password: string): Promise<void> {
	fireEvent.change(screen.getByLabelText("Password"), { target: { value: password } })
	fireEvent.click(screen.getByRole("button", { name: "Unlock" }))

	await settle()
}

beforeEach(() => {
	queryClient.clear()
	vi.clearAllMocks()
	hasClient.mockResolvedValue(false)
	ownsItem.mockResolvedValue(false)
})

afterEach(() => {
	cleanup()
})

describe("FileLinkView — a failed download", () => {
	it("says the download failed, with the error's own label", async () => {
		getLinkedFileAnon.mockResolvedValue(linkedFile)
		startAnonFileDownload.mockResolvedValue({
			status: "error",
			dto: { species: "sdk", kind: "SomethingUnlisted", message: "The connection dropped.", label: "" }
		})

		await renderLink()

		fireEvent.click(screen.getByRole("button", { name: "Download" }))
		await settle()

		expect(screen.getByText("The download failed. The connection dropped.")).toBeDefined()
		expect(screen.getByRole("button", { name: "Download" })).toBeDefined()
	})

	it("shows no progress bar before the download reports a share", async () => {
		getLinkedFileAnon.mockResolvedValue(linkedFile)
		startAnonFileDownload.mockReturnValue(new Promise(() => undefined))

		await renderLink()

		fireEvent.click(screen.getByRole("button", { name: "Download" }))
		await settle()

		expect(screen.queryByRole("progressbar")).toBeNull()
	})
})

describe("FileLinkView — the password gate", () => {
	it("checks the same wrong password again when it is submitted again", async () => {
		getLinkedFileAnon.mockRejectedValue(WRONG_PASSWORD)

		await renderLink()
		await submitPassword("hunter2")

		expect(getLinkedFileAnon).toHaveBeenCalledTimes(2)
		expect(screen.getByText("Wrong password. Please try again.")).toBeDefined()

		let rejectAgain: (error: unknown) => void = () => undefined

		getLinkedFileAnon.mockReturnValueOnce(
			new Promise((_, reject) => {
				rejectAgain = reject
			})
		)
		await submitPassword("hunter2")

		expect(getLinkedFileAnon).toHaveBeenCalledTimes(3)
		expect(getLinkedFileAnon).toHaveBeenLastCalledWith(LINK_UUID, "key", "hunter2")
		expect(screen.queryByText("Wrong password. Please try again.")).toBeNull()

		rejectAgain(WRONG_PASSWORD)
		await settle()

		// Back through checking to wrong, which clears the field for the next try.
		expect(screen.getByText("Wrong password. Please try again.")).toBeDefined()
		expect(screen.getByLabelText("Password")).toHaveProperty("value", "")
	})
})

describe("FileLinkView — a download from the preview's bar", () => {
	const previewable = mockLinkedFile({ name: { Decrypted: "notes.txt" }, mime: { Decrypted: "text/plain" } })

	async function renderPreview(): Promise<void> {
		getLinkedFileAnon.mockResolvedValue(previewable)

		await renderLink()

		expect(screen.getByRole("button", { name: "Hide preview" })).toBeDefined()
	}

	it("says the file is too large to download here", async () => {
		startAnonFileDownload.mockResolvedValue({ status: "too-large" })

		await renderPreview()

		fireEvent.click(screen.getByRole("button", { name: "Download" }))
		await settle()

		expect(screen.getByRole("alert").textContent).toMatch(/^This file is too large to download here/)
	})

	it("announces a failed download", async () => {
		startAnonFileDownload.mockResolvedValue({
			status: "error",
			dto: { species: "sdk", kind: "SomethingUnlisted", message: "The connection dropped.", label: "" }
		})

		await renderPreview()

		fireEvent.click(screen.getByRole("button", { name: "Download" }))
		await settle()

		expect(screen.getByRole("alert").textContent).toBe("The download failed. The connection dropped.")
	})

	it("spins while running, with no bar until a share is reported, then a named bar", async () => {
		let report: (loaded: number, total: number | null) => void = () => undefined

		startAnonFileDownload.mockImplementation(((options: { onProgress: (loaded: number, total: number | null) => void }) => {
			report = options.onProgress

			return new Promise(() => undefined)
		}) as () => Promise<AnonDownloadOutcome>)

		await renderPreview()

		fireEvent.click(screen.getByRole("button", { name: "Download" }))
		await settle()

		const button = screen.getByRole("button", { name: "Downloading…" })

		expect(button.hasAttribute("disabled")).toBe(true)
		expect(button.querySelector("[data-slot='spinner']")).not.toBeNull()
		expect(screen.queryByRole("progressbar")).toBeNull()

		act(() => {
			report(40, 100)
		})

		const bar = screen.getByRole("progressbar", { name: "Downloading…" })

		expect(bar.getAttribute("aria-valuenow")).toBe("40")
	})
})

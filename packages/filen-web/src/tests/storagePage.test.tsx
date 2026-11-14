// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createElement } from "react"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { QueryClientProvider } from "@tanstack/react-query"
import type { DesktopMountsOverview } from "@filen/shared/desktop"
import { formatBytes } from "@filen/shared"
import "@/lib/i18n"

// Advanced's local data and caches group over spies for every store it measures and clears; the measure and clear logic itself is real.

const mocks = vi.hoisted(() => ({
	kvPrefixBytes: vi.fn<(prefixes: readonly string[]) => Promise<number[] | null>>(),
	kvDeletePrefix: vi.fn<(prefix: string) => Promise<void>>(),
	opfsTreeBytes: vi.fn<(segments: readonly string[]) => Promise<number>>(),
	wipeThumbnailStore: vi.fn<() => Promise<void>>(),
	removeAssistantModel: vi.fn<() => Promise<void>>(),
	finishWithReload: vi.fn<(reports: unknown) => boolean>(),
	showReports: vi.fn(),
	toastSuccess: vi.fn(),
	toastError: vi.fn(),
	estimate: vi.fn<() => Promise<{ usage?: number }>>(),
	bridge: undefined as undefined | { app: { browserCacheSize: () => Promise<number> }; mounts: object }
}))

vi.mock("sonner", () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError, info: vi.fn() } }))
vi.mock("@/queries/client", async () => ({ queryClient: (await import("@/tests/testQueryClient")).createTestQueryClient() }))
vi.mock("@/queries/persist", () => ({
	PERSIST_FAMILY: "rq.",
	noDiskPersister: (queryFn: (context: unknown) => unknown, context: unknown) => queryFn(context)
}))
vi.mock("@/lib/storage/adapter", () => ({
	kvPrefixBytes: mocks.kvPrefixBytes,
	kvDeletePrefix: mocks.kvDeletePrefix,
	vacuumDatabase: () => Promise.resolve(0)
}))
vi.mock("@/lib/storage/opfs", () => ({ opfsTreeBytes: mocks.opfsTreeBytes }))
vi.mock("@/features/drive/lib/thumbCache", () => ({ wipeThumbnailStore: mocks.wipeThumbnailStore }))
vi.mock("@/features/videos/lib/artStore", () => ({ wipeArtStore: () => Promise.resolve() }))
vi.mock("@/features/videos/lib/indexStore", () => ({ wipeVideoIndexStore: () => Promise.resolve() }))
vi.mock("@/features/audio/store/useTrackTagsStore", () => ({ resetTrackTags: vi.fn() }))
vi.mock("@/features/assistant/store/assistantSession", () => ({ removeAssistantModel: mocks.removeAssistantModel }))
vi.mock("@/features/assistant/store/useAssistantStore", () => ({
	useAssistantStore: { getState: () => ({ modelState: { kind: "downloaded" } }) }
}))
vi.mock("@/features/assistant/runtime/modelStore", () => ({
	MODEL_LOCK: "filen-assistant-model",
	MODELS_DIRECTORY: "models",
	deleteModels: vi.fn()
}))
vi.mock("@/features/settings/lib/cacheReload", () => ({
	finishWithReload: mocks.finishWithReload,
	showReports: mocks.showReports,
	takeReportsAfterReload: () => []
}))
vi.mock("@/lib/desktop", () => ({ desktopBridge: () => mocks.bridge }))

const { queryClient } = await import("@/queries/client")
const { useMountsStore } = await import("@/features/mounts/lib/mountsStore")
const { StorageCaches } = await import("@/features/settings/components/storage/storageCaches")

const TREE_BYTES: Record<string, number> = { thumbnails: 3_000_000, "videos/art": 1_000_000, "videos/index": 500_000, models: 0 }

function renderPage() {
	return render(createElement(QueryClientProvider, { client: queryClient }, createElement(StorageCaches)))
}

function row(label: string): HTMLElement {
	const title = screen.getByText(label, { selector: "p" })
	const element = title.closest<HTMLElement>("[data-slot=settings-row]")

	if (element === null) {
		throw new Error(`no row for ${label}`)
	}

	return element
}

// The group header's figure, once measured.
async function findTotal(label = "Used by Filen in this browser"): Promise<string> {
	const heading = screen.getByRole("heading", { name: "Local data and caches" })
	const header = heading.parentElement

	if (header === null) {
		throw new Error("no group header")
	}

	await waitFor(() => {
		expect(header.querySelector("[data-slot=skeleton]")).toBeNull()
	})
	expect(within(header).getByText(`${label}:`, { exact: false })).toBeTruthy()

	return header.textContent
}

beforeEach(() => {
	mocks.kvPrefixBytes.mockReset().mockImplementation(prefixes => Promise.resolve(prefixes.map(() => 1000)))
	mocks.kvDeletePrefix.mockReset().mockResolvedValue(undefined)
	mocks.opfsTreeBytes.mockReset().mockImplementation(segments => Promise.resolve(TREE_BYTES[segments.join("/")] ?? 0))
	mocks.wipeThumbnailStore.mockReset().mockResolvedValue(undefined)
	mocks.removeAssistantModel.mockReset().mockResolvedValue(undefined)
	mocks.finishWithReload.mockReset().mockReturnValue(true)
	mocks.showReports.mockReset()
	mocks.toastSuccess.mockReset()
	mocks.toastError.mockReset()
	mocks.estimate.mockReset().mockResolvedValue({ usage: 10_000_000 })
	mocks.bridge = undefined
	Object.defineProperty(navigator, "storage", { value: { estimate: mocks.estimate }, configurable: true })
	useMountsStore.setState({ overview: null })
})

afterEach(() => {
	cleanup()
	queryClient.clear()
	vi.unstubAllGlobals()
})

describe("Local data and caches", () => {
	it("shows placeholders while sizes are measured", () => {
		mocks.opfsTreeBytes.mockReturnValue(new Promise(() => undefined))
		renderPage()

		expect(screen.getByRole("heading", { name: "Local data and caches" })).toBeTruthy()
		expect(screen.getByText("Used by Filen in this browser:", { exact: false })).toBeTruthy()
		expect(screen.queryByText("Other", { selector: "p" })).toBeNull()
		expect(within(row("Thumbnails")).getByRole<HTMLButtonElement>("button", { name: "Clear: Thumbnails" }).disabled).toBe(true)
		expect(document.querySelectorAll("[data-slot=skeleton]").length).toBeGreaterThan(0)
	})

	it("shows each row's size, the total beside the title and Other, and no model row without a model", async () => {
		renderPage()

		await waitFor(() => {
			expect(within(row("Thumbnails")).getByText(formatBytes(3_000_000))).toBeTruthy()
		})
		expect(within(row("Videos library")).getByText(formatBytes(1_500_000 + 5 * 1000))).toBeTruthy()
		// Two kv families: the tags and the edge analyses.
		expect(within(row("Music details and analysis")).getByText(formatBytes(2000))).toBeTruthy()
		expect(within(row("Cached lists and content")).getByText(formatBytes(1000))).toBeTruthy()
		expect(await findTotal()).toContain(formatBytes(10_000_000))
		expect(within(row("Other")).getByText(formatBytes(10_000_000 - 3_000_000 - 1_505_000 - 3000))).toBeTruthy()
		expect(within(row("Other")).queryByRole("button")).toBeNull()
		expect(screen.queryByText("AI model", { selector: "p" })).toBeNull()
		expect(screen.queryByText("Browser cache", { selector: "p" })).toBeNull()
		expect(screen.queryByText("Network drive cache", { selector: "p" })).toBeNull()
	})

	it("shows a dash where a leader on an older build cannot measure kv rows", async () => {
		mocks.kvPrefixBytes.mockResolvedValue(null)
		renderPage()

		await waitFor(() => {
			expect(within(row("Music details and analysis")).getByText("—")).toBeTruthy()
		})
		expect(within(row("Cached lists and content")).getByLabelText("Couldn't be measured")).toBeTruthy()
	})

	it("clears a row after confirming, says so and measures it again", async () => {
		renderPage()

		const clear = await within(row("Thumbnails")).findByRole<HTMLButtonElement>("button", { name: "Clear: Thumbnails" })

		await waitFor(() => {
			expect(clear.disabled).toBe(false)
		})
		fireEvent.click(clear)

		const dialog = await screen.findByRole("alertdialog")

		expect(within(dialog).getByText(/downloaded and made again/)).toBeTruthy()
		mocks.opfsTreeBytes.mockImplementation(segments =>
			Promise.resolve(segments[0] === "thumbnails" ? 0 : (TREE_BYTES[segments.join("/")] ?? 0))
		)
		fireEvent.click(within(dialog).getByRole("button", { name: "Clear" }))

		await waitFor(() => {
			expect(mocks.showReports).toHaveBeenCalledWith([{ kind: "success", message: "Thumbnails cleared" }])
		})
		expect(mocks.wipeThumbnailStore).toHaveBeenCalledOnce()
		expect(mocks.finishWithReload).not.toHaveBeenCalled()
		await waitFor(() => {
			expect(within(row("Thumbnails")).getByText(formatBytes(0))).toBeTruthy()
		})
	})

	it("says clearing Music also redoes the smooth transition analysis", async () => {
		renderPage()

		expect(within(row("Music details and analysis")).getByText(/their analysis for smooth transitions$/)).toBeTruthy()

		const clear = await within(row("Music details and analysis")).findByRole<HTMLButtonElement>("button", {
			name: "Clear: Music details and analysis"
		})

		await waitFor(() => {
			expect(clear.disabled).toBe(false)
		})
		fireEvent.click(clear)

		expect(within(await screen.findByRole("alertdialog")).getByText(/analysed again for smooth transitions/)).toBeTruthy()
	})

	it("reports a clear that failed", async () => {
		mocks.wipeThumbnailStore.mockRejectedValue(new Error("locked"))
		renderPage()

		const clear = await within(row("Thumbnails")).findByRole<HTMLButtonElement>("button", { name: "Clear: Thumbnails" })

		await waitFor(() => {
			expect(clear.disabled).toBe(false)
		})
		fireEvent.click(clear)
		fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Clear" }))

		await waitFor(() => {
			expect(mocks.showReports).toHaveBeenCalledWith([{ kind: "error", message: "Couldn't clear Thumbnails" }])
		})
	})

	it("reloads every tab after a Videos clear and keeps the dialog busy meanwhile", async () => {
		renderPage()

		const clear = await within(row("Videos library")).findByRole<HTMLButtonElement>("button", { name: "Clear: Videos library" })

		await waitFor(() => {
			expect(clear.disabled).toBe(false)
		})
		fireEvent.click(clear)

		const dialog = await screen.findByRole("alertdialog")

		expect(within(dialog).getByText(/Every open Filen tab reloads/)).toBeTruthy()
		fireEvent.click(within(dialog).getByRole("button", { name: "Clear" }))

		await waitFor(() => {
			expect(mocks.finishWithReload).toHaveBeenCalledWith([{ kind: "success", message: "Videos library cleared" }])
		})
		expect(within(screen.getByRole("alertdialog")).getByRole<HTMLButtonElement>("button", { name: /Clear$/ }).disabled).toBe(true)
	})

	it("lists what Clear all takes, leaves the model out and ends with the reload", async () => {
		TREE_BYTES["models"] = 2_000_000_000
		renderPage()

		await waitFor(() => {
			expect(within(row("AI model")).getByText(formatBytes(2_000_000_000))).toBeTruthy()
		})
		fireEvent.click(screen.getByRole("button", { name: "Clear all caches" }))

		const dialog = await screen.findByRole("alertdialog")

		expect(
			within(dialog).getByText(/^This clears Thumbnails, Videos library, Music details and analysis, and Cached lists and content\./)
		).toBeTruthy()
		fireEvent.click(within(dialog).getByRole("button", { name: "Clear all caches" }))

		await waitFor(() => {
			expect(mocks.finishWithReload).toHaveBeenCalledWith([{ kind: "success", message: "Caches cleared" }])
		})
		expect(mocks.removeAssistantModel).not.toHaveBeenCalled()
		TREE_BYTES["models"] = 0
	})

	it("removes the model through its own action", async () => {
		TREE_BYTES["models"] = 2_000_000_000
		renderPage()

		await screen.findByText("AI model", { selector: "p" })

		const remove = await within(row("AI model")).findByRole("button", { name: "Remove: AI model" })

		fireEvent.click(remove)
		fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Remove" }))

		await waitFor(() => {
			expect(mocks.toastSuccess).toHaveBeenCalledWith("AI model removed")
		})
		expect(mocks.removeAssistantModel).toHaveBeenCalledOnce()
		TREE_BYTES["models"] = 0
	})

	it("adds the desktop rows in the desktop app, the drive's size only while its host runs", async () => {
		mocks.bridge = { app: { browserCacheSize: () => Promise.resolve(4_000_000) }, mounts: {} }
		act(() => {
			useMountsStore.setState({
				overview: {
					host: { state: "running" },
					cache: { usedBytes: 7_000_000, freeBytes: 0, pendingUploads: 0, erroredFiles: 0 }
				} as unknown as DesktopMountsOverview
			})
		})
		renderPage()

		await waitFor(() => {
			expect(within(row("Browser cache")).getByText(formatBytes(4_000_000))).toBeTruthy()
		})
		expect(within(row("Network drive cache")).getByText(formatBytes(7_000_000))).toBeTruthy()
		expect(await findTotal("Used by Filen on this device")).toContain(formatBytes(10_000_000 + 4_000_000 + 7_000_000))

		act(() => {
			useMountsStore.setState({ overview: { host: { state: "off" }, cache: { usedBytes: 0 } } as unknown as DesktopMountsOverview })
		})

		expect(within(row("Network drive cache")).getByText("—")).toBeTruthy()
	})
})

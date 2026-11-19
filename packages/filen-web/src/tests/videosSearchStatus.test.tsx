// @vitest-environment jsdom

import { createElement } from "react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import "@/lib/i18n"
import type { SearchResult } from "@/workers/videoIndex/catalog.logic"

// The Videos search screen speaks only for the query typed: nothing while its first answer is pending, an error with a
// retry when the lookup fails, and never an earlier query's "no results" for the one typed now.

const { sdkApi } = vi.hoisted(() => ({
	sdkApi: { videoCatalogSearch: vi.fn<(query: string) => Promise<SearchResult>>() }
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi }))
vi.mock("@/features/videos/lib/index", () => ({
	VIDEO_CATALOG_KEY_PREFIX: ["videos", "catalog"],
	videoLibrary: { prepareSearch: vi.fn() }
}))
vi.mock("@/features/videos/hooks/useVideoCardActions", () => ({ useVideoCardActions: () => vi.fn() }))
vi.mock("@/lib/useElementSize", () => ({ useElementSize: () => ({ width: 800, height: 600 }) }))
vi.mock("@/features/videos/lib/cardObserver", () => ({
	CardObserver: class {
		public disconnect = vi.fn()
	}
}))

const { VideosSearchScreen } = await import("@/features/videos/screens/videosSearch")
const { VIDEOS_ACTIONS } = await import("@/features/videos/lib/keymap")
const { registerAction } = await import("@/lib/keymap/registry")

function renderScreen() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

	render(createElement(QueryClientProvider, { client }, createElement(VideosSearchScreen)))

	return screen.getByRole("searchbox")
}

function type(input: HTMLElement, value: string): void {
	fireEvent.change(input, { target: { value } })
}

beforeAll(() => {
	for (const def of VIDEOS_ACTIONS) {
		registerAction(def)
	}
})

afterEach(() => {
	cleanup()
	sdkApi.videoCatalogSearch.mockReset()
})

describe("VideosSearchScreen status", () => {
	it("announces no count while the first query is pending", async () => {
		sdkApi.videoCatalogSearch.mockReturnValue(new Promise<SearchResult>(() => undefined))

		const input = renderScreen()

		type(input, "dune")

		await waitFor(() => {
			expect(sdkApi.videoCatalogSearch).toHaveBeenCalledWith("dune")
		})

		expect(screen.getByRole("status").textContent).toBe("")
		expect(screen.queryByText(/No results/)).toBeNull()
	})

	it("shows the error with a retry when the lookup fails, and retries", async () => {
		sdkApi.videoCatalogSearch.mockRejectedValueOnce(new Error("worker gone"))
		sdkApi.videoCatalogSearch.mockResolvedValueOnce({ groups: [] })

		const input = renderScreen()

		type(input, "dune")

		const retry = await screen.findByRole("button", { name: "Try again" })

		expect(screen.getByRole("status").textContent).toBe("")

		fireEvent.click(retry)

		expect(await screen.findByText("No results for “dune”")).toBeTruthy()
		expect(screen.getByRole("status").textContent).toBe("0 results")
		expect(sdkApi.videoCatalogSearch).toHaveBeenCalledTimes(2)
	})

	it("never shows an earlier query's no-results for the one typed now", async () => {
		const input = renderScreen()

		sdkApi.videoCatalogSearch.mockResolvedValueOnce({ groups: [] })
		type(input, "zz")

		expect(await screen.findByText("No results for “zz”")).toBeTruthy()

		sdkApi.videoCatalogSearch.mockReturnValue(new Promise<SearchResult>(() => undefined))
		type(input, "dune")

		await waitFor(() => {
			expect(sdkApi.videoCatalogSearch).toHaveBeenCalledWith("dune")
		})

		expect(screen.queryByText(/No results/)).toBeNull()
		expect(screen.getByRole("status").textContent).toBe("")
	})
})

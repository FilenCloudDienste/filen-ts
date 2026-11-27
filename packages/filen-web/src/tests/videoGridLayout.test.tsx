// @vitest-environment jsdom

import { createElement, useEffect } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import "@/lib/i18n"
import type { GridPage } from "@/workers/videoIndex/catalog.logic"
import type { VideoCardModel } from "@/features/videos/lib/homeRows.logic"
import type { VideoCardProps } from "@/features/videos/components/videoCard"

// A width change with the same column count resizes the mounted rows, never remounting their cards (and reloading
// their art); a new query starts from the top of the list.

const { head, mounts } = vi.hoisted(() => ({
	head: { current: null as GridPage | null },
	mounts: { count: 0 }
}))

vi.mock("@tanstack/react-router", () => ({ useRouter: () => ({ navigate: vi.fn() }) }))
vi.mock("@/features/videos/hooks/useHistoryEntryKey", () => ({ useHistoryEntryKey: () => "entry" }))
vi.mock("@/features/videos/hooks/useVideoCardActions", () => ({ useVideoCardActions: () => vi.fn() }))
vi.mock("@/lib/keymap/registry", () => ({ useBindings: () => ({}), useComboFor: () => "", isRecordingCombo: () => false }))
vi.mock("@/features/drive/components/searchInput", () => ({
	SearchInput: ({
		label,
		value,
		onChange,
		onClear
	}: {
		label: string
		value: string
		onChange: (value: string) => void
		onClear: () => void
	}) =>
		createElement(
			"div",
			null,
			createElement("input", {
				"aria-label": label,
				value,
				onChange: (event: { target: { value: string } }) => {
					onChange(event.target.value)
				}
			}),
			createElement("button", { type: "button", onClick: onClear }, "clear")
		)
}))
vi.mock("@/features/videos/queries/grid", async () => {
	const { DEFAULT_GRID_PREFS } = await import("@/features/videos/lib/videoGrid.logic")

	return {
		useGridPrefsQuery: () => ({ status: "success", data: DEFAULT_GRID_PREFS }),
		useVideosGridDensityQuery: () => ({ data: undefined }),
		useProbeFactsQuery: () => ({ isSuccess: true, isError: false }),
		setGridPrefs: vi.fn()
	}
})
vi.mock("@/features/videos/queries/catalog", () => {
	const pages = { first: 0, pages: [] as (GridPage | null)[] }

	return {
		useCatalogGridHeadQuery: () => ({ data: head.current }),
		useCatalogGridPages: () => {
			pages.pages[0] = head.current

			return pages
		},
		gridPageCard: (_pages: unknown, index: number) => head.current?.cards[index],
		cachedGridCard: () => undefined,
		fetchGridCard: () => Promise.resolve(undefined)
	}
})
// Stands in for the card: what a remount would reset is its art hook, which runs once per mount.
vi.mock("@/features/videos/components/videoCard", () => ({
	VideoCard: ({ card, registerRef }: VideoCardProps) => {
		useEffect(() => {
			mounts.count++
		}, [])

		return createElement("a", { "data-video-card": "", "data-testid": card.key, href: "#", ref: registerRef }, card.key)
	}
}))

import { VideoGrid } from "@/features/videos/components/videoGrid"

const resizeCallbacks: ResizeObserverCallback[] = []

function setWidth(width: number): void {
	act(() => {
		for (const callback of [...resizeCallbacks]) {
			callback([{ contentRect: { width, height: 800 } } as ResizeObserverEntry], {} as ResizeObserver)
		}
	})
}

function card(index: number): VideoCardModel {
	return { key: `card-${String(index)}`, title: { id: `title-${String(index)}` } } as VideoCardModel
}

// jsdom lays nothing out: the scroller's viewport, which the virtualizer reads its range from.
const clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight")

beforeEach(() => {
	Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 800 })
	mounts.count = 0
	resizeCallbacks.length = 0
	head.current = {
		total: 12,
		sourceCount: 12,
		coverage: null,
		rootOptions: [],
		shape: "poster",
		start: 0,
		cards: Array.from({ length: 12 }, (_, index) => card(index))
	}
	vi.stubGlobal(
		"ResizeObserver",
		class {
			public constructor(callback: ResizeObserverCallback) {
				resizeCallbacks.push(callback)
			}

			public readonly observe = vi.fn()

			public readonly unobserve = vi.fn()

			public readonly disconnect = vi.fn()
		}
	)
	vi.stubGlobal(
		"IntersectionObserver",
		class {
			public readonly observe = vi.fn()

			public readonly unobserve = vi.fn()

			public readonly disconnect = vi.fn()
		}
	)
})

afterEach(() => {
	cleanup()

	if (clientHeight !== undefined) {
		Object.defineProperty(HTMLElement.prototype, "clientHeight", clientHeight)
	}

	vi.unstubAllGlobals()
})

function renderGrid() {
	render(
		createElement(VideoGrid, {
			source: { kind: "movies" },
			name: "Movies",
			rootNames: new Map()
		} as Parameters<typeof VideoGrid>[0])
	)

	return screen.getByRole("list")
}

describe("the videos grid", () => {
	it("keeps its mounted cards across a width change with the same column count", () => {
		renderGrid()
		// Phone widths lay out three poster columns whatever the width.
		setWidth(400)

		const before = screen.getByTestId("card-0")
		const mounted = mounts.count

		expect(mounted).toBeGreaterThan(0)

		setWidth(500)

		expect(screen.getByTestId("card-0")).toBe(before)
		expect(mounts.count).toBe(mounted)
	})

	it("scrolls back to the top when the query changes and when it is cleared", () => {
		const scroller = renderGrid()

		setWidth(400)

		const scrollTo = vi.fn()

		scroller.scrollTo = scrollTo

		fireEvent.change(screen.getByRole("textbox"), { target: { value: "the" } })
		expect(scrollTo).toHaveBeenLastCalledWith({ top: 0 })

		scrollTo.mockClear()
		fireEvent.click(screen.getByRole("button", { name: "clear" }))
		expect(scrollTo).toHaveBeenLastCalledWith({ top: 0 })
	})
})

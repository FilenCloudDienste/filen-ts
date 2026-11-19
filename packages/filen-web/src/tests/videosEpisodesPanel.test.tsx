// @vitest-environment jsdom

import { createElement } from "react"
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, fireEvent, render } from "@testing-library/react"
import "@/lib/i18n"
import { emptyWatchState } from "@filen/shared/videos"
import type { WatchItemTarget } from "@/features/videos/lib/player/watchTarget.logic"
import { EpisodesPanel } from "@/features/videos/components/player/episodesPanel"

// The episodes panel's seasons are toggle buttons in a labelled group, and a season without the playing episode
// opens at its top rather than at the previous season's scroll offset.

function episode(season: number, number: number): WatchItemTarget {
	return {
		key: `s${String(season)}e${String(number)}`,
		titleId: "series",
		titleName: "Series",
		kind: "episode",
		itemClass: "episode",
		versionLabel: "",
		parts: [],
		episode: { season, episode: number, episodeEnd: number, title: `Episode ${String(number)}`, order: season * 100 + number },
		seriesDirUuid: null
	} as unknown as WatchItemTarget
}

const EPISODES = [1, 2, 3].map(number => episode(1, number)).concat([1, 2, 3].map(number => episode(2, number)))
const DOC = emptyWatchState()

afterEach(() => {
	cleanup()
})

function renderPanel() {
	return render(
		createElement(EpisodesPanel, {
			episodes: EPISODES,
			currentKey: "s1e2",
			doc: DOC,
			onPick: () => undefined,
			onClose: () => undefined
		})
	)
}

describe("EpisodesPanel", () => {
	it("exposes the seasons as pressed buttons in a labelled group and focuses the pressed one", () => {
		const view = renderPanel()
		const group = view.getByRole("group", { name: "Seasons" })
		const season1 = view.getByRole("button", { name: "Season 1" })
		const season2 = view.getByRole("button", { name: "Season 2" })

		expect(group.contains(season1)).toBe(true)
		expect(view.queryByRole("tablist")).toBeNull()
		expect(view.queryByRole("tab")).toBeNull()
		expect(season1.getAttribute("aria-pressed")).toBe("true")
		expect(season2.getAttribute("aria-pressed")).toBe("false")
		expect(document.activeElement).toBe(season1)
	})

	it("starts a season without the playing episode at its top", () => {
		const view = renderPanel()
		const scroller = view.container.querySelector("ul")?.parentElement

		if (scroller === null || scroller === undefined) {
			throw new Error("no episode scroller")
		}

		scroller.scrollTop = 500

		fireEvent.click(view.getByRole("button", { name: "Season 2" }))

		expect(scroller.scrollTop).toBe(0)
		expect(view.getByRole("button", { name: "Season 2" }).getAttribute("aria-pressed")).toBe("true")
		expect(document.activeElement).toBe(view.getByRole("button", { name: "Season 2" }))
	})
})

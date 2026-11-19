// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, render, screen } from "@testing-library/react"
import { i18n } from "@/lib/i18n"
import { VideoEditPanel, type VideoEditTab } from "@/features/preview/videoEdit/components/videoEditPanel"
import { recipeFor, sourceInfo } from "@/tests/support/videoEditRecipe"

// The panel's numbers and track languages follow the UI language: the speed chips and the gain read as the locale
// writes them, and a track's ISO code is named.

const noop = vi.fn()

function renderPanel(tab: VideoEditTab) {
	render(
		<VideoEditPanel
			idBase="panel"
			tab={tab}
			recipe={recipeFor(60, { audio: { mute: false, gainDb: 3.5, keepTracks: "first" } })}
			info={sourceInfo({
				audio: [
					{ number: 1, codec: "mp4a.40.2", channels: 2, language: "deu" },
					{ number: 2, codec: "mp4a.40.2", channels: 2, language: "zzz" }
				]
			})}
			unavailable={new Set()}
			hdrNote={false}
			selection={null}
			aspect="free"
			selectedText={null}
			thumbnails={null}
			onTab={noop}
			onChange={noop}
			onTrim={noop}
			onSelection={noop}
			onRemoveSelection={noop}
			onRestore={noop}
			onAspect={noop}
			onTurn={noop}
			onFlip={noop}
			onResetCrop={noop}
			onAddText={noop}
			onSelectText={noop}
		/>
	)
}

afterEach(async () => {
	await act(() => i18n.changeLanguage("en"))
})

describe("VideoEditPanel in German", () => {
	it("writes the speed chips with the locale's decimal separator", async () => {
		await act(() => i18n.changeLanguage("de"))
		renderPanel("speed")

		expect(screen.getByText("0,25×")).toBeTruthy()
		expect(screen.queryByText("0.25×")).toBeNull()
	})

	it("writes the gain signed with one decimal, and names a track's language", async () => {
		await act(() => i18n.changeLanguage("de"))
		renderPanel("audio")

		expect(screen.getAllByText("+3,5 dB").length).toBeGreaterThan(0)
		expect(screen.getByText(/1 · Deutsch$/)).toBeTruthy()
		// A code nothing names stays as it was.
		expect(screen.getByText(/2 · zzz$/)).toBeTruthy()
	})
})

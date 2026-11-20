// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import { createElement } from "react"
import type { PreviewSubtitles } from "@/features/preview/hooks/usePreviewSubtitles"
import "@/lib/i18n"

// The preview's subtitles button is a menu trigger, not a toggle, and a subtitle file that could not be
// read is announced, not only marked in the closed menu.

const state = vi.hoisted(() => ({ failed: false }))

vi.mock("@/features/preview/hooks/usePreviewVideo", () => ({ usePreviewVideo: () => ({ controller: null, snapshot: null }) }))
vi.mock("@/features/preview/hooks/usePreviewSubtitles", () => ({
	usePreviewSubtitles: (): PreviewSubtitles => ({
		options: [{ id: "s:1", lang: "en", title: "", forced: false, sdh: false, embedded: false, unplayable: false }],
		selected: state.failed ? "s:1" : "off",
		select: () => undefined,
		cues: null,
		failed: state.failed
	})
}))

const { VideoPlayer } = await import("@/features/preview/components/videoPlayer")
const { linkedFileItem } = await import("@/tests/fixtures/sdk")

function renderPlayer(): void {
	render(createElement(VideoPlayer, { item: linkedFileItem("clip.mkv"), alt: "clip", downloadable: true, positionKey: "k" }))
}

afterEach(() => {
	cleanup()
	state.failed = false
})

describe("VideoPlayer subtitles", () => {
	it("is a plain menu button, never a pressed toggle", () => {
		renderPlayer()

		const button = screen.getByRole("button", { name: "Subtitles" })

		expect(button.hasAttribute("aria-pressed")).toBe(false)
		expect(screen.queryByText("The subtitles couldn't be loaded.")).toBeNull()
	})

	it("announces a subtitle file that could not be loaded", () => {
		state.failed = true
		renderPlayer()

		expect(screen.getByText("The subtitles couldn't be loaded.").getAttribute("role")).toBe("status")
	})
})

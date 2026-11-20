// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render, screen } from "@testing-library/react"
import { createElement } from "react"
import type { VideoProbe } from "@filen/shared/videos"
import "@/lib/i18n"

vi.mock("@/features/shell/hooks/useIsNarrowViewport", () => ({ useIsNarrowViewport: () => false }))

import { VideoStage, type VideoStageProps } from "@/components/media/video/videoStage"
import { PlayerTracks } from "@/features/videos/components/player/playerTracks"
import { subtitleTracksOf } from "@/features/videos/lib/player/subtitles.logic"
import type { VideoPartView } from "@/workers/videoIndex/view.logic"

// The Videos player's subtitle list: the text tracks inside an MP4 are choices, image and other formats say why not.

const PART: VideoPartView = {
	file: { stableUuid: "v", uuid: "v-u", name: "Movie.mp4", size: 1000 },
	container: "mp4",
	unsupported: false,
	height: 1080,
	subtitles: [],
	nfo: null,
	thumb: null,
	edl: null
}

const PROBE: VideoProbe = {
	v: 1,
	container: "mp4",
	durationSec: 60,
	index: "moov",
	video: null,
	audio: [],
	subs: [
		{ id: 2, codecId: "tx3g", lang: "eng", name: "Dialogue", def: true, forced: false, hi: false },
		{ id: 3, codecId: "stpp", lang: "ger", name: null, def: false, forced: false, hi: false },
		{ id: 4, codecId: "mp4s", lang: "fre", name: null, def: false, forced: false, hi: false }
	],
	chapters: [],
	cover: null,
	coverLand: null,
	partial: false
}

function stageProps(trailing: VideoStageProps["trailing"]): VideoStageProps {
	return {
		title: "Movie",
		backLabel: "Back",
		onBack: () => undefined,
		videoLabel: "Movie",
		onVideo: () => undefined,
		chapters: [],
		cues: null,
		cueOffset: 0,
		loading: false,
		hasNext: false,
		hasPrevious: false,
		trailing,
		holdControls: false,
		onAction: () => false
	}
}

beforeEach(() => {
	vi.useFakeTimers()
})

afterEach(() => {
	cleanup()
	vi.useRealTimers()
})

function renderTracks(embeddedTextBlocked: boolean, onSubtitle: (choice: unknown) => void): void {
	const tracks = createElement(PlayerTracks, {
		probe: PROBE,
		file: PART.file,
		audioIndex: -1,
		decisionAudioMode: null,
		onAudio: () => undefined,
		tracks: subtitleTracksOf(PART, PROBE, undefined, embeddedTextBlocked),
		choice: { kind: "off" },
		resolved: null,
		onSubtitle,
		encoding: null,
		detectedEncoding: null,
		onEncoding: () => undefined,
		onStyle: () => undefined,
		onDelay: () => undefined,
		open: true,
		onOpenChange: () => undefined
	})

	render(
		createElement(
			VideoStage,
			stageProps(() => tracks)
		)
	)

	act(() => {
		vi.advanceTimersByTime(20)
	})
}

describe("PlayerTracks", () => {
	it("marks the text track unavailable when no remux plays the file whole in this browser", () => {
		const onSubtitle = vi.fn()

		renderTracks(true, onSubtitle)

		const text = screen.getByRole("radio", { name: /English.*can't be shown in this browser/ })

		expect(text.getAttribute("aria-disabled")).toBe("true")
		expect(screen.queryByRole("radio", { name: /Dialogue/ })).toBeNull()
	})

	it("offers an MP4's timed text track and labels the formats it can't show", () => {
		const onSubtitle = vi.fn()
		const tracks = createElement(PlayerTracks, {
			probe: PROBE,
			file: PART.file,
			audioIndex: -1,
			decisionAudioMode: null,
			onAudio: () => undefined,
			tracks: subtitleTracksOf(PART, PROBE),
			choice: { kind: "off" },
			resolved: null,
			onSubtitle,
			encoding: null,
			detectedEncoding: null,
			onEncoding: () => undefined,
			onStyle: () => undefined,
			onDelay: () => undefined,
			open: true,
			onOpenChange: () => undefined
		})

		render(
			createElement(
				VideoStage,
				stageProps(() => tracks)
			)
		)

		act(() => {
			vi.advanceTimersByTime(20)
		})

		const text = screen.getByRole("radio", { name: /Dialogue/ })

		expect(text.getAttribute("aria-disabled")).toBe("false")
		expect(screen.getByRole("radio", { name: /format not supported/ }).getAttribute("aria-disabled")).toBe("true")
		expect(screen.getByRole("radio", { name: /Image subtitles aren't supported/ }).getAttribute("aria-disabled")).toBe("true")
		expect(screen.queryByText(/not supported yet/)).toBeNull()

		act(() => {
			text.click()
		})

		expect(onSubtitle).toHaveBeenCalledWith({ kind: "track", id: "e:2" })
	})
})

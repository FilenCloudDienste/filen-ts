import { afterEach, describe, expect, it, vi } from "vitest"
import type { AnyFile } from "@filen/sdk-rs"

const { warning } = vi.hoisted(() => ({
	warning: vi.fn<(message: string, options: { id: string; onDismiss: () => void; onAutoClose: () => void }) => void>()
}))

vi.mock("sonner", () => ({ toast: { warning } }))

import { formatFailureMessage, notifyFormatFailure, playbackErrorLabel } from "@/features/audio/lib/formatFailureNotice"
import { mediaFailureDTO } from "@/lib/media/mediaFailure"
import type { QueueTrack } from "@/features/audio/store/audioQueue"

function track(uuid: string): QueueTrack {
	return { uuid, name: `${uuid}.wma`, mime: "audio/x-ms-wma", contentType: null, file: {} as unknown as AnyFile }
}

// Closes whatever notice a test left showing, as sonner would, so the next starts with none.
afterEach(() => {
	warning.mock.lastCall?.[1].onDismiss()
})

describe("formatFailureMessage", () => {
	it("names one track and counts several, in the skipped and stopped wordings", () => {
		expect(formatFailureMessage("a.wma", 1, false)).toBe("Skipped a.wma — its format isn't supported by your browser")
		expect(formatFailureMessage("a.wma", 1, true)).toBe("Couldn't play a.wma — its format isn't supported by your browser")
		expect(formatFailureMessage("a.wma", 3, false)).toBe("Skipped 3 tracks — their format isn't supported by your browser")
		expect(formatFailureMessage("a.wma", 3, true)).toBe("Couldn't play 3 tracks — their format isn't supported by your browser")
	})
})

describe("playbackErrorLabel", () => {
	it("words a format failure as its notice does: skipped once the player moved on, stopped while still on it", () => {
		const a = track("a")

		expect(playbackErrorLabel(mediaFailureDTO("format"), a, track("b"))).toBe(
			"Skipped a.wma — its format isn't supported by your browser"
		)
		expect(playbackErrorLabel(mediaFailureDTO("format"), a, a)).toBe("Couldn't play a.wma — its format isn't supported by your browser")
	})

	it("labels any other failure through the errors catalog instead of the element's raw message", () => {
		expect(playbackErrorLabel(mediaFailureDTO("other"), track("a"), track("a"))).toBe("This file couldn't be played.")
	})
})

describe("notifyFormatFailure", () => {
	it("updates one notice with a count instead of stacking one per track", () => {
		notifyFormatFailure(track("a"), false)
		notifyFormatFailure(track("b"), false)
		notifyFormatFailure(track("c"), true)

		expect(warning.mock.calls.map(([message]) => message)).toEqual([
			"Skipped a.wma — its format isn't supported by your browser",
			"Skipped 2 tracks — their format isn't supported by your browser",
			"Couldn't play 3 tracks — their format isn't supported by your browser"
		])
		expect(new Set(warning.mock.calls.map(([, options]) => options.id)).size).toBe(1)
	})

	it("does not count a track twice when it fails again", () => {
		notifyFormatFailure(track("a"), false)
		notifyFormatFailure(track("a"), false)

		expect(warning.mock.lastCall?.[0]).toBe("Skipped a.wma — its format isn't supported by your browser")
	})

	it("starts over once the notice has closed", () => {
		notifyFormatFailure(track("a"), false)
		warning.mock.lastCall?.[1].onAutoClose()
		notifyFormatFailure(track("b"), true)

		expect(warning.mock.lastCall?.[0]).toBe("Couldn't play b.wma — its format isn't supported by your browser")
	})
})

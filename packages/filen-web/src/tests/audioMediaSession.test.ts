import { describe, expect, it, vi } from "vitest"
import type { AnyFile } from "@filen/sdk-rs"
import {
	buildMediaSessionActionHandlers,
	bindMediaSessionActions,
	createMediaSessionPublisher,
	mediaSessionMetadataFor,
	type MediaSessionActionInfo,
	type MediaSessionActionTarget
} from "@/features/audio/lib/mediaSession"
import type { QueueTrack } from "@/features/audio/store/audioQueue"

function track(name: string): QueueTrack {
	return { uuid: name, name, mime: "audio/mpeg", contentType: "audio/mpeg", file: {} as unknown as AnyFile }
}

function fakeTarget(): { target: MediaSessionActionTarget; calls: string[]; seeks: number[] } {
	const calls: string[] = []
	const seeks: number[] = []

	return {
		calls,
		seeks,
		target: {
			resume: () => calls.push("resume"),
			pause: () => calls.push("pause"),
			skipNext: () => calls.push("next"),
			skipPrevious: () => calls.push("previous"),
			seek: seconds => seeks.push(seconds)
		}
	}
}

describe("mediaSessionMetadataFor", () => {
	it("projects the track name as title with empty artist/album when no tags are supplied", () => {
		expect(mediaSessionMetadataFor(track("song.mp3"))).toEqual({ title: "song.mp3", artist: "", album: "" })
	})

	it("is null when nothing is playing", () => {
		expect(mediaSessionMetadataFor(null)).toBeNull()
	})

	it("prefers a resolved tag title over the filename, and carries artist/album through", () => {
		expect(mediaSessionMetadataFor(track("song.mp3"), { title: "Real Title", artist: "Real Artist", album: "Real Album" })).toEqual({
			title: "Real Title",
			artist: "Real Artist",
			album: "Real Album"
		})
	})

	it("falls back to the filename when tags resolved but the title is empty/null", () => {
		expect(mediaSessionMetadataFor(track("song.mp3"), { title: null, artist: "Real Artist", album: null })).toEqual({
			title: "song.mp3",
			artist: "Real Artist",
			album: ""
		})
	})
})

describe("buildMediaSessionActionHandlers — pure dispatch table", () => {
	it("maps play/pause/next/previous straight onto the target", () => {
		const { target, calls } = fakeTarget()
		const handlers = new Map(buildMediaSessionActionHandlers(target, () => 0))

		handlers.get("play")?.({ action: "play" })
		handlers.get("pause")?.({ action: "pause" })
		handlers.get("nexttrack")?.({ action: "nexttrack" })
		handlers.get("previoustrack")?.({ action: "previoustrack" })

		expect(calls).toEqual(["resume", "pause", "next", "previous"])
	})

	it("seekto seeks to the absolute time, ignoring a missing/non-finite seekTime", () => {
		const { target, seeks } = fakeTarget()
		const handlers = new Map(buildMediaSessionActionHandlers(target, () => 30))

		handlers.get("seekto")?.({ action: "seekto", seekTime: 42 })
		handlers.get("seekto")?.({ action: "seekto" })

		expect(seeks).toEqual([42])
	})

	it("seekbackward/seekforward nudge relative to the live playhead, clamped at zero", () => {
		const { target, seeks } = fakeTarget()
		const handlers = new Map(buildMediaSessionActionHandlers(target, () => 5))

		handlers.get("seekforward")?.({ action: "seekforward" })
		handlers.get("seekbackward")?.({ action: "seekbackward" })
		handlers.get("seekbackward")?.({ action: "seekbackward", seekOffset: 100 })

		expect(seeks).toEqual([15, 0, 0])
	})
})

describe("createMediaSessionPublisher — feature detection", () => {
	it("degrades to no-ops when Media Session is unsupported (explicit null)", () => {
		const publisher = createMediaSessionPublisher(null)

		expect(() => {
			publisher.setMetadata(track("a.mp3"))
			publisher.setPlaybackState("playing")
			publisher.setPositionState({ currentTimeMs: 1000, durationMs: 5000, paused: false, ended: false })
		}).not.toThrow()
	})

	it("builds a MediaMetadata with an artwork entry when a cover is supplied, none when it isn't", () => {
		class FakeMediaMetadata {
			public title: string
			public artist: string
			public album: string
			public artwork: unknown

			public constructor(init: { title: string; artist: string; album: string; artwork?: unknown }) {
				this.title = init.title
				this.artist = init.artist
				this.album = init.album
				this.artwork = init.artwork
			}
		}

		const originalMediaMetadata = globalThis.MediaMetadata

		globalThis.MediaMetadata = FakeMediaMetadata as unknown as typeof MediaMetadata

		try {
			const session = { metadata: null as unknown, playbackState: "none", setActionHandler: vi.fn() }
			const publisher = createMediaSessionPublisher(session)

			publisher.setMetadata(
				track("song.mp3"),
				{ title: "Real Title", artist: "Real Artist", album: "Real Album" },
				{ url: "blob:cover", type: "image/jpeg" }
			)

			expect(session.metadata).toBeInstanceOf(FakeMediaMetadata)
			expect((session.metadata as FakeMediaMetadata).artwork).toEqual([{ src: "blob:cover", type: "image/jpeg" }])

			publisher.setMetadata(track("song.mp3"), { title: "Real Title", artist: "Real Artist", album: "Real Album" })

			expect((session.metadata as FakeMediaMetadata).artwork).toBeUndefined()
		} finally {
			globalThis.MediaMetadata = originalMediaMetadata
		}
	})

	it("writes playbackState and position onto a supported session, guarding bad durations", () => {
		const setPositionState = vi.fn()
		const session = {
			metadata: null as unknown,
			playbackState: "none",
			setActionHandler: vi.fn(),
			setPositionState
		}

		const publisher = createMediaSessionPublisher(session)

		publisher.setPlaybackState("playing")
		expect(session.playbackState).toBe("playing")

		publisher.setPositionState({ currentTimeMs: 2000, durationMs: 5000, paused: false, ended: false })
		expect(setPositionState).toHaveBeenCalledWith({ duration: 5, position: 2, playbackRate: 1 })

		// A zero/unknown duration is rejected by the platform, so the publisher skips it rather than throw.
		publisher.setPositionState({ currentTimeMs: 0, durationMs: 0, paused: true, ended: false })
		expect(setPositionState).toHaveBeenCalledTimes(1)

		// Position never exceeds duration (a late timeupdate past the end clamps).
		publisher.setPositionState({ currentTimeMs: 9000, durationMs: 5000, paused: false, ended: true })
		expect(setPositionState).toHaveBeenLastCalledWith({ duration: 5, position: 5, playbackRate: 1 })
	})
})

describe("bindMediaSessionActions — feature detection", () => {
	it("installs every handler on a supported session", () => {
		const setActionHandler = vi.fn()
		const session = { metadata: null as unknown, playbackState: "none", setActionHandler }
		const { target } = fakeTarget()

		bindMediaSessionActions(target, () => 0, session)

		const boundActions = setActionHandler.mock.calls.map(call => call[0] as string)

		expect(boundActions).toEqual(["play", "pause", "previoustrack", "nexttrack", "seekto", "seekbackward", "seekforward"])
	})

	it("is a no-op when unsupported and swallows a per-action NotSupportedError", () => {
		const { target } = fakeTarget()

		expect(() => {
			bindMediaSessionActions(target, () => 0, null)
		}).not.toThrow()

		const session = {
			metadata: null as unknown,
			playbackState: "none",
			setActionHandler: (action: string, _handler: ((info: MediaSessionActionInfo) => void) | null) => {
				if (action === "seekforward") {
					throw new Error("NotSupportedError")
				}
			}
		}

		expect(() => {
			bindMediaSessionActions(target, () => 0, session)
		}).not.toThrow()
	})
})

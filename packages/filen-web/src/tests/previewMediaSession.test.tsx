// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest"
import { renderHook } from "@testing-library/react"
import type { MediaSessionHandler } from "@/lib/media/mediaSessionOwner"

const fake = vi.hoisted(() => {
	const handlers = new Map<string, unknown>()
	const session = {
		metadata: null as unknown,
		playbackState: "none",
		setActionHandler: (action: string, handler: unknown) => {
			handlers.set(action, handler)
		}
	}

	return { handlers, session }
})

vi.mock("@/lib/media/mediaSessionOwner", async importOriginal => {
	const actual = await importOriginal<typeof import("@/lib/media/mediaSessionOwner")>()

	return { ...actual, mediaSessionOwners: new actual.MediaSessionOwners(fake.session) }
})

import { mediaSessionOwners } from "@/lib/media/mediaSessionOwner"
import { usePreviewMediaSession } from "@/features/preview/hooks/usePreviewMediaSession"

describe("usePreviewMediaSession", () => {
	it("takes the session from the music on its first play and gives it back on close", () => {
		const musicPaused = vi.fn()
		const resume: MediaSessionHandler = () => undefined
		const music = mediaSessionOwners.create("audio", { onPreempt: musicPaused })

		music.acquire()
		music.setActionHandler("play", resume)

		const audio = document.createElement("audio")
		const { unmount } = renderHook(() => {
			usePreviewMediaSession(audio, "song.flac")
		})

		// Opened but not played: the music keeps the session.
		expect(music.active).toBe(true)
		expect(musicPaused).not.toHaveBeenCalled()

		audio.dispatchEvent(new Event("play"))

		expect(music.active).toBe(false)
		expect(musicPaused).toHaveBeenCalledTimes(1)
		expect(fake.handlers.get("play")).not.toBe(resume)
		expect(fake.handlers.get("enterpictureinpicture")).toBeNull()

		unmount()

		expect(music.active).toBe(true)
		expect(fake.handlers.get("play")).toBe(resume)
		music.release()
	})

	it("pauses when another player takes the session over", () => {
		const video = document.createElement("video")
		const pause = vi.fn()

		video.pause = pause
		Object.defineProperty(video, "paused", { value: false })

		const { unmount } = renderHook(() => {
			usePreviewMediaSession(video, "clip.mp4")
		})
		const other = mediaSessionOwners.create("video")

		other.acquire()

		expect(pause).toHaveBeenCalledTimes(1)
		other.release()
		unmount()
	})
})

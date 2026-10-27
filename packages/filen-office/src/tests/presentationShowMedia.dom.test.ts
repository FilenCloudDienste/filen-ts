// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest"
import type { SlideLayer, SlideMediaInfo } from "../core/presentation/output"
import type { PresentationSessionApi } from "../dom/presentation/protocol"
import { showMediaMount, type ShowMediaStreams } from "../react/presentation/show/media"

// A medium in the show: a deflated one still preparing shows its progress and plays once it is ready, and a stream
// the service worker dropped while the element sat paused is asked for again once.

const MEDIA: SlideMediaInfo = { kind: "video", part: "/ppt/media/media1.mp4", contentType: "video/mp4" }
const LAYER = { shape: { slide: 1, id: 4 }, media: MEDIA } as unknown as SlideLayer
const LABELS = {
	openLink: "Open",
	preparing: "Preparing media",
	preparingProgress: (percent: number) => `Preparing media (${String(percent)} %)`,
	unplayable: "Unplayable",
	unavailable: "Unavailable"
}
const EVENTS = { ended: () => undefined, bookmark: () => undefined }
const SESSION = {} as PresentationSessionApi

function flush(): Promise<void> {
	return new Promise(resolve => {
		setTimeout(resolve, 0)
	})
}

describe("show media", () => {
	it("shows a deflated medium's preparation and plays it once it is ready", async () => {
		let ready = false
		let progress: ((value: number) => void) | undefined
		const unsubscribe = vi.fn()
		const streams: ShowMediaStreams = {
			url: () =>
				Promise.resolve(
					ready ? { kind: "url", url: "blob:media", release: () => undefined } : { kind: "refused", reason: "preparing" }
				),
			prepared: (_media, listener) => {
				progress = listener

				return unsubscribe
			}
		}
		const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined)
		const box = document.createElement("div")
		const handle = showMediaMount(streams, { labels: LABELS }).mount(box, LAYER, SESSION, EVENTS)

		handle.command({ command: "play" })
		await flush()

		expect(box.textContent).toBe("Preparing media")

		progress?.(0.4)

		expect(box.textContent).toBe("Preparing media (40 %)")

		ready = true
		progress?.(1)
		await flush()

		expect(unsubscribe).toHaveBeenCalledOnce()
		expect(box.querySelector("video")?.getAttribute("src")).toBe("blob:media")
		expect(play).toHaveBeenCalled()

		handle.release()
		play.mockRestore()
	})

	it("asks for the stream again once after a network error, resuming where it was", async () => {
		const urls = ["blob:first", "blob:second"]
		const released: string[] = []
		const streams: ShowMediaStreams = {
			url: () => {
				const url = urls.shift() ?? "blob:none"

				return Promise.resolve({ kind: "url", url, release: () => released.push(url) })
			}
		}
		const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined)
		const box = document.createElement("div")
		const handle = showMediaMount(streams, { labels: LABELS }).mount(box, LAYER, SESSION, EVENTS)

		handle.command({ command: "play" })
		await flush()

		const video = box.querySelector("video") as HTMLVideoElement

		video.currentTime = 12
		Object.defineProperty(video, "error", { configurable: true, value: { code: 2 } })
		video.dispatchEvent(new Event("error"))
		await flush()

		expect(released).toEqual(["blob:first"])
		expect(video.getAttribute("src")).toBe("blob:second")
		expect(box.textContent).toBe("")

		// A second network error is the medium's: it says so.
		video.dispatchEvent(new Event("error"))
		await flush()

		expect(box.textContent).toBe("Unplayable")

		handle.release()
		play.mockRestore()
	})

	it("plays a medium on its click trigger's togglePause, and pauses it on the next", async () => {
		const streams: ShowMediaStreams = { url: () => Promise.resolve({ kind: "url", url: "blob:media", release: () => undefined }) }
		const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined)
		const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined)
		const box = document.createElement("div")
		const handle = showMediaMount(streams, { labels: LABELS }).mount(box, LAYER, SESSION, EVENTS)

		handle.command({ command: "toggle" })
		await flush()

		const video = box.querySelector("video") as HTMLVideoElement

		expect(play).toHaveBeenCalledOnce()

		Object.defineProperty(video, "paused", { configurable: true, value: false })
		handle.command({ command: "toggle" })
		await flush()

		expect(pause).toHaveBeenCalled()
		expect(play).toHaveBeenCalledOnce()

		handle.release()
		play.mockRestore()
		pause.mockRestore()
	})

	it("lets go of a played medium without loading an empty source", async () => {
		const streams: ShowMediaStreams = { url: () => Promise.resolve({ kind: "url", url: "blob:media", release: () => undefined }) }
		const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined)
		const load = vi.spyOn(HTMLMediaElement.prototype, "load")
		const box = document.createElement("div")
		const handle = showMediaMount(streams, { labels: LABELS }).mount(box, LAYER, SESSION, EVENTS)

		handle.command({ command: "play" })
		await flush()
		handle.release()

		expect(load).not.toHaveBeenCalled()
		expect(box.querySelector("video")).toBeNull()

		play.mockRestore()
		load.mockRestore()
	})

	it("pauses a playing video pressed on its picture, leaving presses on its control bar to the bar", async () => {
		const streams: ShowMediaStreams = { url: () => Promise.resolve({ kind: "url", url: "blob:media", release: () => undefined }) }
		const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined)
		const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined)
		const box = document.createElement("div")
		const handle = showMediaMount(streams, { labels: LABELS }).mount(box, LAYER, SESSION, EVENTS)
		const advanced = vi.fn()

		box.addEventListener("click", advanced)
		handle.command({ command: "play" })
		await flush()

		const video = box.querySelector("video") as HTMLVideoElement

		Object.defineProperty(video, "paused", { configurable: true, value: false })
		video.getBoundingClientRect = () => ({ top: 0, bottom: 300, left: 0, right: 400, width: 400, height: 300, x: 0, y: 0 }) as DOMRect
		video.controls = true
		video.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 200, clientY: 290 }))
		await flush()

		expect(pause).not.toHaveBeenCalled()

		video.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 200, clientY: 100 }))
		await flush()

		expect(pause).toHaveBeenCalled()
		expect(advanced).not.toHaveBeenCalled()

		handle.release()
		play.mockRestore()
		pause.mockRestore()
	})
})

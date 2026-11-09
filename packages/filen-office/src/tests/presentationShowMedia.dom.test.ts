// @vitest-environment happy-dom
import { hasHeldPause } from "@filen/shared/heldPause"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
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

	it("asks nothing of a medium no browser can decode (Windows Media), going to the remux and else saying so", async () => {
		const asf = {
			shape: { slide: 1, id: 4 },
			media: { kind: "video", part: "/ppt/media/media1.asf", contentType: "video/x-ms-asf" }
		} as unknown as SlideLayer
		const released: string[] = []
		const remuxed: HTMLMediaElement[] = []
		const streams: ShowMediaStreams = {
			url: () => Promise.resolve({ kind: "url", url: "blob:media", release: () => released.push("blob:media") }),
			remux: (_session, _media, element) => {
				remuxed.push(element)

				return Promise.resolve(undefined)
			}
		}
		const canPlay = vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue("")
		const box = document.createElement("div")
		const handle = showMediaMount(streams, { labels: LABELS }).mount(box, asf, SESSION, EVENTS)

		handle.command({ command: "play" })
		await flush()
		await flush()

		const video = box.querySelector("video") as HTMLVideoElement

		// No request the element would abandon (Firefox logs one under the service worker as a failed load of '').
		expect(video.hasAttribute("src")).toBe(false)
		expect(released).toEqual(["blob:media"])
		expect(remuxed).toEqual([video])
		expect(box.textContent).toBe("Unplayable")

		handle.release()
		canPlay.mockRestore()
	})

	it("still asks for a medium of a sniffed container the element doubts (QuickTime in Chromium)", async () => {
		const mov = {
			shape: { slide: 1, id: 4 },
			media: { kind: "video", part: "/ppt/media/media4.mov", contentType: "video/quicktime" }
		} as unknown as SlideLayer
		const streams: ShowMediaStreams = { url: () => Promise.resolve({ kind: "url", url: "blob:media", release: () => undefined }) }
		const canPlay = vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue("")
		const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined)
		const box = document.createElement("div")
		const handle = showMediaMount(streams, { labels: LABELS }).mount(box, mov, SESSION, EVENTS)

		handle.command({ command: "play" })
		await flush()

		expect(box.querySelector("video")?.getAttribute("src")).toBe("blob:media")

		handle.release()
		canPlay.mockRestore()
		play.mockRestore()
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
	it("plays a transition sound from its stream, looped when asked, and lets the stream go when stopped", async () => {
		const released: string[] = []
		const asked: unknown[] = []
		const streams: ShowMediaStreams = {
			url: (_session, media) => {
				asked.push(media)

				return Promise.resolve({ kind: "url", url: "blob:chime", release: () => released.push("blob:chime") })
			}
		}
		const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined)
		const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined)
		const mount = showMediaMount(streams, { labels: LABELS })
		const sound = mount.sound?.(SESSION, { part: "/ppt/media/audio1.wav", loop: true })

		await flush()

		expect(asked).toEqual([{ kind: "audio", part: "/ppt/media/audio1.wav", contentType: "audio/wav" }])
		expect(play).toHaveBeenCalledOnce()

		const element = play.mock.contexts[0] as HTMLAudioElement

		expect(element.loop).toBe(true)
		expect(element.getAttribute("src")).toBe("blob:chime")

		sound?.stop()

		expect(pause).toHaveBeenCalled()
		expect(released).toEqual(["blob:chime"])

		play.mockRestore()
		pause.mockRestore()
	})
})

// Linux WebKit loses a pause made while a seek is in flight (@filen/shared/heldPause): the medium pauses once the seek
// lands, a play or toggle in the meantime drops that pause, and a new stream is not paused for the old one's seek.
describe("show media: a pause while a seek is in flight", () => {
	const streams: ShowMediaStreams = { url: () => Promise.resolve({ kind: "url", url: "blob:media", release: () => undefined }) }
	let paused = true
	let seeking = false

	beforeEach(() => {
		vi.useFakeTimers()
		paused = true
		seeking = false
		vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => {
			paused = false

			return Promise.resolve()
		})
		vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {
			paused = true
		})
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	async function playing() {
		const box = document.createElement("div")
		const handle = showMediaMount(streams, { labels: LABELS }).mount(box, LAYER, SESSION, EVENTS)

		handle.command({ command: "play" })
		await vi.advanceTimersByTimeAsync(0)

		const video = box.querySelector("video") as HTMLVideoElement

		Object.defineProperty(video, "paused", { configurable: true, get: () => paused })
		Object.defineProperty(video, "seeking", { configurable: true, get: () => seeking })

		return { box, handle, video }
	}

	function landSeek(video: HTMLMediaElement): void {
		seeking = false
		video.dispatchEvent(new Event("seeked"))
	}

	it("pauses at once when no seek is in flight", async () => {
		const { handle, video } = await playing()

		handle.command({ command: "pause" })
		await vi.advanceTimersByTimeAsync(0)

		expect(HTMLMediaElement.prototype.pause).toHaveBeenCalledOnce()
		expect(hasHeldPause(video)).toBe(false)

		handle.release()
	})

	it("holds a pause until the seek lands", async () => {
		const { handle, video } = await playing()

		seeking = true
		handle.command({ command: "pause" })
		await vi.advanceTimersByTimeAsync(0)

		expect(HTMLMediaElement.prototype.pause).not.toHaveBeenCalled()

		landSeek(video)

		expect(HTMLMediaElement.prototype.pause).toHaveBeenCalledOnce()
		expect(hasHeldPause(video)).toBe(false)

		handle.release()
	})

	it("holds a stop's pause for its own seek to the start", async () => {
		const { handle, video } = await playing()

		video.currentTime = 4
		seeking = true
		handle.command({ command: "stop" })
		await vi.advanceTimersByTimeAsync(0)

		expect(video.currentTime).toBe(0)
		expect(HTMLMediaElement.prototype.pause).not.toHaveBeenCalled()

		landSeek(video)

		expect(HTMLMediaElement.prototype.pause).toHaveBeenCalledOnce()

		handle.release()
	})

	it("takes a toggle during the hold as play: the pause is dropped and the medium plays on", async () => {
		const { handle, video } = await playing()

		seeking = true
		handle.command({ command: "toggle" })
		await vi.advanceTimersByTimeAsync(0)

		expect(hasHeldPause(video)).toBe(true)

		handle.command({ command: "toggle" })
		await vi.advanceTimersByTimeAsync(0)
		landSeek(video)
		await vi.advanceTimersByTimeAsync(5000)

		expect(HTMLMediaElement.prototype.pause).not.toHaveBeenCalled()
		expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2)
		expect(paused).toBe(false)

		handle.release()
	})

	it("drops a held pause when a press on the picture asks to play", async () => {
		const { handle, video } = await playing()

		seeking = true
		handle.command({ command: "pause" })
		await vi.advanceTimersByTimeAsync(0)
		handle.click()
		await vi.advanceTimersByTimeAsync(0)
		landSeek(video)

		expect(HTMLMediaElement.prototype.pause).not.toHaveBeenCalled()
		expect(paused).toBe(false)

		handle.release()
	})

	it("keeps the pause of a medium let go mid-seek, made once the seek lands or the hold's bound passes", async () => {
		const first = await playing()

		seeking = true
		first.handle.release()

		expect(HTMLMediaElement.prototype.pause).not.toHaveBeenCalled()

		landSeek(first.video)

		expect(HTMLMediaElement.prototype.pause).toHaveBeenCalledOnce()

		paused = true
		vi.mocked(HTMLMediaElement.prototype.pause).mockClear()

		const second = await playing()

		seeking = true
		second.handle.release()
		await vi.advanceTimersByTimeAsync(3000)

		expect(HTMLMediaElement.prototype.pause).toHaveBeenCalledOnce()
		expect(hasHeldPause(second.video)).toBe(false)
	})

	it("drops a held pause when the stream is asked for again after a network error", async () => {
		const urls = ["blob:first", "blob:second"]
		const reopening: ShowMediaStreams = {
			url: () => Promise.resolve({ kind: "url", url: urls.shift() ?? "blob:none", release: () => undefined })
		}
		const box = document.createElement("div")
		const handle = showMediaMount(reopening, { labels: LABELS }).mount(box, LAYER, SESSION, EVENTS)

		handle.command({ command: "play" })
		await vi.advanceTimersByTimeAsync(0)

		const video = box.querySelector("video") as HTMLVideoElement

		Object.defineProperty(video, "paused", { configurable: true, get: () => paused })
		Object.defineProperty(video, "seeking", { configurable: true, get: () => seeking })
		seeking = true
		handle.command({ command: "pause" })
		await vi.advanceTimersByTimeAsync(0)

		expect(hasHeldPause(video)).toBe(true)

		Object.defineProperty(video, "error", { configurable: true, value: { code: 2 } })
		video.dispatchEvent(new Event("error"))
		await vi.advanceTimersByTimeAsync(0)

		expect(video.getAttribute("src")).toBe("blob:second")
		expect(hasHeldPause(video)).toBe(false)

		landSeek(video)

		expect(HTMLMediaElement.prototype.pause).not.toHaveBeenCalled()

		handle.release()
	})

	it("holds a transition sound's stop until a loop's seek lands", async () => {
		const sound = showMediaMount(streams, { labels: LABELS }).sound?.(SESSION, { part: "/ppt/media/audio1.wav", loop: true })

		await vi.advanceTimersByTimeAsync(0)

		const element = vi.mocked(HTMLMediaElement.prototype.play).mock.contexts[0] as HTMLAudioElement

		Object.defineProperty(element, "seeking", { configurable: true, get: () => seeking })
		seeking = true
		sound?.stop()

		expect(HTMLMediaElement.prototype.pause).not.toHaveBeenCalled()
		expect(element.hasAttribute("src")).toBe(false)

		landSeek(element)

		expect(HTMLMediaElement.prototype.pause).toHaveBeenCalledOnce()
	})
})

// PowerPoint's Video Playback options in the show: Hide While Not Playing (showWhenStopped="0") hides the poster and the
// box until the medium plays; Play Full Screen (fullScrn) puts the playing video over the whole slide.
describe("show media: hide while not playing and play full screen", () => {
	const streams: ShowMediaStreams = { url: () => Promise.resolve({ kind: "url", url: "blob:media", release: () => undefined }) }

	// The stage's nesting: the slide box, the medium's layer element with its poster bitmap, and the box beside it.
	function stage(playback: SlideMediaInfo["playback"]) {
		const slide = document.createElement("div")
		const host = document.createElement("div")
		const poster = document.createElement("canvas")
		const box = document.createElement("div")

		slide.dataset["foShowSlide"] = ""
		poster.className = "fo-show-bitmap"
		poster.dataset["foShowShape"] = "4"
		host.append(poster, box)
		slide.append(host)
		document.body.append(slide)

		return { slide, poster, box, layer: { ...LAYER, media: { ...MEDIA, playback } } as unknown as SlideLayer }
	}

	it("hides the poster and box while stopped in the show, showing them while it plays", async () => {
		const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined)
		const { slide, poster, box, layer } = stage({ hideWhenStopped: true })
		const handle = showMediaMount(streams, { labels: LABELS, hoverControls: true }).mount(box, layer, SESSION, EVENTS)

		expect(box.style.visibility).toBe("hidden")
		expect(poster.style.opacity).toBe("0")

		handle.command({ command: "play" })
		await flush()

		const video = box.querySelector("video")

		video?.dispatchEvent(new Event("play"))

		expect(box.style.visibility).toBe("")
		expect(poster.style.opacity).toBe("")

		video?.dispatchEvent(new Event("pause"))

		expect(box.style.visibility).toBe("hidden")
		expect(poster.style.opacity).toBe("0")

		handle.release()
		slide.remove()
		play.mockRestore()
	})

	it("leaves the poster shown on the editor's canvas and when the option is off", () => {
		const editor = stage({ hideWhenStopped: true })
		const off = stage({})

		showMediaMount(streams, { labels: LABELS, hoverControls: false }).mount(editor.box, editor.layer, SESSION, EVENTS).release()
		showMediaMount(streams, { labels: LABELS, hoverControls: true }).mount(off.box, off.layer, SESSION, EVENTS).release()

		expect([editor.box.style.visibility, editor.poster.style.opacity, off.box.style.visibility, off.poster.style.opacity]).toEqual([
			"",
			"",
			"",
			""
		])

		editor.slide.remove()
		off.slide.remove()
	})

	it("plays a full screen video over the whole slide on black, back in its box once paused", async () => {
		const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined)
		const { slide, box, layer } = stage({ fullScreen: true })
		const handle = showMediaMount(streams, { labels: LABELS, hoverControls: true }).mount(box, layer, SESSION, EVENTS)

		handle.command({ command: "play" })
		await flush()

		const video = box.querySelector("video")

		expect(video).not.toBeNull()

		video?.dispatchEvent(new Event("play"))

		expect(video?.parentElement).toBe(slide)
		expect(video?.style.background).toBe("#000")

		// A press on the picture over the slide still pauses it and never reaches the slide's advance.
		const advance = vi.fn()

		slide.addEventListener("click", advance)
		video?.dispatchEvent(new MouseEvent("click", { bubbles: true, clientY: -1000 }))

		expect(advance).not.toHaveBeenCalled()

		video?.dispatchEvent(new Event("pause"))

		expect(video?.parentElement).toBe(box)
		expect(video?.style.background).toBe("transparent")

		handle.release()
		slide.remove()
		play.mockRestore()
	})
})

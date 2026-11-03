import type { LayerState } from "../../../core/anim/model"
import type { SlideLayer, SlideMediaInfo } from "../../../core/presentation/output"
import type { MediaRefusal, PresentationSessionApi } from "../../../dom/presentation/protocol"
import { MediaTimingDriver, noteMediaDuration } from "./mediaTiming"
import type { ShowMediaEvents, ShowMediaHandle, ShowMediaMount, ShowSoundHandle } from "./stage"

// A medium on a slide as a native <video>/<audio> over its layer, for the show and the editor's canvas alike. The
// layer's bitmap beneath is the poster: the element is transparent until it has a frame, and nothing is fetched until
// the medium is first played (the stream URL is asked for then, and released with the element). Native controls show
// while the pointer is over the box. A format the element cannot play goes through the page's remux fallback when it
// has one (the web's MediaSource path, fed by the same range port), else the box says so. Linked media are never
// fetched: an http(s) target is offered as a link the page opens through its link policy.

// The sampled command, and the toggle a togglePause call (PowerPoint's click trigger on a medium) gives.
export type MediaCommand = NonNullable<LayerState["media"]> | { readonly command: "toggle"; readonly atMs?: number }

// What the page provides: a stream URL for a medium (media(part, port) registered with its service worker), and a
// player for formats the element cannot decode.
export interface ShowMediaStreams {
	url(
		session: PresentationSessionApi,
		media: SlideMediaInfo
	): Promise<
		| { readonly kind: "url"; readonly url: string; release(): void }
		| { readonly kind: "refused"; readonly reason: MediaRefusal["reason"] }
	>
	remux?(session: PresentationSessionApi, media: SlideMediaInfo, element: HTMLMediaElement): Promise<MediaRemux | undefined>
	// Opens a linked medium's web address (the page's link policy decides; never fetched here).
	openLink?(href: string): void
	// Calls `listener` with a deflated medium's preparation progress (0..1, the worker's "media" notices) until the
	// returned unsubscribe; 1 when it can be played.
	prepared?(media: SlideMediaInfo, listener: (progress: number) => void): () => void
}

export interface MediaRemux {
	play(): Promise<void>
	seek(seconds: number): void
	dispose(): void
}

export interface ShowMediaLabels {
	readonly openLink: string
	readonly preparing: string
	// "Preparing media (n %)".
	readonly preparingProgress?: (percent: number) => string
	readonly unplayable: string
	readonly unavailable: string
}

export type ShowMediaStatus = "idle" | "loading" | "playing" | "paused" | "ended" | "preparing" | "unplayable" | "unavailable" | "linked"

export interface ShowMediaOptions {
	readonly labels: ShowMediaLabels
	// Native controls on hover (the show); false keeps them always shown once loaded (the editor's canvas).
	readonly hoverControls?: boolean
	readonly onStatus?: (shape: number, status: ShowMediaStatus) => void
}

const WEB_LINK = /^https?:\/\//iu
// The height of a native media control bar at the element's bottom (every engine's is under it).
const CONTROL_BAR_PX = 48
const BOX_STYLE = "position:absolute;inset:0;width:100%;height:100%"
// A chip over the poster (in the slide's own colours whatever the app's theme: it sits on the slide).
const CHIP_STYLE =
	"position:absolute;left:8px;bottom:8px;max-width:calc(100% - 16px);padding:4px 8px;border:0;border-radius:6px;background:rgba(0,0,0,0.72);color:#fff;font:500 12px/16px system-ui,sans-serif"

function noteElement(document: Document, text: string): HTMLElement {
	const note = document.createElement("div")

	note.className = "fo-show-media-note"
	note.style.cssText = CHIP_STYLE
	note.setAttribute("role", "status")
	note.textContent = text

	return note
}

// One mounted medium.
class MountedMedia implements ShowMediaHandle {
	private readonly box: HTMLElement
	private readonly media: SlideMediaInfo
	private readonly session: PresentationSessionApi | undefined
	private readonly events: ShowMediaEvents
	private readonly streams: ShowMediaStreams
	private readonly options: ShowMediaOptions
	private readonly shape: number
	private element: HTMLMediaElement | undefined
	private stream: { release(): void } | undefined
	private remux: MediaRemux | undefined
	// The medium's trim, fade and bookmarks while its element lives (react/presentation/show/mediaTiming.ts).
	private timing: MediaTimingDriver | undefined
	private loading: Promise<boolean> | undefined
	private note: HTMLElement | undefined
	private released = false
	// The preparation progress subscription while the medium is preparing.
	private preparing: (() => void) | undefined
	// The stream was asked for again once after a network error (an idle service worker dropped its registration).
	private reopened = false
	// What the last command asked for, applied once the element can play.
	private wanted: { playing: boolean; atMs?: number } = { playing: false }

	constructor(
		box: HTMLElement,
		layer: SlideLayer,
		media: SlideMediaInfo,
		session: PresentationSessionApi | undefined,
		events: ShowMediaEvents,
		streams: ShowMediaStreams,
		options: ShowMediaOptions
	) {
		this.box = box
		this.media = media
		this.session = session
		this.events = events
		this.streams = streams
		this.options = options
		this.shape = layer.shape.id

		if (media.part === undefined) this.linked()
	}

	command(command: MediaCommand): void {
		if (this.released) return

		switch (command.command) {
			case "play":
			case "resume":
				this.wanted = { playing: true, ...(command.atMs === undefined ? {} : { atMs: command.atMs }) }
				break
			case "pause":
				this.wanted = { playing: false }
				break
			case "stop":
				this.wanted = { playing: false, atMs: 0 }
				break
			case "seek":
				this.wanted = { playing: this.wanted.playing, atMs: command.atMs ?? 0 }
				break
			case "toggle":
				this.wanted = { playing: !this.isPlaying() }
				break
		}

		void this.apply()
	}

	// Playing, or asked to play and still loading.
	private isPlaying(): boolean {
		const element = this.element

		return element === undefined ? this.wanted.playing && this.loading !== undefined : !element.paused && !element.ended
	}

	click(): void {
		if (this.released) return

		if (this.media.part === undefined) {
			const href = this.media.external

			if (href !== undefined && WEB_LINK.test(href)) this.streams.openLink?.(href)

			return
		}

		const element = this.element
		const playing = element !== undefined && !element.paused && !element.ended

		this.command({ command: playing ? "pause" : "play" })
	}

	release(): void {
		if (this.released) return

		this.released = true
		this.timing?.dispose()
		this.timing = undefined
		this.remux?.dispose()
		this.remux = undefined

		const element = this.element

		// Paused, unlinked and dropped: its stream is released below, so no range request follows. No load() over the
		// emptied source (Firefox logs it as a failed load of '').
		if (element !== undefined) {
			element.pause()
			element.removeAttribute("src")
			element.remove()
		}

		this.element = undefined
		this.stream?.release()
		this.stream = undefined
		this.preparing?.()
		this.preparing = undefined
		this.note?.remove()
	}

	private status(status: ShowMediaStatus): void {
		this.options.onStatus?.(this.shape, status)
	}

	private say(text: string | undefined): void {
		this.note?.remove()
		this.note = text === undefined ? undefined : noteElement(this.box.ownerDocument, text)

		if (this.note !== undefined) this.box.append(this.note)
	}

	private linked(): void {
		const href = this.media.external

		this.status("linked")

		if (href === undefined || !WEB_LINK.test(href) || this.streams.openLink === undefined) return

		const button = this.box.ownerDocument.createElement("button")

		button.type = "button"
		button.className = "fo-show-media-link"
		button.style.cssText = `${CHIP_STYLE};cursor:pointer;pointer-events:auto`
		button.textContent = this.options.labels.openLink
		button.title = href
		button.addEventListener("click", event => {
			event.stopPropagation()
			this.streams.openLink?.(href)
		})
		this.box.append(button)
	}

	// The element with its stream, made on first use; false when the medium cannot play.
	private load(): Promise<boolean> {
		this.loading ??= this.open()

		return this.loading
	}

	private async open(): Promise<boolean> {
		const session = this.session

		if (session === undefined || this.media.part === undefined) return false

		this.status("loading")

		const stream = await this.streams.url(session, this.media).catch(() => ({ kind: "refused" as const, reason: "notFound" as const }))

		if (this.released) {
			if (stream.kind === "url") stream.release()

			return false
		}

		if (stream.kind === "refused") {
			// Preparing: the index of a deflated medium is being built; the play goes on once it is (or the next play
			// asks again).
			if (stream.reason === "preparing") {
				this.loading = undefined
				this.say(this.options.labels.preparing)
				this.status("preparing")
				this.watchPreparation()
			} else {
				this.say(this.options.labels.unavailable)
				this.status("unavailable")
			}

			return false
		}

		this.say(undefined)
		this.stream = stream

		const document = this.box.ownerDocument
		const element = document.createElement(this.media.kind === "video" ? "video" : "audio")

		element.className = "fo-show-media"
		element.style.cssText =
			this.media.kind === "video"
				? `${BOX_STYLE};object-fit:contain;background:transparent`
				: "position:absolute;left:0;right:0;bottom:0;width:100%"
		element.preload = "metadata"
		// Its length, for the Trim dialog (no second load of the medium to learn it).
		element.addEventListener("loadedmetadata", () => {
			if (this.media.part !== undefined) noteMediaDuration(session, this.media.part, element.duration)
		})
		element.controls = this.options.hoverControls === false

		// The file's playback options (p:cMediaNode vol and mute, the media node's repeat).
		const playback = this.media.playback

		const volume = Math.max(0, Math.min(1, (playback?.volume ?? 100_000) / 100_000))

		element.volume = volume
		element.muted = playback?.mute === true
		element.setAttribute("playsinline", "")

		// A trim, fade or bookmarks: the driver loops within the trimmed part itself.
		if (this.media.timing !== undefined)
			this.timing = new MediaTimingDriver(
				element,
				this.media.timing,
				{
					bookmark: name => {
						this.events.bookmark(name)
					},
					ended: () => {
						this.wanted = { playing: false }
						this.status("ended")
						this.events.ended()
					}
				},
				{ loop: playback?.loop === true, volume }
			)

		element.loop = playback?.loop === true && this.timing === undefined

		if (this.options.hoverControls !== false) {
			this.box.addEventListener("pointerenter", () => {
				element.controls = true
			})
			this.box.addEventListener("pointerleave", () => {
				element.controls = false
			})
		}

		// Presses on it are its own: the stage's click (advance) must not see them. A press on the picture plays or
		// pauses it, as PowerPoint's click trigger on a medium does; one on its native control bar is the bar's.
		element.addEventListener("click", event => {
			event.stopPropagation()

			if (this.media.kind !== "video") return
			if (element.controls && (event as MouseEvent).clientY >= element.getBoundingClientRect().bottom - CONTROL_BAR_PX) return

			event.preventDefault()
			this.click()
		})
		element.addEventListener("pointerdown", event => {
			event.stopPropagation()
		})
		element.addEventListener("ended", () => {
			this.wanted = { playing: false }
			this.status("ended")
			this.events.ended()
		})
		element.addEventListener("play", () => this.status("playing"))
		element.addEventListener("pause", () => {
			if (!element.ended) this.status("paused")
		})
		element.addEventListener("error", () => {
			void this.failed(element)
		})
		element.src = stream.url
		this.box.append(element)
		this.element = element

		return true
	}

	// Follows the preparation: its progress on the chip, and the play asked for once it is done.
	private watchPreparation(): void {
		if (this.preparing !== undefined || this.streams.prepared === undefined) return

		this.preparing = this.streams.prepared(this.media, progress => {
			if (this.released) return

			if (progress < 1) {
				const label = this.options.labels.preparingProgress

				this.say(label === undefined ? this.options.labels.preparing : label(Math.floor(progress * 100)))

				return
			}

			this.preparing?.()
			this.preparing = undefined
			void this.apply()
		})
	}

	// A network error on a stream that played: the service worker may have dropped its registration while idle, so
	// the stream is asked for once more and the element resumes where it was.
	private async reopen(element: HTMLMediaElement): Promise<boolean> {
		const session = this.session

		if (this.reopened || this.stream === undefined || session === undefined) return false

		this.reopened = true

		const at = element.currentTime

		this.stream.release()
		this.stream = undefined

		const stream = await this.streams.url(session, this.media).catch(() => ({ kind: "refused" as const }))

		if (this.released || stream.kind !== "url") {
			if (stream.kind === "url") stream.release()

			return false
		}

		this.stream = stream
		element.src = stream.url
		element.currentTime = at

		if (this.wanted.playing) await element.play().catch(() => undefined)

		return true
	}

	// The element could not decode the medium: the page's remux path, else a notice.
	private async failed(element: HTMLMediaElement): Promise<void> {
		if (element.error?.code === 2 && (await this.reopen(element))) return
		if (this.released) return

		const unsupported = element.error?.code === 4

		if (!unsupported || this.remux !== undefined || this.streams.remux === undefined || this.session === undefined) {
			this.say(this.options.labels.unplayable)
			this.status("unplayable")

			return
		}

		element.removeAttribute("src")
		this.stream?.release()
		this.stream = undefined

		const remux = await this.streams.remux(this.session, this.media, element).catch(() => undefined)

		if (this.released) {
			remux?.dispose()

			return
		}

		if (remux === undefined) {
			this.say(this.options.labels.unplayable)
			this.status("unplayable")

			return
		}

		this.remux = remux
		void this.apply()
	}

	private async apply(): Promise<void> {
		const wanted = this.wanted

		if (!wanted.playing && this.element === undefined) return
		if (!(await this.load()) || this.released) return

		const element = this.element

		if (element === undefined || wanted !== this.wanted) return

		if (wanted.atMs !== undefined) {
			// From the trimmed start: playFrom(t) and a stop's 0 are positions in the part that plays.
			const seconds = this.timing?.seekSeconds(wanted.atMs) ?? wanted.atMs / 1000

			if (this.remux !== undefined) this.remux.seek(seconds)
			else element.currentTime = seconds

			this.wanted = { playing: wanted.playing }
		}

		if (!wanted.playing) {
			element.pause()

			return
		}

		try {
			await (this.remux?.play() ?? element.play())
		} catch {
			// Autoplay refused (no user activation yet) or interrupted by a later command: the controls stay.
		}
	}
}

class InertMedia implements ShowMediaHandle {
	command(): void {}
	click(): void {}
	release(): void {}
}

// The mount the show's player (and the editor's media frame) takes: one MountedMedia per media layer.
export function showMediaMount(streams: ShowMediaStreams, options: ShowMediaOptions): ShowMediaMount {
	return {
		mount(box, layer, session, events) {
			const media = layer.media

			if (media === undefined) return new InertMedia()

			return new MountedMedia(box, layer, media, session, events, streams, options)
		},
		sound: (session, sound) => transitionSound(streams, session, sound)
	}
}

// A transition sound: an <audio> element off the page over the medium's stream (the same range path as a medium on a
// slide), let go when it ends (unless looped) or is stopped. One that cannot be streamed stays silent.
function transitionSound(
	streams: ShowMediaStreams,
	session: PresentationSessionApi,
	sound: { readonly part: string; readonly loop: boolean }
): ShowSoundHandle {
	let stopped = false
	let element: HTMLAudioElement | undefined
	let stream: { release(): void } | undefined
	const stop = (): void => {
		stopped = true

		if (element !== undefined) {
			element.pause()
			element.removeAttribute("src")
		}

		stream?.release()
		stream = undefined
		element = undefined
	}

	void streams.url(session, { kind: "audio", part: sound.part, contentType: "audio/wav" }).then(result => {
		if (result.kind !== "url") return
		if (stopped) {
			result.release()

			return
		}

		const audio = globalThis.document.createElement("audio")

		stream = result
		element = audio
		audio.loop = sound.loop
		audio.src = result.url
		audio.addEventListener("ended", stop, { once: true })
		void audio.play().catch(() => undefined)
	})

	return { stop }
}

import { useEffect, useEffectEvent, useState } from "react"
import type { DriveItem } from "@/features/drive/lib/item"
import { peekThumbnailUrl } from "@/features/drive/lib/thumbnails"
import { useDeviceProfile } from "@/lib/useDeviceProfile"
import { MENU_ESCAPE_MS } from "@/lib/media/menuEscape"
import { createScreenWakeLock, type ScreenWakeLock } from "@/lib/media/wakeLock"
import { enterViewerFullScreen, useViewerFullScreenHolder } from "@/features/preview/components/commandBar.logic"
import { useProvidedPreviewOrigin, type PreviewAccessMode } from "@/features/preview/lib/accessMode"
import { prefetchPreviewImage } from "@/features/preview/lib/previewPrefetch"
import type { SlideshowSlotValue } from "@/features/preview/lib/slideSignals"
import { useSlideshowPrefs } from "@/features/preview/lib/slideshowPrefs"
import {
	SHOW_TIMEOUT_MS,
	nextSlide,
	slideDue,
	slideKindOf,
	slideshowOrder,
	type SlideKind,
	type SlideshowOrder
} from "@/features/preview/lib/slideshow.logic"

// The slideshow over a host's pager: which slide is next, when the current one is due, and what holds it (a pause,
// a hidden tab, a slot that cannot be left). It pages through the host's own step, keeps the screen on, and runs in
// the page's full screen where there is one.

export interface SlideshowHost {
	items: readonly DriveItem[]
	index: number
	// The host's pager step (PreviewOverlay's onStep, the public pager's); the slideshow passes target - index.
	step: (delta: number) => void
	// False while the slot is dirty or saving (requestOrRun's conditions): the slideshow pauses instead of stepping.
	canLeave: () => boolean
	// Where prefetched stream ids are kept and how the file is read: usePreviewCacheScope(), usePreviewAccessMode().
	cacheScope: string | null
	access: PreviewAccessMode
}

export interface Slideshow {
	running: boolean
	paused: boolean
	// 1-based among slideable items, for "12/80".
	position: number
	total: number
	// Inside the click/key gesture: enters full screen there.
	start: () => void
	stop: () => void
	togglePause: () => void
	go: (delta: 1 | -1) => void
	setMenuOpen: (open: boolean) => void
	// What SlideshowSlot reads (pass it while running, null otherwise); a stable object per slide.
	slot: SlideshowSlotValue
}

// A running show: its list, its order and the order after the next step (computed once, so the image loaded ahead
// is the one that comes).
interface Show {
	readonly session: number
	readonly items: readonly DriveItem[]
	readonly shuffle: boolean
	readonly order: SlideshowOrder
	readonly upcoming: SlideshowOrder
	// The host index last looked up in the order, so an item that is no slide is looked up once, not every render.
	readonly looked: number
}

interface Slide {
	readonly key: string
	readonly kind: SlideKind | null
	readonly value: SlideshowSlotValue
	mountedAt: number | null
	shownAt: number | null
	animating: boolean
	mediaEnded: boolean
	// Shown without its report: the show paused on it, or it never showed in time (an error state is seen then).
	revealed: boolean
	readonly listeners: Set<() => void>
}

const IDLE_SLOT: SlideshowSlotValue = {
	shown: () => undefined,
	signals: null,
	placeholderUrl: null,
	visible: () => true,
	subscribe: () => () => undefined
}

// The timing side, outside React so a viewer's signal costs no render: a clock that runs only while the show runs
// unpaused in a visible tab, the current slide's record, one timer to its next due check, the wake lock, full
// screen's and the menu's state, and the one image loaded ahead.
class SlideClock {
	private latest: Slide | null = null
	private current: Slide | null = null
	private elapsed = 0
	private since: number | null = null
	private timer: ReturnType<typeof setTimeout> | undefined = undefined
	private running = false
	private paused = false
	private hidden = false
	private intervalMs = 0
	private lock: ScreenWakeLock | null = null
	private due: () => void = () => undefined
	private held: { uuid: string; dispose: (() => void) | null } | null = null
	private menuOpen = false
	private menuClosedAt = Number.NEGATIVE_INFINITY
	private sessions = 0
	// The session begun and not ended yet (0: none).
	private live = 0
	private preShown = -1
	public fullscreenEntered = false

	private now(): number {
		return this.elapsed + (this.since === null ? 0 : performance.now() - this.since)
	}

	private ticking(): boolean {
		return this.running && !this.paused && !this.hidden
	}

	private retime(change: () => void): void {
		const was = this.ticking()

		change()

		const is = this.ticking()

		if (was && !is) {
			this.elapsed = this.now()
			this.since = null
		} else if (!was && is) {
			this.since = performance.now()
		}

		this.lock?.set(this.running && !this.paused)
		this.schedule()
	}

	// A new session; `preShown`: its first slide is on screen already (the one it started on).
	public begin(preShown: boolean): number {
		this.sessions++
		this.live = this.sessions
		this.preShown = preShown ? this.sessions : -1
		this.fullscreenEntered = false

		return this.sessions
	}

	public end(): void {
		this.live = 0
		this.fullscreenEntered = false
	}

	public isSession(session: number): boolean {
		return this.live === session
	}

	// The slot of the slide `key` (session and file), the same object while the key is.
	public slot(key: string, session: number, kind: SlideKind | null, placeholderUrl: string | null): SlideshowSlotValue {
		// The current slide's record survives a discarded render that made another slide's.
		if (this.current?.key === key) {
			return this.current.value
		}

		if (this.latest?.key === key) {
			return this.latest.value
		}

		const shownAt = this.preShown === session ? this.now() : null

		this.preShown = -1

		// Signals land on this slide's record whenever they come (an animated player says so from its first effect,
		// before the slide is entered); only the current slide's record is ever read.
		const slide: Slide = {
			key,
			kind,
			mountedAt: null,
			shownAt,
			animating: false,
			mediaEnded: false,
			revealed: false,
			listeners: new Set(),
			value: {
				shown: () => {
					if (slide.shownAt === null) {
						slide.shownAt = this.now()
						notify(slide)
						this.changed(slide)
					}
				},
				signals:
					kind === null
						? null
						: {
								active: true,
								mediaEnded: () => {
									if (!slide.mediaEnded) {
										slide.mediaEnded = true
										this.changed(slide)
									}
								},
								animating: () => {
									if (!slide.animating) {
										slide.animating = true
										this.changed(slide)
									}
								}
							},
				placeholderUrl,
				visible: () => slide.shownAt !== null || slide.revealed,
				subscribe: listener => {
					slide.listeners.add(listener)

					return () => {
						slide.listeners.delete(listener)
					}
				}
			}
		}

		this.latest = slide

		return slide.value
	}

	// The slot on screen now (IDLE_SLOT outside a show).
	public enter(value: SlideshowSlotValue): void {
		const slide = this.latest?.value === value ? this.latest : this.current?.value === value ? this.current : null

		if (slide !== null && slide.mountedAt === null) {
			slide.mountedAt = this.now()
		}

		this.current = slide

		if (this.paused) {
			this.reveal()
		}

		this.schedule()
	}

	// The current slide shown though it has not reported so.
	private reveal(): void {
		const slide = this.current

		if (slide !== null && !slide.revealed) {
			slide.revealed = true
			notify(slide)
		}
	}

	private changed(slide: Slide): void {
		if (slide === this.current) {
			this.schedule()
		}
	}

	public setGate(running: boolean, paused: boolean, intervalMs: number): void {
		this.retime(() => {
			this.running = running
			this.paused = paused
			this.intervalMs = intervalMs

			if (!running) {
				this.end()
			}
		})

		if (running && paused) {
			this.reveal()
		}
	}

	public setMenuOpen(open: boolean): void {
		if (this.menuOpen && !open) {
			this.menuClosedAt = performance.now()
		}

		this.menuOpen = open
	}

	// Full screen was left: whether that ends the show (it entered it, and no menu took that Escape).
	public leftFullscreen(): boolean {
		if (!this.running || !this.fullscreenEntered) {
			return false
		}

		this.fullscreenEntered = false

		return !this.menuOpen && performance.now() - this.menuClosedAt >= MENU_ESCAPE_MS
	}

	public listen(onDue: () => void): () => void {
		this.due = onDue

		return () => {
			this.due = () => undefined
		}
	}

	// One timer to the slide's next due check; none while the clock stands or a signal is awaited. A slide found due
	// here is left on a task of its own (this runs inside the viewers' signals and the hook's effects).
	private schedule(): void {
		clearTimeout(this.timer)
		this.timer = undefined

		const at = this.nextCheck()

		if (at === null) {
			return
		}

		this.timer = setTimeout(
			() => {
				this.timer = undefined

				if (this.nextCheck() === 0) {
					// A slide that never showed is seen as it goes (and stays seen should the step not happen).
					if (this.current?.shownAt === null) {
						this.reveal()
					}

					this.due()
				} else {
					this.schedule()
				}
			},
			Math.max(0, at)
		)
	}

	// How long until the current slide is next checked: 0 when it is due, null for no check (the clock stands, or a
	// video's end or an animation's loop is awaited).
	private nextCheck(): number | null {
		const slide = this.current

		const mountedAt = slide === null ? null : slide.mountedAt

		if (slide === null || mountedAt === null || !this.ticking()) {
			return null
		}

		const now = this.now()
		const kind = slide.kind ?? "image"
		const due = slideDue({
			kind,
			animating: slide.animating,
			shownAt: slide.shownAt,
			mountedAt,
			mediaEnded: slide.mediaEnded,
			intervalMs: this.intervalMs,
			now
		})

		if (due) {
			return 0
		}

		const at = slide.shownAt === null ? mountedAt + SHOW_TIMEOUT_MS : kind === "video" ? null : slide.shownAt + this.intervalMs

		return at === null || at <= now ? null : at - now
	}

	// Keeps the image loaded ahead for `next` and drops any other. Its effect runs after the effects of the slot just
	// stepped to, so that slot's viewer already holds the stream the dropped one lets go of.
	public prefetch(next: DriveItem | null, load: (item: DriveItem) => (() => void) | null): void {
		if (this.held !== null && this.held.uuid !== next?.data.uuid) {
			this.held.dispose?.()
			this.held = null
		}

		if (this.held === null && next !== null) {
			this.held = { uuid: next.data.uuid, dispose: load(next) }
		}
	}

	public attach(): () => void {
		const lock = createScreenWakeLock({ needed: true })
		const onVisibility = (): void => {
			this.retime(() => {
				this.hidden = document.visibilityState === "hidden"
			})
		}

		this.lock = lock
		document.addEventListener("visibilitychange", onVisibility)
		onVisibility()

		return () => {
			document.removeEventListener("visibilitychange", onVisibility)
			clearTimeout(this.timer)
			this.timer = undefined
			this.held?.dispose?.()
			this.held = null
			this.lock = null
			lock.dispose()
		}
	}
}

function notify(slide: Slide): void {
	for (const listener of slide.listeners) {
		listener()
	}
}

function kindsOf(items: readonly DriveItem[]): (SlideKind | null)[] {
	return items.map(item => slideKindOf(item))
}

// The order for a changed list or shuffle setting, kept on the current item; a shuffled order keeps its sequence
// (removed items dropped, new ones after). Null once fewer than two slides remain.
function rebuild(show: Show, items: readonly DriveItem[], index: number, shuffle: boolean): Show | null {
	const kinds = kindsOf(items)
	let order: SlideshowOrder

	if (shuffle && show.shuffle) {
		const at = new Map<string, number>()

		for (let i = 0; i < items.length; i++) {
			const item = items[i]

			if (item !== undefined && kinds[i] !== null) {
				at.set(item.data.uuid, i)
			}
		}

		const kept: number[] = []
		let position = 0

		for (let p = 0; p < show.order.order.length; p++) {
			if (p === show.order.position) {
				position = kept.length
			}

			const uuid = show.items[show.order.order[p] ?? -1]?.data.uuid
			const next = uuid === undefined ? undefined : at.get(uuid)

			if (uuid !== undefined && next !== undefined) {
				kept.push(next)
				at.delete(uuid)
			}
		}

		// One by one: a spread of tens of thousands of arguments overflows the stack.
		for (const index of at.values()) {
			kept.push(index)
		}

		order = { order: kept, position: position < kept.length ? position : 0 }
	} else {
		order = slideshowOrder(kinds, index, shuffle)
	}

	if (order.order.length <= 1) {
		return null
	}

	return { ...show, items, shuffle, order, upcoming: nextSlide(order, 1, shuffle), looked: -1 }
}

export function useSlideshow(host: SlideshowHost): Slideshow {
	const prefs = useSlideshowPrefs()
	const profile = useDeviceProfile()
	const provided = useProvidedPreviewOrigin()
	const [clock] = useState(() => new SlideClock())
	const [show, setShow] = useState<Show | null>(null)
	const [paused, setPaused] = useState(false)
	let current = show

	if (current !== null && (current.items !== host.items || current.shuffle !== prefs.shuffle)) {
		current = rebuild(current, host.items, host.index, prefs.shuffle)
	}

	// Paged by the host itself (its arrows): the order follows when it landed on a slide. Looked up once per index.
	if (current !== null && current.order.order[current.order.position] !== host.index && current.looked !== host.index) {
		const position = current.order.order.indexOf(host.index)

		if (position === -1) {
			current = { ...current, looked: host.index }
		} else {
			const order = { order: current.order.order, position }

			current = { ...current, order, upcoming: nextSlide(order, 1, current.shuffle), looked: host.index }
		}
	}

	if (current !== show) {
		setShow(current)
	}

	const running = current !== null
	const item = running ? host.items[host.index] : undefined
	const slot =
		current === null || item === undefined
			? IDLE_SLOT
			: clock.slot(
					`${String(current.session)}:${item.data.uuid}`,
					current.session,
					slideKindOf(item),
					peekThumbnailUrl(item.data.uuid)
				)
	const nextIndex = current === null ? undefined : current.upcoming.order[current.upcoming.position]
	const next = nextIndex === undefined ? null : (host.items[nextIndex] ?? null)
	const loadAhead = next !== null && provided === null && slideKindOf(next) === "image" ? next : null
	const { cacheScope, access } = host

	useViewerFullScreenHolder(running)

	useEffect(() => clock.attach(), [clock])

	useEffect(() => {
		clock.setGate(running, paused, prefs.intervalSeconds * 1000)
	}, [clock, running, paused, prefs.intervalSeconds])

	useEffect(() => {
		clock.enter(slot)
	}, [clock, slot])

	useEffect(() => {
		clock.prefetch(loadAhead, ahead => prefetchPreviewImage(ahead, cacheScope, access, profile))
	}, [clock, loadAhead, cacheScope, access, profile])

	function step(delta: 1 | -1): void {
		if (current === null) {
			return
		}

		const order = delta === 1 ? current.upcoming : nextSlide(current.order, -1, current.shuffle)
		const to = order.order[order.position]

		if (to === undefined) {
			return
		}

		setShow({ ...current, order, upcoming: nextSlide(order, 1, current.shuffle) })
		host.step(to - host.index)
	}

	function stop(): void {
		clock.end()
		setShow(null)
		setPaused(false)
	}

	// Onto the order's slide when the host is elsewhere (a show started, or resumed, on an item that is no slide).
	// Never past a slot that cannot be left: that would ask to discard it.
	function land(show: Show): boolean {
		const to = show.order.order[show.order.position]

		if (to === undefined || to === host.index) {
			return true
		}

		if (!host.canLeave()) {
			return false
		}

		host.step(to - host.index)

		return true
	}

	const onDue = useEffectEvent(() => {
		if (!host.canLeave()) {
			setPaused(true)

			return
		}

		step(1)
	})

	useEffect(
		() =>
			clock.listen(() => {
				onDue()
			}),
		[clock]
	)

	const onFullscreenLeft = useEffectEvent(() => {
		stop()
	})

	// Escape in full screen is the browser's (Firefox and Safari never pass it on): leaving the full screen the show
	// entered ends it, unless the show's menu took that Escape.
	useEffect(() => {
		const onChange = (): void => {
			if (document.fullscreenElement === null && clock.leftFullscreen()) {
				onFullscreenLeft()
			}
		}

		document.addEventListener("fullscreenchange", onChange)

		return () => {
			document.removeEventListener("fullscreenchange", onChange)
		}
	}, [clock])

	return {
		running,
		paused: running && paused,
		position: current === null ? 0 : current.order.position + 1,
		total: current === null ? 0 : current.order.order.length,
		start: () => {
			if (current !== null) {
				return
			}

			const order = slideshowOrder(kindsOf(host.items), host.index, prefs.shuffle)
			const first = order.order[order.position]

			if (first === undefined || order.order.length <= 1) {
				return
			}

			const session = clock.begin(first === host.index)
			const wasFullscreen = document.fullscreenElement === document.documentElement

			const started: Show = {
				session,
				items: host.items,
				shuffle: prefs.shuffle,
				order,
				upcoming: nextSlide(order, 1, prefs.shuffle),
				looked: -1
			}

			setShow(started)
			// Started on an unsaved slot that is no slide: paused there until the user resumes.
			setPaused(!land(started))

			void enterViewerFullScreen().then(entered => {
				if (entered && !wasFullscreen && clock.isSession(session)) {
					clock.fullscreenEntered = true
				}
			})
		},
		stop,
		togglePause: () => {
			if (paused && current !== null && !land(current)) {
				return
			}

			setPaused(!paused)
		},
		// The user's own step, never past a slot that cannot be left (that would ask to discard it): paused there.
		go: delta => {
			if (current !== null && !host.canLeave()) {
				setPaused(true)

				return
			}

			step(delta)
		},
		setMenuOpen: open => {
			clock.setMenuOpen(open)
		},
		slot
	}
}

import { useEffect, useEffectEvent, useRef, useState } from "react"
import { toast } from "sonner"
import type { Slideshow } from "@/features/preview/hooks/useSlideshow"
import type { PreviewOverlayAction } from "@/features/preview/lib/keymap"
import { setSlideshowPrefs, useSlideshowPrefs } from "@/features/preview/lib/slideshowPrefs"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { log } from "@/lib/log"
import { useLatestRef } from "@/lib/useLatestRef"

// A slideshow's start, its keys and its "include subdirectories" over a host's pager (the preview overlay, a directory
// link's file page): the tree `source` lists swapped in for the host's list, which is held meanwhile, and that list
// back when the switch goes off or the show ends, by whatever path. The stored preference stays.

// The file on screen, and whether unsaved edits or a save keep the pager on it.
export interface ShownSlot {
	shown: string | undefined
	locked: boolean
}

export interface SlideshowSubfoldersHost<S, L, T> {
	slideshow: Slideshow
	// ▶ is offered over the list.
	offered: boolean
	// The one directory whose subdirectories may be included (and the host can swap its list); none hides the switch.
	source: S | undefined
	// The pager's list now: held as the opening list while a tree stands in for it.
	list: L
	shown: ShownSlot
	load: (source: S, signal: AbortSignal) => Promise<T>
	// The list a tree swaps in; null below two slides, which would end the slideshow (the list stays).
	listOf: (tree: T) => L | null
	// Swaps the pager's list, on `on.shown`'s file when `next` has it, else on `fallbackUuid`'s, else on its first; never
	// off a locked slot. False when the held list stays.
	replace: (next: L, on: ShownSlot, fallbackUuid: string | undefined) => boolean
	logScope: string
	// A start or an end, by whatever path, once the list is back.
	onRunningChange: (running: boolean) => void
}

export interface SlideshowSubfolders<L, T> {
	available: boolean
	loading: boolean
	// The opening list and the tree standing in for it.
	swapped: { opening: L; tree: T } | null
	// The opening list kept current (files removed meanwhile).
	updateOpening: (update: (held: L) => L) => void
	// Inside the click or key gesture (full screen is entered there).
	start: () => void
	setSubfolders: (on: boolean) => void
	// S starts it, Space pauses it while it runs: true for those two actions, which are no one else's then.
	runKey: (action: PreviewOverlayAction | undefined, event: { repeat: boolean; preventDefault: () => void }) => boolean
}

export function useSlideshowSubfolders<S, L, T>(host: SlideshowSubfoldersHost<S, L, T>): SlideshowSubfolders<L, T> {
	const prefs = useSlideshowPrefs()
	const [swapped, setSwapped] = useState<{ opening: L; tree: T } | null>(null)
	const [loading, setLoading] = useState(false)
	const abortRef = useRef<AbortController | null>(null)
	// The file on screen when the slideshow started, and whether it runs as of the last commit.
	const startedFromRef = useRef<string | undefined>(undefined)
	const wasRunningRef = useRef(false)
	// As of the last commit, for a tree that lands after the show moved on.
	const hostRef = useLatestRef(host)
	const { slideshow, source } = host

	useEffect(
		() => () => {
			abortRef.current?.abort()
		},
		[]
	)

	function load(): void {
		if (source === undefined || swapped !== null || abortRef.current !== null) {
			return
		}

		const controller = new AbortController()
		const opening = host.list

		abortRef.current = controller
		setLoading(true)

		void host.load(source, controller.signal).then(
			tree => {
				if (controller.signal.aborted) {
					return
				}

				abortRef.current = null
				setLoading(false)

				const latest = hostRef.current
				const next = latest.listOf(tree)

				if (next !== null && latest.replace(next, latest.shown, undefined)) {
					setSwapped({ opening, tree })
				}
			},
			(error: unknown) => {
				if (controller.signal.aborted) {
					return
				}

				abortRef.current = null
				setLoading(false)
				log.warn(hostRef.current.logScope, "the slideshow's subdirectories could not be listed", error)
				toast.error(errorLabel(error))
			}
		)
	}

	// Back to the opening list (at `fallbackUuid`'s file when the one on screen is not in it).
	function drop(fallbackUuid?: string): void {
		abortRef.current?.abort()
		abortRef.current = null
		setLoading(false)

		if (swapped !== null && host.replace(swapped.opening, host.shown, fallbackUuid)) {
			setSwapped(null)
		}
	}

	function start(): void {
		if (!host.offered || slideshow.running) {
			return
		}

		startedFromRef.current = host.shown.shown
		slideshow.start()

		if (prefs.subfolders) {
			load()
		}
	}

	const onRunningChange = useEffectEvent((running: boolean) => {
		// The subdirectories' list is the slideshow's alone: a load under way never lands.
		if (!running) {
			drop(startedFromRef.current)
		}

		host.onRunningChange(running)
	})

	useEffect(() => {
		if (wasRunningRef.current === slideshow.running) {
			return
		}

		wasRunningRef.current = slideshow.running
		onRunningChange(slideshow.running)
	}, [slideshow.running])

	return {
		available: source !== undefined,
		loading,
		swapped,
		updateOpening: update => {
			setSwapped(held => (held === null ? held : { opening: update(held.opening), tree: held.tree }))
		},
		start,
		setSubfolders: on => {
			setSlideshowPrefs({ subfolders: on })

			if (on) {
				load()
			} else {
				drop()
			}
		},
		runKey: (action, event) => {
			if (action !== "preview.slideshow" && action !== "preview.slideshowPause") {
				return false
			}

			if (action === "preview.slideshow" ? !host.offered || slideshow.running : !slideshow.running) {
				return true
			}

			event.preventDefault()

			if (!event.repeat) {
				if (action === "preview.slideshow") {
					start()
				} else {
					slideshow.togglePause()
				}
			}

			return true
		}
	}
}

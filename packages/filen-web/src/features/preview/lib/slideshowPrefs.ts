import { useSyncExternalStore } from "react"
import { type } from "arktype"
import { preloadedPreference } from "@/lib/storage/preloadedPreference"
import { DEFAULT_SLIDESHOW_INTERVAL, SLIDESHOW_INTERVALS } from "@/features/preview/lib/slideshow.logic"

// The slideshow's interval, shuffle and include-subfolders, kept on this device and read during boot
// (lib/sdk/boot.ts): the next slideshow starts the way the last one was set up.

export interface SlideshowPrefs {
	intervalSeconds: (typeof SLIDESHOW_INTERVALS)[number]
	shuffle: boolean
	subfolders: boolean
}

const INTERVALS = new Set<number>(SLIDESHOW_INTERVALS)

function isInterval(seconds: number): seconds is SlideshowPrefs["intervalSeconds"] {
	return INTERVALS.has(seconds)
}

const interval = preloadedPreference<SlideshowPrefs["intervalSeconds"]>({
	key: "preview.slideshow.interval.v1",
	schema: type("number").narrow(isInterval),
	fallback: DEFAULT_SLIDESHOW_INTERVAL,
	scope: "preview",
	same: (a, b) => a === b
})

const shuffle = preloadedPreference({
	key: "preview.slideshow.shuffle.v1",
	schema: type("boolean"),
	fallback: false,
	scope: "preview",
	same: (a, b) => a === b
})

const subfolders = preloadedPreference({
	key: "preview.slideshow.subfolders.v1",
	schema: type("boolean"),
	fallback: false,
	scope: "preview",
	same: (a, b) => a === b
})

let snapshot: SlideshowPrefs = { intervalSeconds: interval.get(), shuffle: shuffle.get(), subfolders: subfolders.get() }

// The same object until a value changes, as useSyncExternalStore needs.
export function slideshowPrefs(): SlideshowPrefs {
	const intervalSeconds = interval.get()
	const shuffled = shuffle.get()
	const withSubfolders = subfolders.get()

	if (snapshot.intervalSeconds !== intervalSeconds || snapshot.shuffle !== shuffled || snapshot.subfolders !== withSubfolders) {
		snapshot = { intervalSeconds, shuffle: shuffled, subfolders: withSubfolders }
	}

	return snapshot
}

function subscribe(listener: () => void): () => void {
	const unsubscribes = [interval.subscribe(listener), shuffle.subscribe(listener), subfolders.subscribe(listener)]

	return () => {
		for (const unsubscribe of unsubscribes) {
			unsubscribe()
		}
	}
}

export async function loadSlideshowPrefs(): Promise<void> {
	await Promise.all([interval.load(), shuffle.load(), subfolders.load()])
}

export function useSlideshowPrefs(): SlideshowPrefs {
	return useSyncExternalStore(subscribe, slideshowPrefs, slideshowPrefs)
}

export function setSlideshowPrefs(patch: Partial<SlideshowPrefs>): void {
	if (patch.intervalSeconds !== undefined && isInterval(patch.intervalSeconds)) interval.set(patch.intervalSeconds)

	if (patch.shuffle !== undefined) shuffle.set(patch.shuffle)

	if (patch.subfolders !== undefined) subfolders.set(patch.subfolders)
}

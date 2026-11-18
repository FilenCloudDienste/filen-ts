import { useSyncExternalStore } from "react"
import { type } from "arktype"
import { preloadedPreference } from "@/lib/storage/preloadedPreference"
import type { ComicDirection, ComicLayout } from "@/features/comics/lib/pages.logic"

// The comic reader's layout and reading direction, kept on this device and read during boot (lib/sdk/boot.ts): the
// next comic opens as the last one was read.

const layout = preloadedPreference<ComicLayout>({
	key: "comics.layout",
	schema: type("'single' | 'spread'"),
	fallback: "single",
	scope: "comics",
	same: (a, b) => a === b
})

const direction = preloadedPreference<ComicDirection>({
	key: "comics.direction",
	schema: type("'ltr' | 'rtl'"),
	fallback: "ltr",
	scope: "comics",
	same: (a, b) => a === b
})

export function loadComicPreferences(): Promise<void> {
	return Promise.all([layout.load(), direction.load()]).then(() => undefined)
}

export function useComicLayout(): ComicLayout {
	return useSyncExternalStore(layout.subscribe, layout.get, layout.get)
}

export function useComicDirection(): ComicDirection {
	return useSyncExternalStore(direction.subscribe, direction.get, direction.get)
}

export const setComicLayout = layout.set
export const setComicDirection = direction.set

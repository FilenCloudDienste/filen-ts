import { useSyncExternalStore } from "react"
import { type } from "arktype"
import { preloadedPreference, type PreloadedPreference } from "@/lib/storage/preloadedPreference"

// Whether a video player plays its video again when it ends, kept on this device per player and read during boot
// (lib/sdk/boot.ts). The preview's player loops unless turned off; the Videos player moves on unless turned on.

export type VideoRepeatPlayer = "preview" | "videos"

function repeatPreference(player: VideoRepeatPlayer, fallback: boolean): PreloadedPreference<boolean> {
	return preloadedPreference({
		key: `media.repeat.${player}.v1`,
		schema: type("boolean"),
		fallback,
		scope: "media",
		same: (a, b) => a === b
	})
}

const PREFERENCES: Readonly<Record<VideoRepeatPlayer, PreloadedPreference<boolean>>> = {
	preview: repeatPreference("preview", true),
	videos: repeatPreference("videos", false)
}

export async function loadVideoRepeat(): Promise<void> {
	await Promise.all([PREFERENCES.preview.load(), PREFERENCES.videos.load()])
}

export function videoRepeat(player: VideoRepeatPlayer): boolean {
	return PREFERENCES[player].get()
}

export function useVideoRepeat(player: VideoRepeatPlayer): boolean {
	const preference = PREFERENCES[player]

	return useSyncExternalStore(preference.subscribe, preference.get, preference.get)
}

export function toggleVideoRepeat(player: VideoRepeatPlayer): void {
	const preference = PREFERENCES[player]

	preference.set(!preference.get())
}

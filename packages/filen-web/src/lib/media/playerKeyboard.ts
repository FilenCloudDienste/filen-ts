import type { KeyboardEvent } from "react"
import { fullscreenSupported, toggleFullscreen } from "@/lib/media/fullscreen"
import { playerKeyAction, playerKeyTarget } from "@/lib/media/playerKeys.logic"
import { stepMediaVolume, toggleMediaMuted } from "@/lib/media/mediaVolume"
import { seekMedia, toggleMediaPlayback } from "@/lib/media/useMediaState"

// A player's keydown handler. Returns whether the key was the player's. A handled key stops here: past
// the player, the preview overlay would page on the same arrow and a single-letter app shortcut would fire.
// `fullscreenTarget` is the container F fullscreens; null until it has mounted.
export function handlePlayerKeyDown(event: KeyboardEvent, media: HTMLMediaElement | null, fullscreenTarget: HTMLElement | null): boolean {
	if (media === null || event.defaultPrevented) {
		return false
	}

	const action = playerKeyAction({
		key: event.key,
		target: playerKeyTarget(event.target),
		modified: event.ctrlKey || event.metaKey || event.altKey,
		fullscreen: fullscreenTarget !== null && fullscreenSupported()
	})

	if (action === null) {
		return false
	}

	event.preventDefault()
	event.stopPropagation()

	switch (action.type) {
		case "togglePlay":
			toggleMediaPlayback(media)
			break
		case "seekBy":
			seekMedia(media, media.currentTime + action.seconds)
			break
		case "volumeBy":
			stepMediaVolume(action.delta)
			break
		case "toggleMute":
			toggleMediaMuted()
			break
		case "toggleFullscreen":
			if (fullscreenTarget !== null) {
				void toggleFullscreen(fullscreenTarget).catch(() => undefined)
			}

			break
	}

	return true
}

import { useSyncExternalStore } from "react"

// Whether the window is a phone's: the ribbon's groups then skip collapsing and go straight to its overflow menu,
// icon only, and a command bar keeps only its essentials. And whether the main pointer is coarse (a finger): small
// controls then grow to a touch target.
const PHONE_QUERY = "(max-width: 39.99rem)"
const COARSE_QUERY = "(pointer: coarse)"
// Tailwind's md: where side rails beside a document show.
const MEDIUM_QUERY = "(min-width: 48rem)"

interface MediaSource {
	readonly subscribe: (change: () => void) => () => void
	readonly matches: () => boolean
}

// A media query's subscription and match; none where there is no matchMedia (reads as not matching).
function mediaSource(source: string): MediaSource {
	const media = (): MediaQueryList | null => (typeof window.matchMedia === "function" ? window.matchMedia(source) : null)

	return {
		subscribe: change => {
			const query = media()

			query?.addEventListener("change", change)

			return () => {
				query?.removeEventListener("change", change)
			}
		},
		matches: () => media()?.matches === true
	}
}

const PHONE = mediaSource(PHONE_QUERY)
const COARSE = mediaSource(COARSE_QUERY)
const MEDIUM = mediaSource(MEDIUM_QUERY)

export function usePhoneWidth(): boolean {
	return useSyncExternalStore(PHONE.subscribe, PHONE.matches)
}

export function useCoarsePointer(): boolean {
	return useSyncExternalStore(COARSE.subscribe, COARSE.matches)
}

export function useMediumWidth(): boolean {
	return useSyncExternalStore(MEDIUM.subscribe, MEDIUM.matches)
}

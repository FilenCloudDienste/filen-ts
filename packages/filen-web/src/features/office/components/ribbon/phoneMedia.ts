import { useSyncExternalStore } from "react"

// Whether the window is a phone's: the ribbon's groups then skip collapsing and go straight to its overflow menu,
// icon only, and a command bar keeps only its essentials.
const PHONE_QUERY = "(max-width: 39.99rem)"

// None where there is no matchMedia: reads as wide.
function phoneMedia(): MediaQueryList | null {
	return typeof window.matchMedia === "function" ? window.matchMedia(PHONE_QUERY) : null
}

function subscribePhone(change: () => void): () => void {
	const query = phoneMedia()

	query?.addEventListener("change", change)

	return () => {
		query?.removeEventListener("change", change)
	}
}

function phoneWidth(): boolean {
	return phoneMedia()?.matches === true
}

export function usePhoneWidth(): boolean {
	return useSyncExternalStore(subscribePhone, phoneWidth)
}

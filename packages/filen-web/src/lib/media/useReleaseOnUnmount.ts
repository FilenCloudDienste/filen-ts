import { useEffect } from "react"

// Stops what an <img>, <video> or <audio> is still fetching once its component unmounts. Taking an
// element out of the page does not: a detached image finishes its load, and a detached media element
// keeps buffering, both read through the service worker's stream and so through the SDK's download.
// Dropping the source aborts the request; load() then empties a media element.
//
// Runs only for an element actually gone from the page, so StrictMode's rehearsal unmount, which leaves
// the DOM in place, keeps its source.
export function useReleaseOnUnmount(element: HTMLImageElement | HTMLMediaElement | null): void {
	useEffect(() => {
		if (element === null) {
			return
		}

		return () => {
			if (element.isConnected) {
				return
			}

			element.removeAttribute("src")

			if (element instanceof HTMLMediaElement) {
				element.load()
			}
		}
	}, [element])
}

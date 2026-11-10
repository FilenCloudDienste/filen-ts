import { ignoredUnderOverlays } from "@/lib/keymap/useAction"

// The bar's transport keys stand down under a dialog or menu, and while a video player holds the page's Media
// Session: the engine is paused under it, and a resumed track would play under the video.
export function transportKeyIgnored(event: Parameters<typeof ignoredUnderOverlays>[0], session: { readonly active: boolean }): boolean {
	return ignoredUnderOverlays(event) || !session.active
}

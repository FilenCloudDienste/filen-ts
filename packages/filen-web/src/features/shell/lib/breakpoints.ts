// The app's one LAYOUT breakpoint, expressed for `window.matchMedia`. The width is Tailwind's own
// `md` token (`--breakpoint-md: 48rem`) rather than a number of this app's own: every `md:` utility in
// the codebase and this query must flip at the same instant, or the shell would hide a sidebar the row
// still reserves space for. Never define a second scale here — density steps below `md` stay pure CSS
// (`sm:`/`md:`/`lg:` utilities), and only the sidebar's inline-vs-drawer mount needs a JS answer at all
// (one mount only — see appShell.tsx).
export const LAYOUT_BREAKPOINT_QUERY = "(min-width: 48rem)"

// A media query read as an external store: one MediaQueryList per query, created lazily rather than at module scope,
// so importing a module that builds one stays side-effect-free where there is no `window` (vitest's node environment),
// matching how themeProvider only touches matchMedia inside a function. Also the chat info panel's own inline width
// (features/chats/lib/chatInfoLayout.ts), a panel-specific threshold rather than a second layout scale.
export function mediaQueryStore(query: string): { matches: () => boolean; subscribe: (listener: () => void) => () => void } {
	let mediaQuery: MediaQueryList | null = null

	function getMediaQuery(): MediaQueryList {
		mediaQuery ??= window.matchMedia(query)

		return mediaQuery
	}

	return {
		matches: () => getMediaQuery().matches,
		subscribe: listener => {
			const list = getMediaQuery()

			list.addEventListener("change", listener)

			return () => {
				list.removeEventListener("change", listener)
			}
		}
	}
}

const layoutBreakpoint = mediaQueryStore(LAYOUT_BREAKPOINT_QUERY)

// True below the layout breakpoint, where the shell hosts the contextual sidebar in a drawer instead of
// the row.
export function isNarrowViewport(): boolean {
	return !layoutBreakpoint.matches()
}

// External-store subscription shape, consumed both by useIsNarrowViewport (to read the value) and by
// the shell (to react to the crossing itself). Returns its own unsubscribe.
export function subscribeToLayoutBreakpoint(listener: () => void): () => void {
	return layoutBreakpoint.subscribe(listener)
}

// The app's one LAYOUT breakpoint, expressed for `window.matchMedia`. The width is Tailwind's own
// `md` token (`--breakpoint-md: 48rem`) rather than a number of this app's own: every `md:` utility in
// the codebase and this query must flip at the same instant, or the shell would hide a sidebar the row
// still reserves space for. Never define a second scale here — density steps below `md` stay pure CSS
// (`sm:`/`md:`/`lg:` utilities), and only the sidebar's inline-vs-drawer mount needs a JS answer at all
// (one mount only — see appShell.tsx).
export const LAYOUT_BREAKPOINT_QUERY = "(min-width: 48rem)"

// One MediaQueryList for the whole app, created lazily rather than at module scope: importing this
// module stays side-effect-free where there is no `window` (vitest's node environment), matching how
// themeProvider only touches matchMedia inside a function.
let mediaQuery: MediaQueryList | null = null

function getMediaQuery(): MediaQueryList {
	mediaQuery ??= window.matchMedia(LAYOUT_BREAKPOINT_QUERY)

	return mediaQuery
}

// True below the layout breakpoint, where the shell hosts the contextual sidebar in a drawer instead of
// the row.
export function isNarrowViewport(): boolean {
	return !getMediaQuery().matches
}

// External-store subscription shape, consumed both by useIsNarrowViewport (to read the value) and by
// the shell (to react to the crossing itself). Returns its own unsubscribe.
export function subscribeToLayoutBreakpoint(listener: () => void): () => void {
	const query = getMediaQuery()

	query.addEventListener("change", listener)

	return () => {
		query.removeEventListener("change", listener)
	}
}

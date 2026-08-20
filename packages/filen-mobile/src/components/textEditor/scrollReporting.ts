/**
 * How far the document must scroll before the editor reports itself as scrolled.
 *
 * Small on purpose: the drive preview lays its content out to pass UNDER a transparent header, so
 * the scrim it drives is needed the moment the first line slides beneath the title — not once the
 * document is comfortably scrolled. Large enough, though, that iOS rubber-band settle at the top
 * cannot toggle it.
 */
export const SCROLLED_THRESHOLD_PX = 8

/**
 * Whether a scroller counts as scrolled.
 *
 * Pure so the boundary — including overscroll, where iOS reports a NEGATIVE scrollTop while the
 * document is still resting at the top — is testable without a WebView.
 */
export function isScrolled(scrollTop: number): boolean {
	return scrollTop > SCROLLED_THRESHOLD_PX
}

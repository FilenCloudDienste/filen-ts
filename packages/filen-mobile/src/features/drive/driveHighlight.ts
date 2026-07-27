// Timing for the transient tint on the row that "open containing directory" reveals. Split across
// two consumers — highlightOverlay plays the animation, useDriveHighlight keeps the row flagged
// while it runs — so the numbers live here rather than in either of them.
//
// The two clocks start at different moments: the overlay's when the target row MOUNTS, the flag's
// when the reveal scroll SETTLES. The overlay can only mount at or before the scroll settles (it
// is what brings the row on screen), so the fade always finishes at or before the flag clears —
// leaving at most a stretch of fully-faded, invisible overlay. Timing the flag from anywhere
// earlier would cut the fade off mid-way instead.

/** Hold the tint at full strength while the scroll settles. */
export const HIGHLIGHT_HOLD_MS = 700

/** Then fade it out over this long. */
export const HIGHLIGHT_FADE_MS = 900

/** Peak tint opacity — low enough to read as a row background rather than a mask over the row. */
export const HIGHLIGHT_TINT_OPACITY = 0.22

/** How long the row stays flagged, measured from the moment the reveal scroll settles. */
export const HIGHLIGHT_VISIBLE_MS = HIGHLIGHT_HOLD_MS + HIGHLIGHT_FADE_MS

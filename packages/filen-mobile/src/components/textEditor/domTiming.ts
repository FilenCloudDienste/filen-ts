// Platform-free so both "use dom" editors can import it without pulling react-native into their bundles.

// How long after a flush request (and its optional composition-committing blur) the document
// is re-read for the divergence check — long enough for the keyboard's finalized text to land
// through the normal DOM event path, short enough to fit inside a screen-pop animation.
export const FLUSH_COMPOSITION_COMMIT_MS = 80

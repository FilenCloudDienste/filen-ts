// Union of every scratch-name prefix the e2e suite has ever minted at drive root, current and retired.
// A spec run that dies mid-flight never reaches its own finally-teardown, so debris from a prefix no
// spec writes anymore can still be sitting in the shared live account — the union only ever grows, it
// never shrinks just because a spec stopped using a prefix. Anchored at the start: unanchored would risk
// matching a real user item that merely CONTAINS one of these substrings.
const SCRATCH_DEBRIS_PATTERN = /^(e2e-|debug-|_debug|zz-|_tmp|tmp-|d4-|dlagt5-|diagt5-|drive-marquee-|review-)/

// Pure predicate, kept separate from any Playwright/DOM code so it gets its own unit tests (src/tests) —
// this guards a destructive sweep against the shared LIVE account's root, so a false positive here means
// trashing real content.
export function isScratchDebrisName(name: string): boolean {
	return SCRATCH_DEBRIS_PATTERN.test(name)
}

// Notes-side debris (cleanup.setup.ts's second sweep): note TITLES and tag NAMES the notes specs mint.
// Same union-only-grows rule as the drive pattern above — and a tighter deadline: the FREE e2e account's
// note cap is a hard 10 (server-enforced `note_limit_reached`), so leaked notes starve later runs
// outright rather than merely churning sort order. Every spec-minted title starts "e2e " (spaced) or
// "e2e-" (dashed); both prefixes stay anchored via startsWith so a real note merely CONTAINING "e2e"
// never matches.
export const NOTE_DEBRIS_TITLE_PREFIXES: readonly string[] = ["e2e ", "e2e-"]
export const TAG_DEBRIS_NAME_PREFIXES: readonly string[] = ["e2e-tag-"]

export function isNoteDebrisTitle(title: string): boolean {
	return NOTE_DEBRIS_TITLE_PREFIXES.some(prefix => title.startsWith(prefix))
}

export function isTagDebrisName(name: string): boolean {
	return TAG_DEBRIS_NAME_PREFIXES.some(prefix => name.startsWith(prefix))
}

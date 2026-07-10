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

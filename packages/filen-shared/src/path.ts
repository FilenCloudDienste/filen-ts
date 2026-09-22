// The containing directory's path, or null for a top-level entry with no ancestor —
// "a/b/c.txt" -> "a/b", "a.txt" -> null. No leading-slash assumption.
export function dirnameOf(path: string): string | null {
	const index = path.lastIndexOf("/")

	return index === -1 ? null : path.slice(0, index)
}

// Segment depth without the per-call array allocation of path.split("/").length —
// byte-identical output for every input, convention-agnostic (just counts "/").
export function pathSegmentDepth(path: string): number {
	let segments = 1

	for (let i = 0; i < path.length; i++) {
		if (path.charCodeAt(i) === 47) {
			segments++
		}
	}

	return segments
}

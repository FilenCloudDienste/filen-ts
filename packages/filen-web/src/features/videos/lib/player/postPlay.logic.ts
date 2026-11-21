import { compareIds } from "@filen/shared"
import type { VideoTitleView } from "@/workers/videoIndex/view.logic"

// Post-play after a movie: the next unwatched movie from the same library directory, in natural name order after the
// one that ended (wrapping around), from the library's catalog in the SDK worker. The index keeps no parent directory
// per title, so a library directory stands for "the same directory".

const NATURAL = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" })

// The order post-play walks: natural name order, then id.
export function naturalTitleOrder(a: VideoTitleView, b: VideoTitleView): number {
	return NATURAL.compare(a.sortName, b.sortName) || compareIds(a.id, b.id)
}

// `ordered`: `titles` are in naturalTitleOrder already, so nothing is sorted here.
export function nextMovieInDirectory(params: {
	titles: readonly VideoTitleView[]
	currentId: string
	played: (title: VideoTitleView) => boolean
	ordered?: boolean
}): VideoTitleView | null {
	const current = params.titles.find(title => title.id === params.currentId)

	if (current === undefined) {
		return null
	}

	const roots = new Set(current.roots)
	const candidates = params.titles.filter(
		title =>
			title.kind === "movie" &&
			!title.unsupported &&
			!title.disc &&
			title.primary !== null &&
			(title.id === current.id || title.roots.some(root => roots.has(root)))
	)
	const order = params.ordered === true ? candidates : candidates.sort(naturalTitleOrder)
	const at = order.findIndex(title => title.id === current.id)

	for (let step = 1; step < order.length; step++) {
		const candidate = order[(at + step) % order.length]

		if (candidate !== undefined && candidate.id !== current.id && !params.played(candidate)) {
			return candidate
		}
	}

	return null
}

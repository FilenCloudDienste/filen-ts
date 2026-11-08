// The part of the pages a scroll container shows, read from it. The pages are centred in its width, which a
// scrollbar coming or going with the content's size changes: read again in the commit that changes that
// size (a layout effect), so pages are never painted where the previous width put them.

export interface PagesViewport {
	readonly top: number
	readonly height: number
	readonly width: number
}

// A state update to `container`'s viewport, keeping the previous object where nothing changed.
export function readViewport(container: HTMLElement): (previous: PagesViewport) => PagesViewport {
	return previous =>
		previous.top === container.scrollTop && previous.height === container.clientHeight && previous.width === container.clientWidth
			? previous
			: { top: container.scrollTop, height: container.clientHeight, width: container.clientWidth }
}

// Pages stacked top to bottom, in px on screen.
export interface PageStack {
	readonly tops: Float64Array
	readonly heights: Float64Array
}

// The first page whose bottom is below `y`.
export function pageAt(stack: PageStack, y: number): number {
	let low = 0
	let high = stack.tops.length - 1

	while (low < high) {
		const middle = (low + high) >> 1

		if ((stack.tops[middle] ?? 0) + (stack.heights[middle] ?? 0) < y) low = middle + 1
		else high = middle
	}

	return low
}

// The scroll position that keeps the spot of the page at the view's top there when the pages are stacked
// anew (another zoom): the same page, the same fraction down it.
export function anchoredScrollTop(previous: PageStack, next: PageStack, scrollTop: number): number {
	if (previous.tops.length === 0 || next.tops.length === 0) return scrollTop

	const page = Math.min(pageAt(previous, scrollTop), next.tops.length - 1)
	const height = previous.heights[page] ?? 0
	const fraction = height > 0 ? (scrollTop - (previous.tops[page] ?? 0)) / height : 0

	return Math.max(0, (next.tops[page] ?? 0) + fraction * (next.heights[page] ?? 0))
}

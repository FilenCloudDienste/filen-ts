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

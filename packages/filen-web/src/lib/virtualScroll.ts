import { observeElementOffset, type Virtualizer } from "@tanstack/react-virtual"

// The installed virtual-core learns the scroll offset only from scroll events, and keeps the last one
// across a change of scroll element. A list whose container remounts (a loading or empty state in
// between) then lays out the rows for the old container's offset in a fresh one scrolled to the top: the
// rows above are never rendered, blank space until the next scroll. Reporting the element's own offset as
// it attaches keeps the two in step; scroll events take over from there. For vertical lists.
export function observeElementOffsetFromAttach<TScrollElement extends Element, TItemElement extends Element>(
	instance: Virtualizer<TScrollElement, TItemElement>,
	callback: (offset: number, isScrolling: boolean) => void
): (() => void) | undefined {
	if (instance.scrollElement !== null) {
		callback(instance.scrollElement.scrollTop, false)
	}

	return observeElementOffset(instance, callback)
}

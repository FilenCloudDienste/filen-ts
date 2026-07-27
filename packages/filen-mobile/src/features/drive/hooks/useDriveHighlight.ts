import { useEffect, useState } from "react"
import { useLocalSearchParams } from "expo-router"
import type { DriveItem } from "@/types"
import type { ListRef } from "@/components/ui/virtualList"
import { HIGHLIGHT_VISIBLE_MS } from "@/features/drive/driveHighlight"

/**
 * Consumes the `highlight` route param that "open containing directory" attaches to its
 * `/tabs/drive/[uuid]` push: scrolls the freshly-opened listing to the revealed item and returns
 * its uuid for as long as the row should stay tinted (null the rest of the time).
 *
 * One-shot per param value, latched in state rather than by rewriting the route params. The
 * listing arrives asynchronously, so the latch re-evaluates as `items` fills in and fires on the
 * first render that actually contains the item; the latch is what stops it firing again on every
 * later refetch, and on returning to this screen from a deeper push (the screen — and with it the
 * latch — stays mounted, while its params never change).
 *
 * `ready` gates the latch on the list being mounted in its FINAL form. Grid mode is resolved from
 * a measured width, so the first render always produces the list-mode VirtualList and the grid one
 * only replaces it once layout lands — scrolling the instance that is about to be thrown away
 * loses the scroll silently, with nothing left to retry it.
 *
 * `settled` is the give-up signal: while the listing is still loading, a miss means "not here
 * YET" and the next render retries. Once it has settled a miss is final — the item was moved or
 * removed since the search hit produced it — and the latch closes so the lookup stops repeating.
 * The navigation itself has still done its job; only the reveal is best-effort.
 */
export function useDriveHighlight({
	items,
	listRef,
	ready,
	settled
}: {
	items: DriveItem[]
	listRef: React.RefObject<ListRef<DriveItem> | null>
	ready: boolean
	settled: boolean
}): string | null {
	const { highlight } = useLocalSearchParams<{ highlight?: string }>()
	const [revealedUuid, setRevealedUuid] = useState<string | null>(null)
	const [consumedTarget, setConsumedTarget] = useState<string | null>(null)

	const target = typeof highlight === "string" && highlight.length > 0 ? highlight : null

	// Render-phase latch (React's documented "adjust state while rendering" pattern, as used by
	// useDriveSearch) — an effect here would be a synchronous setState inside an effect body,
	// which the cascading-render lint rejects. The scroll itself stays in the effect below; only
	// the decision is made during render.
	if (ready && target && consumedTarget !== target) {
		if (items.some(item => item.data.uuid === target)) {
			setConsumedTarget(target)
			setRevealedUuid(target)
		} else if (settled) {
			setConsumedTarget(target)
		}
	}

	// Re-derived every render rather than captured once at latch time: the listing keeps re-sorting
	// underneath the animated scroll — a size sort rebuilds its order as each directory-size query
	// lands — and a frozen index would settle the list on whichever row had moved into that slot,
	// leaving the tinted one somewhere else entirely.
	const revealedIndex = revealedUuid === null ? -1 : items.findIndex(item => item.data.uuid === revealedUuid)

	useEffect(() => {
		if (revealedUuid === null || revealedIndex < 0) {
			return
		}

		let cancelled = false
		let timeout: ReturnType<typeof setTimeout> | undefined

		// The visible window starts when the scroll SETTLES, not here. The tint's fade starts when
		// the target row mounts, which for an off-screen target is somewhere inside the scroll (and
		// can restart, since FlashList steps toward the target and may recycle the row on the way).
		// Timing the window from this point would cut the fade short, or expire it before the row
		// was ever on screen. FlashList resolves this promise after its final scroll, by which
		// point the row is up and the two clocks agree.
		const scrolled = listRef.current?.scrollToIndex({
			index: revealedIndex,
			animated: true,
			viewPosition: 0.5
		})

		void (scrolled ?? Promise.resolve()).then(() => {
			if (cancelled) {
				return
			}

			timeout = setTimeout(() => {
				setRevealedUuid(null)
			}, HIGHLIGHT_VISIBLE_MS)
		})

		return () => {
			cancelled = true

			if (timeout !== undefined) {
				clearTimeout(timeout)
			}
		}
	}, [revealedUuid, revealedIndex, listRef])

	return revealedUuid
}

export default useDriveHighlight

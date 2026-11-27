import { useEffect, useEffectEvent, useRef } from "react"
import { isImeKeydown } from "@filen/shared/keymap"
import type { AnyItemWithContext, DirPublicLink } from "@filen/sdk-rs"
import type { DriveItem } from "@/features/drive/lib/item"
import { FileHero } from "@/features/publicLinks/components/fileHero"
import { entryKey, toBrowseEntries } from "@/features/publicLinks/lib/browse.logic"
import { usePublicDirListing } from "@/features/publicLinks/queries/publicLink"
import { linkDirReferences } from "@/features/publicLinks/lib/linkReferences"
import { browsePagerList, stepEntry, treeEntries, type BrowsePagerList, type FileEntry } from "@/features/publicLinks/lib/browsePager.logic"
import type { ReferenceSourceFactory } from "@/features/preview/lib/referenceResolver"
import { useSlideshow } from "@/features/preview/hooks/useSlideshow"
import { useSlideshowSubfolders } from "@/features/preview/hooks/useSlideshowSubfolders"
import { previewCacheScope } from "@/features/preview/lib/accessMode"
import { hasTwoSlides, slideKindOf } from "@/features/preview/lib/slideshow.logic"
import { fetchLinkedSlideshowTree, type SlideshowSource } from "@/features/preview/lib/slideshowTree"
import { isMediaTarget, isTextEditingTarget, pagerDelta, previewOverlayKey } from "@/features/preview/components/previewOverlay.logic"
import { MENU_ESCAPE_MS } from "@/lib/media/menuEscape"
import { isRecordingCombo, useBindings } from "@/lib/keymap/registry"
import { isAnyOverlayOpen } from "@/lib/keymap/dialogGuard"
import { isMacPlatform } from "@/lib/keymap/kbd.logic"
import { OUTSIDE_OVERLAYS, useAction } from "@/lib/keymap/useAction"

const IS_MAC = isMacPlatform()

const NO_SIBLINGS: readonly DriveItem[] = []

type LinkedSource = Extract<SlideshowSource, { kind: "linked" }>

// A directory link's opened file with its pager: ‹ › and the arrows step through `pager` (the level's files, or a
// slideshow's subdirectories' list standing in), Home and End go to its ends, ▶ and S run a slideshow over it, Space
// pauses one, and Escape ends one before it leaves the file (an Escape just after one ended stays too: the browser may
// pass on the one it left full screen with). The keys stand down for a focused video or audio, a text field, a surface
// with arrows of its own and a zoomed-in image (which takes them first). `source` is the level's directory, the one
// whose subdirectories a slideshow may include (none while the level is filtered).
export function PagedFileHero({
	entry,
	pager,
	onStep,
	onPagerReplaced,
	onBack,
	link,
	source,
	downloadEnabled,
	linkScope,
	saveItem,
	siblings,
	references,
	onTreeListing
}: {
	entry: FileEntry
	pager: BrowsePagerList
	onStep: (entry: FileEntry) => void
	// The pager's list swapped, at `entry`.
	onPagerReplaced: (pager: BrowsePagerList, entry: FileEntry) => void
	onBack: () => void
	link: DirPublicLink
	source: LinkedSource | undefined
	downloadEnabled: boolean
	linkScope: string
	saveItem: AnyItemWithContext | undefined
	siblings: readonly DriveItem[]
	references: ReferenceSourceFactory
	// A slideshow's subdirectories are listed: the worker holds the link's listing for the page from then on.
	onTreeListing: () => void
}) {
	const uuid = entryKey(entry)
	const index = pager.entries.findIndex(candidate => entryKey(candidate) === uuid)
	const bindings = useBindings()

	function step(delta: number): void {
		const next = stepEntry(pager.entries, uuid, delta)

		if (next !== null && entryKey(next) !== uuid) {
			onStep(next)
		}
	}

	const slideshow = useSlideshow({
		items: pager.items,
		index: Math.max(index, 0),
		step,
		// Nothing here edits.
		canLeave: () => true,
		cacheScope: previewCacheScope("anon", linkScope),
		access: "anon"
	}) // Offered on a slide over at least two slides of the list, and kept while one runs.
	const slideshowOffered = slideshow.running || (slideKindOf(entry.item) !== null && pager.twoSlides)

	// When the last slideshow ended: an Escape just after it (one the browser also left full screen with) stays here.
	const endedAtRef = useRef(Number.NEGATIVE_INFINITY)

	// Swaps the pager's list, kept on the file on screen when the new list has it, else on `fallbackUuid`'s file when it
	// has that, else on its first file. False when there is nothing to swap to.
	function replacePager(next: BrowsePagerList, shown: string | undefined, fallbackUuid: string | undefined): boolean {
		const at = (key: string | undefined): FileEntry | undefined =>
			key === undefined ? undefined : next.entries.find(candidate => entryKey(candidate) === key)
		const landing = at(shown) ?? at(fallbackUuid) ?? next.entries[0]

		if (landing === undefined) {
			return false
		}

		onPagerReplaced(next, landing)

		return true
	}

	// "Include subdirectories": the subdirectories' list (and their directories) stands in for the level's.
	const subfolders = useSlideshowSubfolders({
		slideshow,
		offered: slideshowOffered,
		source,
		list: pager,
		// Nothing here edits.
		shown: { shown: uuid, locked: false },
		load: (linked, signal) => {
			onTreeListing()

			return fetchLinkedSlideshowTree(linked, signal)
		},
		listOf: tree => (hasTwoSlides(tree.items) ? browsePagerList(treeEntries(tree.items)) : null),
		replace: (next, on, fallbackUuid) => replacePager(next, on.shown, fallbackUuid),
		logScope: "publicLinks",
		onRunningChange: running => {
			if (!running) {
				endedAtRef.current = performance.now()
			}
		}
	})
	const treeDirs = subfolders.swapped?.tree.dirs ?? null
	// A file from below the level finds the files beside it (a video's subtitles) and its references in its own
	// directory: a search's result, any kind, by its trail; a slideshow's subdirectories' video by the tree's directories.
	// Its listing is asked once it is shown (the worker reads it from a search's held listing); the file shows meanwhile.
	const deepDir =
		entry.trail?.at(-1) ?? (treeDirs !== null && slideKindOf(entry.item) === "video" ? (treeDirs.get(entry.file.parent) ?? null) : null)
	const deepListing = usePublicDirListing({
		levelUuid: deepDir === null ? null : entry.file.parent,
		dir: deepDir,
		link: deepDir === null ? null : link
	})
	const shownSiblings =
		deepDir === null
			? siblings
			: deepListing.data === undefined
				? NO_SIBLINGS
				: toBrowseEntries(deepListing.data).map(item => item.item)
	const shownReferences = deepDir === null ? references : linkDirReferences(deepDir, link, deepListing.data)

	// Escape ends a running slideshow (where the page gets it: not in full screen, whose Escape is the browser's) and
	// otherwise returns to the directory.
	useAction(
		"links.back",
		() => {
			if (slideshow.running) {
				slideshow.stop()
			} else if (performance.now() - endedAtRef.current >= MENU_ESCAPE_MS) {
				onBack()
			}
		},
		OUTSIDE_OVERLAYS
	)

	// The preview overlay's own pager and slideshow keys, under the same guards. A key something took already (a
	// zoomed-in image's arrows, captured ahead of this) is not one.
	const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
		if (
			isImeKeydown(event) ||
			isRecordingCombo() ||
			isAnyOverlayOpen() ||
			isMediaTarget(event.target) ||
			isTextEditingTarget(event.target)
		) {
			return
		}

		const action = previewOverlayKey(event, bindings, IS_MAC)

		if (action === "preview.prev" || action === "preview.next" || action === "preview.first" || action === "preview.last") {
			const delta = pager.entries.length < 2 ? null : pagerDelta(action, Math.max(index, 0), pager.entries.length)

			if (delta === null) {
				return
			}

			event.preventDefault()
			step(delta)
		} else {
			subfolders.runKey(action, event)
		}
	})

	useEffect(() => {
		const listener = (event: KeyboardEvent): void => {
			onKeyDown(event)
		}

		document.addEventListener("keydown", listener)

		return () => {
			document.removeEventListener("keydown", listener)
		}
	}, [])

	return (
		<FileHero
			item={entry.item}
			downloadEnabled={downloadEnabled}
			linkScope={linkScope}
			onBack={onBack}
			saveItem={saveItem}
			archiveFile={entry.file}
			siblings={shownSiblings}
			references={shownReferences}
			pager={
				pager.entries.length < 2
					? undefined
					: {
							canPrevious: index > 0,
							canNext: index < pager.entries.length - 1,
							step,
							slideshow,
							slideshowOffered,
							startSlideshow: subfolders.start,
							subfolders: { available: subfolders.available, loading: subfolders.loading },
							onSubfoldersChange: subfolders.setSubfolders
						}
			}
		/>
	)
}

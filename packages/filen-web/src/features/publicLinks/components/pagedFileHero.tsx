import { useEffect, useEffectEvent, useRef, useState } from "react"
import { toast } from "sonner"
import { isImeKeydown } from "@filen/shared/keymap"
import type { AnyItemWithContext, DirPublicLink, LinkedDir } from "@filen/sdk-rs"
import type { DriveItem } from "@/features/drive/lib/item"
import { FileHero } from "@/features/publicLinks/components/fileHero"
import { entryKey, toBrowseEntries } from "@/features/publicLinks/lib/browse.logic"
import { usePublicDirListing } from "@/features/publicLinks/queries/publicLink"
import { browsePagerList, stepEntry, treeEntries, type BrowsePagerList, type FileEntry } from "@/features/publicLinks/lib/browsePager.logic"
import type { ReferenceSourceFactory } from "@/features/preview/lib/referenceResolver"
import { useSlideshow } from "@/features/preview/hooks/useSlideshow"
import { previewCacheScope } from "@/features/preview/lib/accessMode"
import { hasTwoSlides, slideKindOf } from "@/features/preview/lib/slideshow.logic"
import { setSlideshowPrefs, useSlideshowPrefs } from "@/features/preview/lib/slideshowPrefs"
import { fetchLinkedSlideshowTree, type SlideshowSource } from "@/features/preview/lib/slideshowTree"
import { isMediaTarget, isTextEditingTarget, pagerDelta, previewOverlayKey } from "@/features/preview/components/previewOverlay.logic"
import { MENU_ESCAPE_MS } from "@/lib/media/menuEscape"
import { isRecordingCombo, useBindings } from "@/lib/keymap/registry"
import { isAnyOverlayOpen } from "@/lib/keymap/dialogGuard"
import { isMacPlatform } from "@/lib/keymap/kbd.logic"
import { OUTSIDE_OVERLAYS, useAction } from "@/lib/keymap/useAction"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { log } from "@/lib/log"

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
	references
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
	})
	const slideshowPrefs = useSlideshowPrefs()
	const slideshowOffered = pager.twoSlides
	// The level's list while a slideshow's subdirectories' list stands in for it, and that list's directories.
	const [opening, setOpening] = useState<BrowsePagerList | null>(null)
	const [treeDirs, setTreeDirs] = useState<ReadonlyMap<string, LinkedDir> | null>(null)
	const [treeLoading, setTreeLoading] = useState(false)
	const treeAbortRef = useRef<AbortController | null>(null)
	// The file on screen when the slideshow started, and whether it runs as of the last commit.
	const startedFromRef = useRef<string | undefined>(undefined)
	const wasRunningRef = useRef(false)
	// When the last slideshow ended: an Escape just after it (one the browser also left full screen with) stays here.
	const endedAtRef = useRef(Number.NEGATIVE_INFINITY)
	// The file on screen as of the last commit, for a list that lands later.
	const shownRef = useRef(uuid)
	// A video from below the level (a slideshow's subdirectories, a search's results) finds its subtitles in its own
	// directory's listing, asked once it is shown (the worker reads it from a search's held listing); the video plays
	// meanwhile, and its subtitles come with the listing.
	const deepDir = slideKindOf(entry.item) === "video" ? (treeDirs?.get(entry.file.parent) ?? entry.trail?.at(-1) ?? null) : null
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

	useEffect(() => {
		shownRef.current = uuid
	}, [uuid])

	useEffect(
		() => () => {
			treeAbortRef.current?.abort()
		},
		[]
	)

	// Swaps the pager's list, kept on the file on screen when the new list has it, else on `fallbackUuid`'s file when it
	// has that, else on its first file. False when there is nothing to swap to.
	function replacePager(next: BrowsePagerList, shown: string, fallbackUuid?: string): boolean {
		const at = (key: string | undefined): FileEntry | undefined =>
			key === undefined ? undefined : next.entries.find(candidate => entryKey(candidate) === key)
		const landing = at(shown) ?? at(fallbackUuid) ?? next.entries[0]

		if (landing === undefined) {
			return false
		}

		onPagerReplaced(next, landing)

		return true
	}

	function loadSubfolders(): void {
		if (source === undefined || opening !== null || treeAbortRef.current !== null) {
			return
		}

		const controller = new AbortController()
		const held = pager

		treeAbortRef.current = controller
		setTreeLoading(true)

		void fetchLinkedSlideshowTree(source, controller.signal).then(
			tree => {
				if (controller.signal.aborted) {
					return
				}

				treeAbortRef.current = null
				setTreeLoading(false)

				// Fewer than two slides would end the slideshow: the list stays. It lands on the file on screen now, which
				// the slideshow may have moved on from since the load began.
				if (hasTwoSlides(tree.items) && replacePager(browsePagerList(treeEntries(tree.items)), shownRef.current)) {
					setOpening(held)
					setTreeDirs(tree.dirs)
				}
			},
			(error: unknown) => {
				if (controller.signal.aborted) {
					return
				}

				treeAbortRef.current = null
				setTreeLoading(false)
				log.warn("publicLinks", "the slideshow's subdirectories could not be listed", error)
				toast.error(errorLabel(error))
			}
		)
	}

	// Back to the level's list (at `fallbackUuid`'s file when the one on screen is not in it).
	function dropSubfolders(fallbackUuid?: string): void {
		treeAbortRef.current?.abort()
		treeAbortRef.current = null
		setTreeLoading(false)

		if (opening !== null && replacePager(opening, uuid, fallbackUuid)) {
			setOpening(null)
			setTreeDirs(null)
		}
	}

	function handleSubfoldersChange(on: boolean): void {
		setSlideshowPrefs({ subfolders: on })

		if (on) {
			loadSubfolders()
		} else {
			dropSubfolders()
		}
	}

	// Inside the click or key gesture (full screen is entered there).
	function startSlideshow(): void {
		if (!slideshowOffered || slideshow.running) {
			return
		}

		startedFromRef.current = uuid
		slideshow.start()

		if (slideshowPrefs.subfolders && source !== undefined) {
			loadSubfolders()
		}
	}

	// An end by whatever path (the bar, Escape, full screen left, too few slides left): the subdirectories' list is the
	// slideshow's alone, so a load under way never lands and the level's list comes back (the stored preference stays).
	const onRunningChange = useEffectEvent((running: boolean) => {
		if (!running) {
			endedAtRef.current = performance.now()
			dropSubfolders(startedFromRef.current)
		}
	})

	useEffect(() => {
		if (wasRunningRef.current === slideshow.running) {
			return
		}

		wasRunningRef.current = slideshow.running
		onRunningChange(slideshow.running)
	}, [slideshow.running])

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
		} else if (
			action === "preview.slideshow"
				? slideshowOffered && !slideshow.running
				: action === "preview.slideshowPause" && slideshow.running
		) {
			event.preventDefault()

			if (event.repeat) {
				return
			}

			if (action === "preview.slideshow") {
				startSlideshow()
			} else {
				slideshow.togglePause()
			}
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
			references={references}
			pager={
				pager.entries.length < 2
					? undefined
					: {
							canPrevious: index > 0,
							canNext: index < pager.entries.length - 1,
							step,
							slideshow,
							slideshowOffered,
							startSlideshow,
							subfolders: { available: source !== undefined, loading: treeLoading },
							onSubfoldersChange: handleSubfoldersChange
						}
			}
		/>
	)
}

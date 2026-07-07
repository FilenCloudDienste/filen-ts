import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate } from "@tanstack/react-router"
import { useVirtualizer } from "@tanstack/react-virtual"
import { useShallow } from "zustand/shallow"
import {
	resolveEffectiveSort,
	resolveEffectiveViewMode,
	withSortSelection,
	withViewModeSelection,
	setSortPreferences,
	setViewModePreferences,
	isSortableVariant,
	DEFAULT_SORT_PREFERENCES,
	DEFAULT_VIEW_MODE_PREFERENCES,
	type DriveVariant,
	type DriveLocation,
	type DriveViewMode
} from "@/lib/drive/preferences"
import { sortDriveItems, type DriveSortBy } from "@/lib/drive/sort"
import { resolveDriveNavigationTarget, splatToUuids } from "@/lib/drive/navigate"
import { clampListboxIndex, listboxRange } from "@/lib/drive/listbox"
import { type DriveItem } from "@/lib/drive/item"
import { useDirectoryListingQuery, useSortPreferencesQuery, useViewModePreferencesQuery } from "@/queries/drive"
import { useDriveStore } from "@/stores/drive"
import { asErrorDTO } from "@/lib/sdk/errors"
import { registerAction } from "@/lib/keymap/registry"
import { useAction } from "@/lib/keymap/useAction"
import { Breadcrumb } from "@/components/drive/breadcrumb"
import { SortMenu } from "@/components/drive/sort-menu"
import { ViewModeToggle } from "@/components/drive/view-mode-toggle"
import { NewDirectory } from "@/components/drive/new-directory"
import { EmptyState } from "@/components/drive/empty-state"
import { ListingSkeleton } from "@/components/drive/listing-skeleton"
import { DriveRow } from "@/components/drive/drive-row"
import { DriveTile } from "@/components/drive/drive-tile"

export interface DirectoryListingProps {
	variant: DriveVariant
	// The full "/drive/$" splat path ("" for root, else a "/"-joined ancestor-uuid chain) — recents/
	// favorites/trash pass "" (they're flat, never nested). The current directory is the last segment.
	splat: string
}

// Module scope, not inside the component: runs exactly once per module evaluation (see
// theme-provider.tsx's own "app.toggleTheme" registration for the full StrictMode/HMR rationale).
//
// Reconciling these with the listbox's own roving-tabindex `onKeyDown` (below): select-all and
// clear-selection used to be hand-rolled checks inside that handler, matching Cmd/Ctrl+A and
// Escape unconditionally whenever the listbox had focus. They are registered as commands here
// INSTEAD of that (not in addition to it — a stray double-registration would double-fire, since
// useAction's useHotkeys binds document-wide, not scoped to the listbox element) so a user remap
// actually changes what fires, and so `<Kbd action>` reflects the real live combo. This makes them
// fire regardless of focus location on the page (not just while the listbox itself is focused) —
// an accepted, documented widening: every registered action fires globally today (no
// `<HotkeysProvider>` scope activation yet, see registry.ts's ActionScope comment), and drive is
// the app's only real interactive surface this slice, so "global" and "listbox-focused" coincide
// in practice. Arrow/Home/End/Space/Enter cursor movement stays listbox-local — those are
// continuous, per-row navigation semantics, not discrete user-remappable commands.
registerAction({
	id: "drive.selectAll",
	defaultCombo: "mod+a",
	scope: "drive",
	descriptionKey: "driveCommandSelectAll"
})
registerAction({
	id: "drive.clearSelection",
	defaultCombo: "escape",
	scope: "drive",
	descriptionKey: "driveCommandClearSelection"
})
// No prior intrinsic handling to reconcile — view mode had no keyboard toggle before this.
registerAction({
	id: "drive.toggleView",
	defaultCombo: "v",
	scope: "drive",
	descriptionKey: "driveCommandToggleView"
})

const ROW_HEIGHT = 40
const TILE_WIDTH = 140
const TILE_ROW_HEIGHT = 124
const LIST_OVERSCAN = 8
const GRID_OVERSCAN = 3
// Bounds the rAF poll moveActive() uses to focus a cursor target that scrollToIndex just brought
// into range but that hasn't mounted (and registered its ref) yet.
const FOCUS_RETRY_FRAMES = 10

// Every drive route (drive.$.tsx, recents/favorites/trash.tsx) renders this one container with its
// own {variant,splat} — the single place the placeholder body is swapped for the real virtualized
// list, so no route needs to change again when it does. The current directory's own uuid is always
// the splat's last segment (null at the root, where the splat is empty).
export function DirectoryListing({ variant, splat }: DirectoryListingProps) {
	const { t } = useTranslation(["drive", "common"])
	const navigate = useNavigate()
	const uuid = splatToUuids(splat).at(-1) ?? null
	const driveLocation: DriveLocation = { variant, uuid }

	const listingQuery = useDirectoryListingQuery(variant, uuid)
	const sortPrefsQuery = useSortPreferencesQuery()
	const viewModePrefsQuery = useViewModePreferencesQuery()

	const sortPrefs = sortPrefsQuery.data ?? DEFAULT_SORT_PREFERENCES
	const viewModePrefs = viewModePrefsQuery.data ?? DEFAULT_VIEW_MODE_PREFERENCES
	const effectiveSort = resolveEffectiveSort(sortPrefs, driveLocation)
	const effectiveViewMode = resolveEffectiveViewMode(viewModePrefs, driveLocation)

	const sortedItems = sortDriveItems(listingQuery.data ?? [], effectiveSort)

	const selectedItems = useDriveStore(useShallow(state => state.selectedItems))

	const [activeIndex, setActiveIndex] = useState(0)
	const [anchorIndex, setAnchorIndex] = useState(0)
	const safeActiveIndex = clampListboxIndex(activeIndex, sortedItems.length)
	const safeAnchorIndex = clampListboxIndex(anchorIndex, sortedItems.length)

	// A fresh directory/variant must never inherit the previous one's selection or cursor. Routes
	// that only change `splat` (deeper nav within the same drive.$.tsx route) re-render this
	// component in place rather than remounting it, so a plain mount effect would miss that case —
	// keying on [variant, splat] instead covers both a remount and an in-place param change.
	useEffect(() => {
		useDriveStore.getState().clearSelectedItems()
		setActiveIndex(0)
		setAnchorIndex(0)
	}, [variant, splat])

	const scrollRef = useRef<HTMLDivElement>(null)
	const itemRefs = useRef(new Map<number, HTMLDivElement>())
	const focusRequestRef = useRef(0)

	const [containerWidth, setContainerWidth] = useState(0)

	useEffect(() => {
		const el = scrollRef.current

		if (!el) {
			return
		}

		const observer = new ResizeObserver(entries => {
			const entry = entries[0]

			if (entry) {
				setContainerWidth(entry.contentRect.width)
			}
		})

		observer.observe(el)

		return () => {
			observer.disconnect()
		}
	}, [])

	const columns = Math.max(1, Math.floor(containerWidth / TILE_WIDTH))
	const rowCount = Math.ceil(sortedItems.length / columns)

	const listVirtualizer = useVirtualizer({
		count: sortedItems.length,
		getScrollElement: () => scrollRef.current,
		estimateSize: () => ROW_HEIGHT,
		overscan: LIST_OVERSCAN,
		getItemKey: index => sortedItems[index]?.data.uuid ?? index
	})

	const gridVirtualizer = useVirtualizer({
		count: rowCount,
		getScrollElement: () => scrollRef.current,
		estimateSize: () => TILE_ROW_HEIGHT,
		overscan: GRID_OVERSCAN,
		getItemKey: index => index
	})

	const activeVirtualizer = effectiveViewMode === "list" ? listVirtualizer : gridVirtualizer

	function registerRef(index: number, el: HTMLDivElement | null) {
		if (el) {
			itemRefs.current.set(index, el)
		} else {
			itemRefs.current.delete(index)
		}
	}

	// Focus is imperative by nature here: the target index may be scrolled fully out of the mounted
	// window, and scrollToIndex's resulting re-render happens through the virtualizer's own
	// scroll-event subscription, not synchronously with the state update below — so on the very next
	// render the target row/tile may not exist in the DOM (and its ref) yet. A bounded rAF poll picks
	// it up once it mounts; `focusRequestRef` lets a rapid run of keypresses invalidate an older,
	// still-polling request instead of it stealing focus back after a newer one already landed.
	function moveActive(nextIndexRaw: number): number {
		const next = clampListboxIndex(nextIndexRaw, sortedItems.length)
		const rowIndex = effectiveViewMode === "grid" ? Math.floor(next / columns) : next

		setActiveIndex(next)
		activeVirtualizer.scrollToIndex(rowIndex, { align: "auto" })
		focusRequestRef.current = next

		const attemptFocus = (attemptsLeft: number) => {
			if (focusRequestRef.current !== next) {
				return
			}

			const el = itemRefs.current.get(next)

			if (el) {
				if (document.activeElement !== el) {
					el.focus({ preventScroll: true })
				}

				return
			}

			if (attemptsLeft <= 0) {
				return
			}

			requestAnimationFrame(() => {
				attemptFocus(attemptsLeft - 1)
			})
		}

		requestAnimationFrame(() => {
			attemptFocus(FOCUS_RETRY_FRAMES)
		})

		return next
	}

	function selectRange(anchor: number, active: number) {
		const rangeItems: DriveItem[] = []

		for (const i of listboxRange(anchor, active)) {
			const item = sortedItems[i]

			if (item) {
				rangeItems.push(item)
			}
		}

		useDriveStore.getState().setSelectedItems(rangeItems)
	}

	function handleOpen(index: number) {
		const item = sortedItems[index]

		if (!item) {
			return
		}

		const target = resolveDriveNavigationTarget(item, variant, splat)

		if (target) {
			void navigate(target)
		}
	}

	function handlePointerSelect(index: number, event: MouseEvent<HTMLDivElement>) {
		const item = sortedItems[index]

		if (!item) {
			return
		}

		if (event.shiftKey) {
			selectRange(safeAnchorIndex, index)
			setActiveIndex(index)

			return
		}

		if (event.metaKey || event.ctrlKey) {
			useDriveStore.getState().toggleSelectedItem(item)
			setActiveIndex(index)
			setAnchorIndex(index)

			return
		}

		useDriveStore.getState().setSelectedItems([item])
		setActiveIndex(index)
		setAnchorIndex(index)
	}

	// ARIA listbox cursor semantics (roving tabindex): plain Arrow/Home/End move the cursor only —
	// they never change the selection — Space toggles the active item, Shift+Arrow extends a range
	// from the last non-shift cursor position. Select-all (Cmd/Ctrl+A) and clear-selection (Escape)
	// are NOT handled here — they're registered drive.selectAll/drive.clearSelection commands (see
	// the module-scope registerAction calls above) so they stay user-remappable with one firing
	// owner; keeping a second hand-rolled check here would double-fire on every keypress.
	function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
		if (sortedItems.length === 0) {
			return
		}

		if (event.key === " ") {
			event.preventDefault()

			const item = sortedItems[safeActiveIndex]

			if (item) {
				useDriveStore.getState().toggleSelectedItem(item)
				setAnchorIndex(safeActiveIndex)
			}

			return
		}

		if (event.key === "Enter") {
			event.preventDefault()
			handleOpen(safeActiveIndex)

			return
		}

		const step = effectiveViewMode === "grid" ? columns : 1
		let target: number | null = null

		if (event.key === "ArrowDown") {
			target = safeActiveIndex + step
		} else if (event.key === "ArrowUp") {
			target = safeActiveIndex - step
		} else if (event.key === "ArrowRight" && effectiveViewMode === "grid") {
			target = safeActiveIndex + 1
		} else if (event.key === "ArrowLeft" && effectiveViewMode === "grid") {
			target = safeActiveIndex - 1
		} else if (event.key === "Home") {
			target = 0
		} else if (event.key === "End") {
			target = sortedItems.length - 1
		}

		if (target === null) {
			return
		}

		event.preventDefault()

		const next = moveActive(target)

		if (event.shiftKey) {
			selectRange(safeAnchorIndex, next)
		} else {
			setAnchorIndex(next)
		}
	}

	async function applySortChange(next: DriveSortBy): Promise<void> {
		await setSortPreferences(withSortSelection(sortPrefs, driveLocation, next))
		await sortPrefsQuery.refetch()
	}

	async function applyViewModeChange(next: DriveViewMode): Promise<void> {
		await setViewModePreferences(withViewModeSelection(viewModePrefs, driveLocation, next))
		await viewModePrefsQuery.refetch()
	}

	// Registered above at module scope. Browser default for mod+a is "select all page text" — must
	// preventDefault or the native selection would visibly compete with the drive-item selection.
	useAction(
		"drive.selectAll",
		keyboardEvent => {
			keyboardEvent.preventDefault()
			useDriveStore.getState().selectAllItems(sortedItems)
		},
		undefined,
		[sortedItems]
	)

	// Registered above at module scope. No preventDefault — bare Escape has no disruptive browser
	// default, matching the hand-rolled handler this replaced.
	useAction(
		"drive.clearSelection",
		() => {
			useDriveStore.getState().clearSelectedItems()
		},
		undefined,
		[]
	)

	// Registered above at module scope. Net-new shortcut — no listbox handling to reconcile.
	useAction(
		"drive.toggleView",
		() => {
			void applyViewModeChange(effectiveViewMode === "list" ? "grid" : "list")
		},
		undefined,
		[effectiveViewMode, applyViewModeChange]
	)

	return (
		<>
			<header className="flex h-14 shrink-0 items-center border-b border-border px-4">
				<Breadcrumb
					variant={variant}
					splat={splat}
				/>
			</header>
			<div className="flex h-12 shrink-0 items-center justify-between gap-4 border-b border-border px-4">
				<p className="text-sm text-muted-foreground">
					{listingQuery.status === "success"
						? selectedItems.length > 0
							? t("driveSelectionCount", { count: selectedItems.length })
							: t("driveItemCount", { count: sortedItems.length })
						: null}
				</p>
				<div className="flex items-center gap-2">
					<NewDirectory
						parentUuid={uuid}
						disabled={variant !== "drive" || listingQuery.status !== "success"}
					/>
					<ViewModeToggle
						value={effectiveViewMode}
						onChange={next => {
							void applyViewModeChange(next)
						}}
					/>
					<SortMenu
						value={effectiveSort}
						onChange={next => {
							void applySortChange(next)
						}}
						disabled={!isSortableVariant(variant) || listingQuery.status !== "success"}
					/>
				</div>
			</div>
			<div className="flex min-h-0 flex-1 flex-col overflow-hidden">
				{listingQuery.status === "pending" ? (
					<div className="flex-1 overflow-y-auto">
						<ListingSkeleton viewMode={effectiveViewMode} />
					</div>
				) : listingQuery.status === "error" ? (
					<div className="flex flex-1 overflow-y-auto">
						<EmptyState
							variant="error"
							error={asErrorDTO(listingQuery.error)}
							onRetry={() => {
								void listingQuery.refetch()
							}}
						/>
					</div>
				) : sortedItems.length === 0 ? (
					<div className="flex flex-1 overflow-y-auto">
						<EmptyState variant="empty" />
					</div>
				) : (
					<>
						{effectiveViewMode === "list" ? (
							<div
								aria-hidden="true"
								className="flex h-8 shrink-0 items-center gap-3 border-b border-border px-3 text-xs font-medium text-muted-foreground"
							>
								<span className="size-4 shrink-0" />
								<span className="min-w-0 flex-1">{t("driveColumnName")}</span>
								<span className="w-20 shrink-0 text-right">{t("driveColumnSize")}</span>
								<span className="w-28 shrink-0 text-right">{t("driveColumnModified")}</span>
							</div>
						) : null}
						<div
							ref={scrollRef}
							role="listbox"
							aria-multiselectable="true"
							aria-label={t("driveListLabel")}
							tabIndex={-1}
							onKeyDown={handleKeyDown}
							className="min-h-0 flex-1 overflow-y-auto"
						>
							<div style={{ position: "relative", width: "100%", height: activeVirtualizer.getTotalSize() }}>
								{effectiveViewMode === "list"
									? listVirtualizer.getVirtualItems().map(virtualRow => {
											const item = sortedItems[virtualRow.index]

											if (!item) {
												return null
											}

											return (
												<DriveRow
													key={virtualRow.key}
													item={item}
													index={virtualRow.index}
													selected={selectedItems.some(selectedItem => selectedItem.data.uuid === item.data.uuid)}
													active={virtualRow.index === safeActiveIndex}
													style={{
														position: "absolute",
														top: 0,
														left: 0,
														width: "100%",
														transform: `translateY(${String(virtualRow.start)}px)`
													}}
													onPointerSelect={handlePointerSelect}
													onOpen={handleOpen}
													registerRef={registerRef}
												/>
											)
										})
									: gridVirtualizer.getVirtualItems().map(virtualRow => (
											<div
												key={virtualRow.key}
												style={{
													position: "absolute",
													top: 0,
													left: 0,
													width: "100%",
													transform: `translateY(${String(virtualRow.start)}px)`,
													display: "grid",
													gridTemplateColumns: `repeat(${String(columns)}, minmax(0, 1fr))`
												}}
											>
												{Array.from({ length: columns }, (_, column) => {
													const itemIndex = virtualRow.index * columns + column
													const item = sortedItems[itemIndex]

													if (!item) {
														return null
													}

													return (
														<DriveTile
															key={item.data.uuid}
															item={item}
															index={itemIndex}
															selected={selectedItems.some(
																selectedItem => selectedItem.data.uuid === item.data.uuid
															)}
															active={itemIndex === safeActiveIndex}
															onPointerSelect={handlePointerSelect}
															onOpen={handleOpen}
															registerRef={registerRef}
														/>
													)
												})}
											</div>
										))}
							</div>
						</div>
					</>
				)}
			</div>
		</>
	)
}

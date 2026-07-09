import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate } from "@tanstack/react-router"
import { useVirtualizer } from "@tanstack/react-virtual"
import { useShallow } from "zustand/shallow"
import { toast } from "sonner"
import { SearchXIcon, CircleAlertIcon } from "lucide-react"
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
import { asDirectoryOrFile, type DriveItem } from "@/lib/drive/item"
import { canPreview, previewableSiblings, stepPreviewIndex } from "@/lib/drive/preview.logic"
import { renameItem, trashItems, restoreItems, deleteItemsPermanently, emptyTrash } from "@/lib/drive/actions"
import { unshareItems } from "@/lib/share/actions"
import { startDownloads } from "@/lib/drive/download"
import { type BulkOutcome } from "@/lib/drive/bulk"
import { toastBulkOutcome } from "@/lib/drive/bulk-toast"
import { useDirectoryListingQuery, useSortPreferencesQuery, useViewModePreferencesQuery } from "@/queries/drive"
import { useDriveStore } from "@/stores/drive"
import { asErrorDTO } from "@/lib/sdk/errors"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { registerAction } from "@/lib/keymap/registry"
import { useAction } from "@/lib/keymap/useAction"
import { useBlockedUsers } from "@/lib/contacts/use-blocked-users"
import { driveItemActions, type ItemActionDialogKind } from "@/components/drive/item-menu.logic"
import { isBulkDownloadEnabled } from "@/components/drive/bulk-action-bar.logic"
import { filterSharedInByBlocked, resolveSearchDisplayItems, staleBlockedSelectionUuids } from "@/components/drive/directory-listing.logic"
import { Breadcrumb } from "@/components/drive/breadcrumb"
import { SortMenu } from "@/components/drive/sort-menu"
import { ViewModeToggle } from "@/components/drive/view-mode-toggle"
import { NewDirectory } from "@/components/drive/new-directory"
import { UploadMenu } from "@/components/drive/upload-menu"
import { UploadDropzone } from "@/components/drive/upload-dropzone"
import { BulkActionBar, type BulkDialogActionKind } from "@/components/drive/bulk-action-bar"
import { EmptyState } from "@/components/drive/empty-state"
import { ListingSkeleton } from "@/components/drive/listing-skeleton"
import { DriveRow } from "@/components/drive/drive-row"
import { DriveTile } from "@/components/drive/drive-tile"
import { SearchInput } from "@/components/drive/search-input"
import { useDriveSearch } from "@/components/drive/use-drive-search"
import { searchHitNavigationTarget } from "@/components/drive/use-drive-search.logic"
import { Spinner } from "@/components/ui/spinner"
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { MoveTargetDialog } from "@/components/drive/move-target-dialog"
import { ContactPickerDialog } from "@/components/drive/contact-picker-dialog"
import { ColorDialog } from "@/components/drive/color-dialog"
import { VersionsDialog } from "@/components/drive/versions-dialog"
import { InfoDialog } from "@/components/drive/info-dialog"
import { LinkDialog } from "@/components/drive/link-dialog"
import { PreviewOverlay } from "@/components/preview/preview-overlay"
import { ConfirmDialog } from "@/components/dialogs/confirm-dialog"
import { TypedConfirmDialog } from "@/components/dialogs/typed-confirm-dialog"
import { InputDialog } from "@/components/dialogs/input-dialog"

export interface DirectoryListingProps {
	variant: DriveVariant
	// The full "/drive/$" splat path ("" for root, else a "/"-joined ancestor-uuid chain) — recents/
	// favorites/trash pass "" (they're flat, never nested). The current directory is the last segment.
	splat: string
}

// The listing-level dialog host's own state shape. Widens item-menu.logic.ts's ItemActionDialogKind
// with two listing-level kinds neither dispatched by a per-item menu, so neither has a place in that
// narrower, per-item-scoped union: "emptyTrash" (the trash toolbar) and "restoreSelected" (the bulk
// bar's confirm — a single-item restore stays direct/unconfirmed, see item-menu.logic.ts's RESTORE).
type ActiveDialogKind = ItemActionDialogKind | "emptyTrash" | "restoreSelected" | "preview"

interface ActiveDialog {
	kind: ActiveDialogKind
	items: DriveItem[]
	// Only meaningful for kind:"preview" — the opened item's position within `items` (the frozen
	// previewable-sibling snapshot taken at open time). Every other kind leaves this unset.
	index?: number
}

// Kinds the dialog host below actually renders — every ActiveDialogKind is wired today, but the set
// stays explicit (rather than collapsing to a bare `activeDialog !== null` check) so a future kind
// added to the union without an immediate dialog implementation degrades safely: an unwired seam kind
// would otherwise look identical to a real one to the F2/Delete guards below, permanently wedging
// activeDialog !== null (and so those shortcuts) the moment a menu dispatched one, since nothing
// would ever render to close it again.
const WIRED_DIALOG_KINDS = new Set<ActiveDialogKind>([
	"rename",
	"trash",
	"delete",
	"emptyTrash",
	"move",
	"color",
	"versions",
	"info",
	"link",
	"share",
	"unshare",
	"restoreSelected",
	"preview"
])

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
// currently the app's only real interactive surface, so "global" and "listbox-focused" coincide
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
// Opens the rename dialog for the roving-cursor item — see the useAction call below for the guard
// (only a real, wired dialog blocks it; only an item driveItemActions itself would offer Rename for).
registerAction({
	id: "drive.rename",
	defaultCombo: "f2",
	scope: "drive",
	descriptionKey: "driveCommandRename"
})
// Opens the trash confirm for the current selection — see the useAction call below for its guards.
registerAction({
	id: "drive.trash",
	defaultCombo: "delete,backspace",
	scope: "drive",
	descriptionKey: "driveCommandTrash"
})
// Downloads the current selection — see the useAction call below for its guards (single unifying
// gate, mirroring item-menu/bulk-bar: mod+s reads as "save to disk", the FSA picker's own verb, and
// is free of every other registered combo (mod+a/escape/v/f2/delete/backspace/n, global "d"/"").
registerAction({
	id: "drive.download",
	defaultCombo: "mod+s",
	scope: "drive",
	descriptionKey: "driveCommandDownload"
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
	// New directory / upload only make sense in the navigable "drive" variant, once the listing has
	// loaded — recents/favorites/trash/shared have no directory to write into, and a still-loading
	// listing has no confirmed uuid to target yet. Shared by NewDirectory, UploadMenu and
	// UploadDropzone below (all three write into the same `uuid`).
	const writeDisabled = variant !== "drive" || listingQuery.status !== "success"
	// Gates the underlying contacts/blocked fetch itself (see use-blocked-users.ts) — only sharedIn
	// filters by it, so the other 5 variants skip the getContacts/getBlockedContacts worker round trip
	// on every mount and window refocus.
	const blocked = useBlockedUsers(variant === "sharedIn")

	const sortPrefs = sortPrefsQuery.data ?? DEFAULT_SORT_PREFERENCES
	const viewModePrefs = viewModePrefsQuery.data ?? DEFAULT_VIEW_MODE_PREFERENCES
	const effectiveSort = resolveEffectiveSort(sortPrefs, driveLocation)
	const effectiveViewMode = resolveEffectiveViewMode(viewModePrefs, driveLocation)

	// sharedIn ONLY: hide items shared by a blocked user (fail-open — see directory-listing.logic.ts).
	// Every other variant's listing data passes straight through, untouched.
	const visibleItems = variant === "sharedIn" ? filterSharedInByBlocked(listingQuery.data ?? [], blocked) : (listingQuery.data ?? [])
	// Subtree search rooted at the CURRENT directory (uuid), gated to the "drive" variant — recents/
	// favorites/trash/shared have no navigable subtree of their own for it to search. While active,
	// search results stand in for the normal listing query everywhere below: selection, the listbox's
	// keyboard nav, context menus, the bulk bar, and preview siblings all read `sortedItems` alone, so
	// swapping its one source here is what makes every one of them inherited for free.
	const search = useDriveSearch(uuid, variant === "drive")
	const sortedItems = search.active
		? resolveSearchDisplayItems(search.results, search.total, effectiveSort)
		: sortDriveItems(visibleItems, effectiveSort)

	const selectedItems = useDriveStore(useShallow(state => state.selectedItems))
	// Derived once per render so each row/tile's membership check is an O(1) `.has()` instead of an
	// O(selected) `.some()` — select-all in a large directory would otherwise make every render
	// O(visible * selected).
	const selectedUuids = new Set(selectedItems.map(item => item.data.uuid))

	const [activeIndex, setActiveIndex] = useState(0)
	const [anchorIndex, setAnchorIndex] = useState(0)
	const safeActiveIndex = clampListboxIndex(activeIndex, sortedItems.length)
	const safeAnchorIndex = clampListboxIndex(anchorIndex, sortedItems.length)

	// The dialog host's own state — one instance of whichever dialog activeDialog.kind names is
	// rendered below (renderActiveDialog), never more than one at a time. `dialogPending` is shared
	// across the kinds whose async call the HOST itself owns (rename/trash/delete/emptyTrash/
	// restoreSelected) — the move/color/versions/info dialogs run their own async calls internally and
	// track their own pending state, since each needs more than one shared boolean can express (e.g.
	// versions has an independent restore vs. delete-confirm flow).
	const [activeDialog, setActiveDialog] = useState<ActiveDialog | null>(null)
	const [dialogPending, setDialogPending] = useState(false)
	// True only while a dialog that actually RENDERS something is open — every kind renders one today
	// (see WIRED_DIALOG_KINDS), but the check stays explicit so a future seam kind can't silently wedge
	// the F2/Delete guards below open forever.
	const isDialogOpen = activeDialog !== null && WIRED_DIALOG_KINDS.has(activeDialog.kind)

	// A fresh directory/variant must never inherit the previous one's selection or cursor. Routes
	// that only change `splat` (deeper nav within the same drive.$.tsx route) re-render this
	// component in place rather than remounting it, so a plain mount effect would miss that case —
	// keying on [variant, splat] instead covers both a remount and an in-place param change.
	useEffect(() => {
		useDriveStore.getState().clearSelectedItems()
		setActiveIndex(0)
		setAnchorIndex(0)
	}, [variant, splat])

	// Stale-selection purge (sharedIn only): drops any selected item that just became blocked (the
	// user blocked its sharer while viewing this listing) so the bulk bar can never target a
	// now-hidden item. Fail-open, same predicate as the display filter above — an item whose sharer
	// identity doesn't resolve is never purged.
	useEffect(() => {
		if (variant !== "sharedIn") {
			return
		}

		const toRemove = staleBlockedSelectionUuids(useDriveStore.getState().selectedItems, blocked)

		if (toRemove.length > 0) {
			useDriveStore.getState().removeFromSelection(toRemove)
		}
	}, [variant, blocked])

	// State (not `useRef`) so it's settable from a callback ref below — the pending/error/empty
	// branches render a ref-less div, so a cold mount whose first render is "pending" would, with a
	// `useRef` + `[]`-dep effect, never attach an observer for the component's whole lifetime, and a
	// later pending<->success swap would leave one observing a detached node. A callback ref instead
	// fires on every mount/unmount of the actual DOM node regardless of which branch renders it first.
	const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
	const itemRefs = useRef(new Map<number, HTMLDivElement>())
	const focusRequestRef = useRef(0)

	const [containerWidth, setContainerWidth] = useState(0)

	useEffect(() => {
		if (!scrollElement) {
			return
		}

		const observer = new ResizeObserver(entries => {
			const entry = entries[0]

			if (entry) {
				setContainerWidth(entry.contentRect.width)
			}
		})

		observer.observe(scrollElement)

		return () => {
			observer.disconnect()
		}
	}, [scrollElement])

	const columns = Math.max(1, Math.floor(containerWidth / TILE_WIDTH))
	const rowCount = Math.ceil(sortedItems.length / columns)

	const listVirtualizer = useVirtualizer({
		count: sortedItems.length,
		getScrollElement: () => scrollElement,
		estimateSize: () => ROW_HEIGHT,
		overscan: LIST_OVERSCAN,
		getItemKey: index => sortedItems[index]?.data.uuid ?? index
	})

	const gridVirtualizer = useVirtualizer({
		count: rowCount,
		getScrollElement: () => scrollElement,
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

		// A file opens the preview overlay when previewable, else no-ops (mirrors the prior behavior:
		// resolveDriveNavigationTarget already returns null for every file arm — see its own comment).
		// A directory falls through to the unchanged navigation path below.
		if (asDirectoryOrFile(item).type === "file") {
			if (!canPreview(item, variant)) {
				return
			}

			const siblings = previewableSiblings(sortedItems, variant)
			const siblingIndex = siblings.findIndex(sibling => sibling.data.uuid === item.data.uuid)

			setActiveDialog({ kind: "preview", items: siblings, index: siblingIndex === -1 ? 0 : siblingIndex })

			return
		}

		// A search hit is found via a subtree search rooted at the CURRENT directory, but the hit itself
		// can be anywhere under it — searchHitNavigationTarget rebuilds a fresh, root-relative target
		// from the hit's own uuid (never appended to `splat`); the in-place open below stays unchanged
		// for the normal (non-search) listing.
		const target = search.active ? searchHitNavigationTarget(item, variant) : resolveDriveNavigationTarget(item, variant, splat)

		if (target) {
			void navigate(target)

			// Old-web parity: opening a directory hit always leaves search (the destination is a normal
			// listing, not another search).
			if (search.active) {
				search.clear()
			}
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

	function closeActiveDialog(): void {
		setActiveDialog(null)
	}

	// Steps the open preview by one sibling (no wrap) — the single implementation behind PreviewOverlay's
	// onStep prop, which both the header's prev/next buttons AND its own local in-dialog arrow-key
	// handler call (preview-overlay.tsx — arrow keys can't reach a document-level keymap action while
	// the dialog traps focus, see that handler's own comment). A no-op outside kind:"preview".
	function stepPreview(delta: 1 | -1): void {
		setActiveDialog(prev => {
			if (prev?.kind !== "preview" || prev.index === undefined) {
				return prev
			}

			const current = prev.items[prev.index]

			if (!current) {
				return prev
			}

			return { ...prev, index: stepPreviewIndex(current.data.uuid, prev.items, delta) }
		})
	}

	// Threaded into DriveRow/DriveTile as onItemAction (consistent with onPointerSelect/onOpen) — every
	// "dialog"-run item-menu descriptor calls this with its own kind; "direct"-run ones (favorite/
	// restore) resolve fully inside item-menu.tsx and never reach here.
	function handleItemAction(kind: ItemActionDialogKind, item: DriveItem): void {
		setActiveDialog({ kind, items: [item] })
	}

	async function handleRenameSubmit(item: DriveItem, value: string): Promise<void> {
		setDialogPending(true)
		const outcome = await renameItem(item, value.trim())
		setDialogPending(false)

		if (outcome.status === "error") {
			// Dialog stays open on error (e.g. a name clash) so the user can fix the name and retry —
			// mirrors new-directory.tsx's identical convention.
			toast.error(errorLabel(outcome.dto))
			return
		}

		closeActiveDialog()
	}

	// Shared tail for every HOST-owned bulk-dialog confirm (trash/delete/restoreSelected): runs `op`
	// against `items`, tracks the shared dialogPending flag, closes the dialog, toasts the outcome,
	// and prunes succeeded items from the selection — a no-op for whichever failed (still visible,
	// correctly still selected, so the user can retry without re-selecting).
	async function runBulkDialogAction(items: DriveItem[], op: (items: DriveItem[]) => Promise<BulkOutcome<DriveItem>>): Promise<void> {
		setDialogPending(true)
		const outcome = await op(items)
		setDialogPending(false)
		closeActiveDialog()
		toastBulkOutcome(outcome)
		useDriveStore.getState().removeFromSelection(outcome.succeeded.map(item => item.data.uuid))
	}

	async function handleTrashConfirm(items: DriveItem[]): Promise<void> {
		await runBulkDialogAction(items, trashItems)
	}

	async function handleDeleteConfirm(items: DriveItem[]): Promise<void> {
		await runBulkDialogAction(items, deleteItemsPermanently)
	}

	// Bulk restore CONFIRMS (unlike a single item's direct, unconfirmed restore — see
	// item-menu.logic.ts's RESTORE descriptor and driveRestoreSelectedConfirmTitle's own doc comment).
	async function handleRestoreSelectedConfirm(items: DriveItem[]): Promise<void> {
		await runBulkDialogAction(items, restoreItems)
	}

	// Root-only (see item-menu.logic.ts's UNSHARE gate) — the sharedIn/sharedOut root-listing patch
	// lives inside unshareItems itself, keyed off the CURRENT variant (this listing's own).
	async function handleUnshareConfirm(items: DriveItem[]): Promise<void> {
		await runBulkDialogAction(items, targetItems => unshareItems(targetItems, variant))
	}

	// Routes a bulk-action-bar click to the dialog host, dispatching against the CURRENT selection —
	// mirrors the drive.trash keymap command's identical setActiveDialog({kind:"trash", items:
	// selectedItems}) below.
	function handleBulkDialogAction(kind: BulkDialogActionKind): void {
		setActiveDialog({ kind, items: selectedItems })
	}

	async function handleEmptyTrashConfirm(): Promise<void> {
		setDialogPending(true)
		const outcome = await emptyTrash()
		setDialogPending(false)

		if (outcome.status === "error") {
			toast.error(errorLabel(outcome.dto))
			return
		}

		closeActiveDialog()
	}

	// One instance of whichever dialog is active, switching on activeDialog.kind — never more than one
	// mounted at a time.
	function renderActiveDialog(): ReactNode {
		if (!activeDialog) {
			return null
		}

		switch (activeDialog.kind) {
			case "rename": {
				const item = activeDialog.items[0]

				if (!item) {
					return null
				}

				return (
					<InputDialog
						open
						pending={dialogPending}
						title={t("driveActionRename")}
						body={t("driveRenameDialogBody")}
						label={t("driveNewDirectoryLabel")}
						initialValue={item.data.decryptedMeta?.name ?? ""}
						submitLabel={t("driveActionRename")}
						validate={value => value.trim().length > 0}
						onOpenChange={open => {
							if (!open) {
								closeActiveDialog()
							}
						}}
						onSubmit={value => {
							void handleRenameSubmit(item, value)
						}}
					/>
				)
			}
			case "trash":
				return (
					<ConfirmDialog
						open
						pending={dialogPending}
						title={t("driveTrashConfirmTitle")}
						body={t("driveTrashConfirmBody", { count: activeDialog.items.length })}
						confirmLabel={t("driveActionTrash")}
						cancelLabel={t("common:cancel")}
						onOpenChange={open => {
							if (!open) {
								closeActiveDialog()
							}
						}}
						onConfirm={() => {
							void handleTrashConfirm(activeDialog.items)
						}}
					/>
				)
			case "delete":
				return (
					<ConfirmDialog
						open
						pending={dialogPending}
						title={t("driveDeletePermanentlyConfirmTitle")}
						body={t("driveDeletePermanentlyConfirmBody", { count: activeDialog.items.length })}
						confirmLabel={t("driveActionDeletePermanently")}
						cancelLabel={t("common:cancel")}
						destructive
						onOpenChange={open => {
							if (!open) {
								closeActiveDialog()
							}
						}}
						onConfirm={() => {
							void handleDeleteConfirm(activeDialog.items)
						}}
					/>
				)
			case "restoreSelected":
				return (
					<ConfirmDialog
						open
						pending={dialogPending}
						title={t("driveRestoreSelectedConfirmTitle")}
						body={t("driveRestoreSelectedConfirmBody", { count: activeDialog.items.length })}
						confirmLabel={t("driveActionRestore")}
						cancelLabel={t("common:cancel")}
						onOpenChange={open => {
							if (!open) {
								closeActiveDialog()
							}
						}}
						onConfirm={() => {
							void handleRestoreSelectedConfirm(activeDialog.items)
						}}
					/>
				)
			case "emptyTrash": {
				const phrase = t("driveEmptyTrashTypedConfirmPhrase")

				return (
					<TypedConfirmDialog
						open
						pending={dialogPending}
						title={t("driveEmptyTrashConfirmTitle")}
						body={t("driveEmptyTrashConfirmBody", { phrase })}
						matchLabel={t("driveEmptyTrashTypedConfirmLabel")}
						matchValue={phrase}
						confirmLabel={t("driveActionEmptyTrash")}
						cancelLabel={t("common:cancel")}
						destructive
						onOpenChange={open => {
							if (!open) {
								closeActiveDialog()
							}
						}}
						onConfirm={() => {
							void handleEmptyTrashConfirm()
						}}
					/>
				)
			}
			case "move":
				return activeDialog.items.length > 0 ? (
					<MoveTargetDialog
						items={activeDialog.items}
						onClose={closeActiveDialog}
					/>
				) : null
			case "color": {
				const item = activeDialog.items[0]

				// The menu only ever offers Color for a directory (see item-menu.logic.ts) — this narrows
				// that guarantee into a type, it doesn't impose a new one.
				if (item?.type !== "directory") {
					return null
				}

				return (
					<ColorDialog
						directory={item}
						onClose={closeActiveDialog}
					/>
				)
			}
			case "versions": {
				const item = activeDialog.items[0]

				if (item?.type !== "file") {
					return null
				}

				return (
					<VersionsDialog
						file={item}
						onClose={closeActiveDialog}
					/>
				)
			}
			case "info": {
				const item = activeDialog.items[0]

				if (!item) {
					return null
				}

				return (
					<InfoDialog
						item={item}
						remoteInfoEnabled={variant !== "trash"}
						onClose={closeActiveDialog}
					/>
				)
			}
			case "link": {
				const item = activeDialog.items[0]

				if (!item) {
					return null
				}

				return (
					<LinkDialog
						item={item}
						onClose={closeActiveDialog}
					/>
				)
			}
			case "share":
				// Reached from a per-item menu (items: [item]) or the bulk bar (items: selectedItems) — the
				// picker itself shares each item with every chosen contact.
				return activeDialog.items.length > 0 ? (
					<ContactPickerDialog
						items={activeDialog.items}
						onClose={closeActiveDialog}
					/>
				) : null
			case "unshare":
				// Reached from a per-item menu (items: [item]) or the bulk bar (items: selectedItems) — both
				// only ever dispatch this for sharedRootDirectory/sharedRootFile arms (item-menu.logic.ts /
				// bulk-action-bar.logic.ts's own root-only gate).
				return (
					<ConfirmDialog
						open
						pending={dialogPending}
						title={t("driveUnshareConfirmTitle")}
						body={t("driveUnshareConfirmBody", { count: activeDialog.items.length })}
						confirmLabel={t("driveActionUnshare")}
						cancelLabel={t("common:cancel")}
						destructive
						onOpenChange={open => {
							if (!open) {
								closeActiveDialog()
							}
						}}
						onConfirm={() => {
							void handleUnshareConfirm(activeDialog.items)
						}}
					/>
				)
			case "preview": {
				const previewIndex = activeDialog.index

				if (previewIndex === undefined) {
					return null
				}

				return (
					<PreviewOverlay
						variant={variant}
						items={activeDialog.items}
						index={previewIndex}
						onStep={stepPreview}
						onClose={closeActiveDialog}
					/>
				)
			}
		}
	}

	// Registered above at module scope. Browser default for mod+a is "select all page text" — must
	// preventDefault or the native selection would visibly compete with the drive-item selection.
	// Guarded on isDialogOpen (see its own comment) so a background Cmd+A can't select items behind
	// an open dialog — returns before preventDefault, so the browser default runs instead in that case.
	useAction(
		"drive.selectAll",
		keyboardEvent => {
			if (isDialogOpen) {
				return
			}

			keyboardEvent.preventDefault()
			useDriveStore.getState().selectAllItems(sortedItems)
		},
		undefined,
		[isDialogOpen, sortedItems]
	)

	// Registered above at module scope. No preventDefault — bare Escape has no disruptive browser
	// default, matching the hand-rolled handler this replaced. Guarded on isDialogOpen so Escape closes
	// the dialog (its own onOpenChange handling) without also clearing the background selection.
	useAction(
		"drive.clearSelection",
		() => {
			if (isDialogOpen) {
				return
			}

			useDriveStore.getState().clearSelectedItems()
		},
		undefined,
		[isDialogOpen]
	)

	// Registered above at module scope. Net-new shortcut — no listbox handling to reconcile. Guarded
	// on isDialogOpen so it can't flip the background view mode while a dialog is open.
	useAction(
		"drive.toggleView",
		() => {
			if (isDialogOpen) {
				return
			}

			void applyViewModeChange(effectiveViewMode === "list" ? "grid" : "list")
		},
		undefined,
		[isDialogOpen, effectiveViewMode, applyViewModeChange]
	)

	// Registered above at module scope. No preventDefault — F2 has no disruptive browser default.
	// Reuses driveItemActions' own gating (rather than re-deriving "not in trash, not undecryptable"
	// here) so this can never open a rename the item menu itself wouldn't offer for the same item.
	useAction(
		"drive.rename",
		() => {
			if (isDialogOpen) {
				return
			}

			const item = sortedItems[safeActiveIndex]

			if (!item || !driveItemActions(item, variant).some(descriptor => descriptor.id === "rename")) {
				return
			}

			setActiveDialog({ kind: "rename", items: [item] })
		},
		undefined,
		[isDialogOpen, sortedItems, safeActiveIndex, variant]
	)

	// Registered above at module scope. preventDefault unconditionally — Backspace's browser default
	// (navigate back) must never fire while this listing has focus, guarded case or not. Guards: empty
	// selection, a wired dialog already open (isDialogOpen — see its own comment), and trash itself
	// (permanent delete stays menu-only + explicitly confirmed, never a bare keypress).
	useAction(
		"drive.trash",
		keyboardEvent => {
			keyboardEvent.preventDefault()

			if (selectedItems.length === 0 || isDialogOpen || variant === "trash") {
				return
			}

			setActiveDialog({ kind: "trash", items: selectedItems })
		},
		undefined,
		[selectedItems, isDialogOpen, variant]
	)

	// Registered above at module scope. preventDefault unconditionally — mod+s's browser default
	// (Save Page As) must never fire while this listing has focus. Guards mirror drive.trash's own
	// (an open dialog, the trash variant — download isn't offered there, matching item-menu/bulk-bar's
	// own trash exclusion) plus isBulkDownloadEnabled (bulk-action-bar.logic.ts) — the single unifying
	// ENABLED gate every download entry point shares, empty selection included (false for []). Also
	// inert when the selection includes an undecryptable item — its meta is ciphertext with no content
	// key, so it can never decrypt (mirrors item-menu/bulk-bar's own undecryptable exclusion) — void,
	// not awaited, so the FSA save picker inside startDownloads keeps this keydown's own live user
	// gesture.
	useAction(
		"drive.download",
		keyboardEvent => {
			keyboardEvent.preventDefault()

			if (
				isDialogOpen ||
				variant === "trash" ||
				!isBulkDownloadEnabled(selectedItems) ||
				selectedItems.some(item => item.data.undecryptable)
			) {
				return
			}

			void startDownloads(selectedItems)
		},
		undefined,
		[selectedItems, isDialogOpen, variant]
	)

	// The column header + virtualized listbox — identical shape whether sortedItems is the normal
	// listing or (search.active) the search results; only the per-row/tile searchParentPath and the
	// trailing footer differ. Kept as one render function rather than duplicated JSX in both branches
	// below.
	function renderListboxContent(): ReactNode {
		return (
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
					ref={setScrollElement}
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

									// exactOptionalPropertyTypes forbids passing searchParentPath={undefined} outright (a distinct
									// state from "omitted") — spread it in only when there's a real string to show.
									const parentPath = search.active ? search.parentPaths.get(item.data.uuid) : undefined

									return (
										<DriveRow
											key={virtualRow.key}
											item={item}
											index={virtualRow.index}
											selected={selectedUuids.has(item.data.uuid)}
											active={virtualRow.index === safeActiveIndex}
											variant={variant}
											style={{
												position: "absolute",
												top: 0,
												left: 0,
												width: "100%",
												transform: `translateY(${String(virtualRow.start)}px)`
											}}
											{...(parentPath !== undefined ? { searchParentPath: parentPath } : {})}
											onPointerSelect={handlePointerSelect}
											onOpen={handleOpen}
											onItemAction={handleItemAction}
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

											// exactOptionalPropertyTypes forbids passing searchParentPath={undefined} outright (a distinct
											// state from "omitted") — spread it in only when there's a real string to show.
											const parentPath = search.active ? search.parentPaths.get(item.data.uuid) : undefined

											return (
												<DriveTile
													key={item.data.uuid}
													item={item}
													index={itemIndex}
													selected={selectedUuids.has(item.data.uuid)}
													active={itemIndex === safeActiveIndex}
													variant={variant}
													{...(parentPath !== undefined ? { searchParentPath: parentPath } : {})}
													onPointerSelect={handlePointerSelect}
													onOpen={handleOpen}
													onItemAction={handleItemAction}
													registerRef={registerRef}
												/>
											)
										})}
									</div>
								))}
					</div>
				</div>
				{search.active && (search.status === "background" || search.total > BigInt(sortedItems.length)) ? (
					<div className="flex h-8 shrink-0 items-center justify-center gap-2 border-t border-border px-3 text-xs text-muted-foreground">
						{search.status === "background" ? (
							<Spinner
								aria-hidden="true"
								className="size-3"
							/>
						) : null}
						{search.total > BigInt(sortedItems.length) ? (
							<span>{t("driveSearchShowingOf", { shown: sortedItems.length, total: search.total.toString() })}</span>
						) : null}
					</div>
				) : null}
			</>
		)
	}

	return (
		<>
			<header className="flex h-14 shrink-0 items-center border-b border-border px-4">
				<Breadcrumb
					variant={variant}
					splat={splat}
				/>
			</header>
			<div className="flex h-12 shrink-0 items-center justify-between gap-4 border-b border-border px-4">
				{listingQuery.status === "success" && selectedItems.length > 0 ? (
					<BulkActionBar
						variant={variant}
						selectedItems={selectedItems}
						onDialogAction={handleBulkDialogAction}
					/>
				) : (
					<>
						<p className="text-sm text-muted-foreground">
							{listingQuery.status === "success" ? t("driveItemCount", { count: sortedItems.length }) : null}
						</p>
						<div className="flex items-center gap-2">
							{variant === "drive" ? (
								<SearchInput
									value={search.input}
									onChange={search.setInput}
									onClear={search.clear}
								/>
							) : null}
							<NewDirectory
								parentUuid={uuid}
								disabled={writeDisabled}
							/>
							<UploadMenu
								parentUuid={uuid}
								disabled={writeDisabled}
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
					</>
				)}
			</div>
			<UploadDropzone
				parentUuid={uuid}
				disabled={writeDisabled}
			>
				{search.active ? (
					search.status === "warming" ? (
						<div className="flex-1 overflow-y-auto">
							<ListingSkeleton viewMode={effectiveViewMode} />
						</div>
					) : search.status === "searching-empty" ? (
						<div className="flex flex-1 flex-col items-center justify-center gap-2 overflow-y-auto">
							<Spinner className="size-5 text-muted-foreground" />
							<p className="text-sm text-muted-foreground">{t("driveSearchStillSearching")}</p>
						</div>
					) : search.status === "terminal" ? (
						<div className="flex flex-1 overflow-y-auto">
							<Empty>
								<EmptyHeader>
									<EmptyMedia variant="icon">
										<CircleAlertIcon />
									</EmptyMedia>
									<EmptyTitle>{t("driveSearchUnavailable")}</EmptyTitle>
								</EmptyHeader>
							</Empty>
						</div>
					) : sortedItems.length === 0 ? (
						<div className="flex flex-1 overflow-y-auto">
							<Empty>
								<EmptyHeader>
									<EmptyMedia variant="icon">
										<SearchXIcon />
									</EmptyMedia>
									<EmptyTitle>{t("driveSearchNoResults")}</EmptyTitle>
								</EmptyHeader>
							</Empty>
						</div>
					) : (
						renderListboxContent()
					)
				) : listingQuery.status === "pending" ? (
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
					renderListboxContent()
				)}
			</UploadDropzone>
			{renderActiveDialog()}
		</>
	)
}

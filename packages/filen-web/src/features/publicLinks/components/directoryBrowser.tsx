import { useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { driveItemName, formatBytes, nameSearchKey, type CopyJobGlyph } from "@filen/shared"
import { ChevronRightIcon, DownloadIcon } from "lucide-react"
import type { AnyItemWithContext, DirPublicInfo, DirPublicLink } from "@filen/sdk-rs"
import { type DriveSortBy } from "@/features/drive/lib/sort"
import { type DriveViewMode } from "@/features/drive/lib/preferences"
import { ACTION_DEFS } from "@/features/drive/lib/actionDefs"
import { KEEP_SELECTION_PROPS } from "@/features/drive/lib/clickAway.logic"
import { SearchInput } from "@/features/drive/components/searchInput"
import { SortMenu } from "@/features/drive/components/sortMenu"
import { ViewModeToggle } from "@/features/drive/components/viewModeToggle"
import { useClickAwayDeselect } from "@/features/drive/hooks/useClickAwayDeselect"
import {
	useLinkSaveable,
	usePublicDirListing,
	usePublicDirSize,
	usePublicViewModeQuery,
	usePublicVisitorSignedIn
} from "@/features/publicLinks/queries/publicLink"
import { DEFAULT_PUBLIC_VIEW_MODE, setPublicViewMode } from "@/features/publicLinks/lib/viewMode"
import { saveSetting } from "@/lib/saveSetting"
import {
	rootCrumb,
	enterCrumb,
	enterResultCrumbs,
	jumpToCrumb,
	toBrowseEntries,
	sortEntries,
	entryKey,
	entryName,
	selectedEntries,
	selectionBytes,
	browseSaveItems,
	browseSaveGlyph,
	browseZipItems,
	DEFAULT_PUBLIC_SORT,
	EMPTY_SELECTION,
	type BrowseCrumb,
	type BrowseEntry,
	type BrowseEntryAction,
	type BrowseSelection
} from "@/features/publicLinks/lib/browse.logic"
import {
	startAnonDirZipDownload,
	startAnonFileDownload,
	startAnonItemsZipDownload,
	type AnonDownloadOutcome,
	type AnonDownloadProgress
} from "@/features/publicLinks/lib/download"
import type { ErrorDTO } from "@/lib/sdk/errors"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { linkFingerprint } from "@/features/publicLinks/lib/queryKey.logic"
import { PagedFileHero } from "@/features/publicLinks/components/pagedFileHero"
import { browsePagerList, pagerEntries, type BrowsePagerList, type FileEntry } from "@/features/publicLinks/lib/browsePager.logic"
import { linkReferences } from "@/features/publicLinks/lib/linkReferences"
import { SaveToDriveButton, SaveToDriveDialog } from "@/features/publicLinks/components/saveToDrive"
import { SaveAsArchiveButton } from "@/features/publicLinks/components/publicArchive"
import { BrowseList, type BrowseListHandle, type BrowseResume } from "@/features/publicLinks/components/browseList"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Spinner } from "@/components/ui/spinner"
import { LoadingState } from "@/components/loadingState"
import { BulkActionButton, SelectionActionBar } from "@/components/selectionActionBar"
import { DownloadTooLargeNote, PublicLinkError } from "@/features/publicLinks/components/publicLinkStates"
import { useIsOnline } from "@/lib/useIsOnline"
import { OUTSIDE_OVERLAYS, useAction } from "@/lib/keymap/useAction"
import { useReportViewing } from "@/features/publicLinks/lib/reportSubject"
import { useLinkSearch } from "@/features/publicLinks/hooks/useLinkSearch"
import type { LinkSearchScope } from "@/features/publicLinks/lib/linkSearch"

// One download at a time, the whole directory's zip ("zip") or a row's file or subdirectory, or the selection ("item").
type DownloadUiState =
	| { status: "idle" }
	| { status: "running"; kind: "zip" | "item"; loaded: number; total: number | null }
	// `forUuid`: the level the download was started on, so an outcome landing after navigation stays off another
	// directory's header. `subject`: what the too-large note names.
	| { status: "too-large"; forUuid: string; subject: DownloadSubject }
	| { status: "error"; dto: ErrorDTO; forUuid: string }

type DownloadSubject = "file" | "directory" | "selection"

interface SaveTarget {
	items: AnyItemWithContext[]
	name: string
	glyph: CopyJobGlyph
}

// The directory browse surface: a virtual navigation stack (breadcrumb clicks + folder opens mutate a
// client-side crumb array, the route/hash never change — old-web parity), a sort over the current level's
// already-fetched entries in drive's list or grid view (one choice per browser), a search of the level's whole subtree
// in its place while the field holds a query (lib/linkSearch.ts: listed once, matched in the worker), a selection over
// what is listed, and a flag-gated
// whole-directory zip download. An opened file shows the shared FileHero in-place (same session, password
// carried) rather than hard-navigating to /f/ (which would need a per-file link that does not exist), paging through
// the level's files as listed (pagerEntries), held as they were when it opened.
export function DirectoryBrowser({ info, link }: { info: DirPublicInfo; link: DirPublicLink }) {
	const { t } = useTranslation(["publicLinks", "common", "drive"])
	const isOnline = useIsOnline()
	const [stack, setStack] = useState<BrowseCrumb[]>(() => [rootCrumb(info)])
	const [selected, setSelected] = useState<{ entry: FileEntry; pager: BrowsePagerList } | null>(null)
	const [filter, setFilter] = useState("")
	const [sort, setSort] = useState<DriveSortBy>(DEFAULT_PUBLIC_SORT)
	const [selection, setSelection] = useState<BrowseSelection>(EMPTY_SELECTION)
	const [download, setDownload] = useState<DownloadUiState>({ status: "idle" })
	const [saveTarget, setSaveTarget] = useState<SaveTarget | null>(null)
	// The list unmounts under an opened file; this is where it comes back.
	const [resume, setResume] = useState<BrowseResume | null>(null)
	const listRef = useRef<BrowseListHandle>(null)

	const current = stack[stack.length - 1] ?? rootCrumb(info)
	// Asked once for the whole link: its subdirectories and files belong to whoever owns its root. A link
	// with downloads disabled offers no way to take its content, a copy included, so nothing is asked.
	const saveable = useLinkSaveable("directory", link.enableDownload ? info.root.inner.uuid : null)
	const listing = usePublicDirListing({ levelUuid: current.uuid, dir: current.dir, link })
	const sizeInfo = usePublicDirSize({ levelUuid: current.uuid, dir: current.dir, link })
	// Archive actions ask nothing of the link's owner: signed in with downloads allowed is enough.
	const signedIn = usePublicVisitorSignedIn().data === true
	const linkScope = linkFingerprint(link)
	const viewModeQuery = usePublicViewModeQuery()
	const viewMode = viewModeQuery.data ?? DEFAULT_PUBLIC_VIEW_MODE
	const { state: search, session: searchSession } = useLinkSearch(link)
	const searching = nameSearchKey(filter).length > 0
	const searchScope: LinkSearchScope = { uuid: current.uuid, dir: current.dir, ancestry: stack.map(crumb => crumb.uuid) }

	// An abuse report names where in the link the visitor is.
	useReportViewing(
		selected === null ? stack.map(crumb => crumb.name) : [...stack.map(crumb => crumb.name), driveItemName(selected.entry.item)]
	)

	const sorted = listing.data === undefined ? [] : sortEntries(toBrowseEntries(listing.data), sort)
	// A query's matches come sorted from the worker.
	const visible = searching ? (search.status === "results" ? search.entries : []) : sorted
	const picked = selectedEntries(visible, selection)
	const pickedBytes = selectionBytes(picked)

	function clearSelection(): void {
		setSelection(EMPTY_SELECTION)
	}

	// Navigating clears a finished download's notice; a running one keeps its progress.
	function dropDownloadNotice(): void {
		setDownload(prev => (prev.status === "running" ? prev : { status: "idle" }))
	}

	function changeSort(next: DriveSortBy): void {
		setSort(next)

		if (searching) {
			searchSession.search(searchScope, filter, next)
		}
	}

	function openEntry(entry: BrowseEntry): void {
		if (entry.kind === "dir") {
			// A search result's directory is reached down its trail.
			setStack(prev => (entry.trail === undefined ? enterCrumb(prev, entry) : enterResultCrumbs(prev, entry)))
			setFilter("")
			searchSession.reset()
			clearSelection()
			setSelected(null)
			setResume(null)
			dropDownloadNotice()
		} else {
			const key = entryKey(entry)
			const pager = pagerEntries(visible, link.enableDownload)

			setResume({ key, scrollOffset: listRef.current?.scrollOffset() ?? 0 })
			// A file the pager does not step onto opens alone.
			setSelected({ entry, pager: browsePagerList(pager.some(candidate => entryKey(candidate) === key) ? pager : [entry]) })
		}
	}

	// The list comes back on the file last shown when the level lists it (a slideshow's list reaches below it).
	function showEntry(entry: FileEntry, pager?: BrowsePagerList): void {
		const key = entryKey(entry)

		setSelected(prev => (prev === null ? prev : { entry, pager: pager ?? prev.pager }))

		if (visible.some(candidate => entryKey(candidate) === key)) {
			setResume(prev => (prev === null ? prev : { ...prev, key }))
		}
	}

	function jumpTo(index: number): void {
		setStack(prev => jumpToCrumb(prev, index))
		setFilter("")
		searchSession.reset()
		clearSelection()
		setSelected(null)
		setResume(null)
		dropDownloadNotice()
	}

	function runDownload(
		kind: "zip" | "item",
		subject: DownloadSubject,
		start: (onProgress: AnonDownloadProgress) => Promise<AnonDownloadOutcome>
	): void {
		const forUuid = current.uuid

		setDownload({ status: "running", kind, loaded: 0, total: null })

		void start((loaded, total) => {
			setDownload(prev => (prev.status === "running" ? { ...prev, loaded, total } : prev))
		}).then(outcome => {
			setDownload(
				outcome.status === "error"
					? { status: "error", dto: outcome.dto, forUuid }
					: outcome.status === "too-large"
						? { status: "too-large", forUuid, subject }
						: { status: "idle" }
			)
		})
	}

	function handleZip(): void {
		runDownload("zip", "directory", onProgress =>
			startAnonDirZipDownload({ dir: { dir: current.dir, link }, name: current.name, onProgress })
		)
	}

	function handleEntryAction(entry: BrowseEntry, action: BrowseEntryAction): void {
		if (action === "open") {
			openEntry(entry)
		} else if (action === "saveToDrive") {
			setSaveTarget({ items: browseSaveItems([entry], link), name: entryName(entry), glyph: browseSaveGlyph([entry]) })
		} else if (download.status !== "running") {
			const name = entryName(entry)

			runDownload("item", entry.kind === "file" ? "file" : "directory", onProgress =>
				entry.kind === "file"
					? startAnonFileDownload({ file: entry.file, name, size: entry.file.size, linkScope, onProgress })
					: startAnonDirZipDownload({ dir: { dir: entry.dir, link }, name, onProgress })
			)
		}
	}

	// A single entry downloads as its row menu does; more, as one zip named after the level on screen.
	function handleDownloadSelected(): void {
		const [only] = picked

		if (only !== undefined && picked.length === 1) {
			handleEntryAction(only, "download")
		} else {
			runDownload("item", "selection", onProgress =>
				startAnonItemsZipDownload({ items: browseZipItems(picked), link, name: current.name, onProgress })
			)
		}
	}

	async function applyViewMode(next: DriveViewMode): Promise<void> {
		if (next !== viewMode && (await saveSetting(() => setPublicViewMode(next)))) {
			await viewModeQuery.refetch()
		}
	}

	// A plain click on empty space anywhere in the window drops the selection, as in drive.
	useClickAwayDeselect(selected === null && selection.size > 0, clearSelection)

	// Defs in features/publicLinks/lib/keymap.ts. Every one stands down under a dialog or menu and in a text field.
	// Escape (PagedFileHero's) and Alt+↑ leave an opened file for its directory, Alt+↑ goes up a level from there; / (the
	// filter box's own) and Mod+S act on the directory on screen (the opened file takes its own Mod+S).
	useAction(
		"links.up",
		event => {
			event.preventDefault()

			if (selected !== null) {
				setSelected(null)
			} else if (stack.length > 1) {
				jumpTo(stack.length - 2)
			}
		},
		OUTSIDE_OVERLAYS,
		[selected, stack.length]
	)

	useAction(
		"links.download",
		event => {
			event.preventDefault()

			if (download.status !== "running") {
				handleZip()
			}
		},
		{ ...OUTSIDE_OVERLAYS, enabled: selected === null && link.enableDownload },
		[download.status, current, link]
	)

	// Drive's own selection keys over the level on screen.
	useAction(
		"drive.selectAll",
		event => {
			event.preventDefault()
			setSelection(new Set(visible.map(entryKey)))
		},
		{ ...OUTSIDE_OVERLAYS, enabled: selected === null && visible.length > 0 },
		[visible]
	)

	useAction("drive.clearSelection", clearSelection, { ...OUTSIDE_OVERLAYS, enabled: selected === null && selection.size > 0 })

	// Drive's own view keys (unbound by default) over the listing.
	useAction(
		"drive.listView",
		event => {
			event.preventDefault()
			void applyViewMode("list")
		},
		{ ...OUTSIDE_OVERLAYS, enabled: selected === null }
	)

	useAction(
		"drive.gridView",
		event => {
			event.preventDefault()
			void applyViewMode("grid")
		},
		{ ...OUTSIDE_OVERLAYS, enabled: selected === null }
	)

	// An opened child file takes over the whole surface (it carries its own back bar); the browse chrome
	// returns when it is dismissed, its list resumed (scroll, cursor, focus) rather than kept mounted out of sight.
	if (selected !== null) {
		return (
			<PagedFileHero
				entry={selected.entry}
				pager={selected.pager}
				onStep={showEntry}
				onPagerReplaced={(pager, entry) => {
					showEntry(entry, pager)
				}}
				onBack={() => {
					setSelected(null)
				}}
				link={link}
				// A search's results: no subdirectories to add to them.
				source={searching ? undefined : { kind: "linked", dir: current.dir, link }}
				downloadEnabled={link.enableDownload}
				linkScope={linkScope}
				saveItem={saveable ? selected.entry.file : undefined}
				siblings={sorted.map(entry => entry.item)}
				references={linkReferences(sorted, link)}
			/>
		)
	}

	const summary =
		sizeInfo.data !== undefined
			? t("itemSummary", {
					count: Number(sizeInfo.data.files) + Number(sizeInfo.data.dirs),
					size: formatBytes(Number(sizeInfo.data.size))
				})
			: null
	// The list's pane: the search's results while the field holds a query, else the level's listing.
	const pane = searching
		? search.status === "error"
			? "error"
			: search.status === "results"
				? "ready"
				: "loading"
		: listing.status === "pending"
			? "loading"
			: listing.status === "error"
				? "error"
				: "ready"
	const downloadNotice =
		download.status !== "idle" && download.status !== "running" && download.forUuid === current.uuid ? download : null

	// Fills the page's main and no more, the list scrolling its rows; with no min-h-0 it stays its content's height
	// where the page has less room than the list's floor, and main scrolls instead.
	return (
		<div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-3 px-4 pt-4 pb-3 sm:px-6 sm:pt-6">
			<Breadcrumbs
				stack={stack}
				onJump={jumpTo}
			/>

			<div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
				<div className="flex min-w-0 flex-col">
					<h1 className="truncate text-lg font-semibold">{current.name}</h1>
					{summary !== null && <p className="text-xs text-muted-foreground">{summary}</p>}
				</div>
				<div className="flex flex-wrap items-center gap-2">
					{/* The directory on screen, the link's root or a subdirectory of it. */}
					{saveable ? (
						<SaveToDriveButton
							item={{ dir: current.dir, link }}
							name={current.name}
							glyph="directory"
							compact
						/>
					) : null}
					{signedIn && link.enableDownload ? (
						<SaveAsArchiveButton
							item={{ dir: current.dir, link }}
							name={current.name}
							compact
						/>
					) : null}
					{link.enableDownload && (
						<Button
							variant="outline"
							size="sm"
							onClick={handleZip}
							disabled={download.status === "running"}
						>
							{download.status === "running" && download.kind === "zip" ? (
								<Spinner data-icon="inline-start" />
							) : (
								<DownloadIcon data-icon="inline-start" />
							)}
							{download.status === "running" && download.kind === "zip" ? t("preparingDownload") : t("downloadDirectory")}
						</Button>
					)}
				</div>
			</div>

			{download.status === "running" && (
				<Progress
					aria-label={download.kind === "zip" ? t("preparingDownload") : t("downloading")}
					value={download.total !== null && download.total > 0 ? Math.round((download.loaded / download.total) * 100) : null}
				/>
			)}
			{downloadNotice?.status === "too-large" && (
				<DownloadTooLargeNote
					message={
						downloadNotice.subject === "file"
							? t("downloadTooLarge")
							: downloadNotice.subject === "directory"
								? t("downloadDirectoryTooLarge")
								: t("downloadSelectionTooLarge")
					}
				/>
			)}
			{downloadNotice?.status === "error" && (
				<p
					role="alert"
					className="text-sm text-destructive"
				>{`${t("downloadFailed")} ${errorLabel(downloadNotice.dto)}`}</p>
			)}

			<div className="flex shrink-0 items-center gap-2">
				<SearchInput
					action="links.filter"
					label={t("filterPlaceholder")}
					value={filter}
					onChange={value => {
						setFilter(value)
						clearSelection()
						searchSession.search(searchScope, value, sort)
					}}
					onClear={() => {
						setFilter("")
						clearSelection()
						searchSession.reset()
					}}
					onFocusList={() => {
						listRef.current?.focusCursor()
					}}
				/>
				<div className="ml-auto flex items-center gap-2">
					{/* The list's column header sorts from sm up, where its Size and Modified columns show; the grid has none. */}
					<div className={viewMode === "list" ? "sm:hidden" : undefined}>
						<SortMenu
							value={sort}
							onChange={changeSort}
						/>
					</div>
					<ViewModeToggle
						value={viewMode}
						onChange={next => {
							void applyViewMode(next)
						}}
					/>
				</div>
			</div>

			{searching && search.status === "listing" ? (
				<div className="flex shrink-0 flex-col gap-1.5">
					<p className="text-xs text-muted-foreground">{t("searchingSubdirectories")}</p>
					<Progress
						aria-label={t("searchingSubdirectories")}
						value={search.total !== null && search.total > 0 ? Math.round((search.loaded / search.total) * 100) : null}
					/>
				</div>
			) : searching && search.status === "results" && search.total > search.entries.length ? (
				<p className="shrink-0 text-xs text-muted-foreground">
					{t("drive:driveSearchShowingOf", { shown: search.entries.length, total: search.total })}
				</p>
			) : null}

			{/* Never below the header and a few rows. Size containment keeps the rows' own height out of the page's: the
			    floor is all the list asks of it. */}
			<div className="flex min-h-60 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-background contain-size">
				{pane === "loading" ? (
					<LoadingState size="md" />
				) : pane === "error" ? (
					<div className="flex flex-1 overflow-y-auto">
						<PublicLinkError
							onRetry={() => {
								if (searching) {
									searchSession.search(searchScope, filter, sort)
								} else {
									void listing.refetch()
								}
							}}
						/>
					</div>
				) : visible.length === 0 ? (
					<div className="flex flex-1 items-center justify-center overflow-y-auto p-6 text-center text-sm text-muted-foreground">
						{searching ? t("noMatches") : t("emptyDirectory")}
					</div>
				) : (
					<BrowseList
						// Remounted per level, per view and between the listing and a search's results, which lays its rows
						// out anew.
						key={`${current.uuid}:${viewMode}:${searching ? "search" : "listing"}`}
						ref={listRef}
						resume={resume}
						onResumed={() => {
							setResume(null)
						}}
						entries={visible}
						selection={selection}
						onSelectionChange={setSelection}
						sort={sort}
						onSortChange={changeSort}
						viewMode={viewMode}
						linkScope={linkScope}
						downloadable={link.enableDownload}
						downloadBusy={download.status === "running"}
						saveable={saveable}
						onOpen={openEntry}
						onAction={handleEntryAction}
					/>
				)}
			</div>

			{picked.length > 0 ? (
				<div className="flex shrink-0 justify-center">
					<SelectionActionBar
						count={picked.length}
						countLabel={
							pickedBytes === null
								? undefined
								: t("selectedSummary", { count: picked.length, size: formatBytes(Number(pickedBytes)) })
						}
						clearKbdAction="drive.clearSelection"
						onClear={clearSelection}
					>
						{link.enableDownload ? (
							<BulkActionButton
								icon={ACTION_DEFS.download.icon}
								label={t("download")}
								disabled={download.status === "running"}
								onClick={handleDownloadSelected}
							/>
						) : null}
						{saveable ? (
							<BulkActionButton
								icon={ACTION_DEFS.copy.icon}
								label={t("saveToDrive")}
								disabled={!isOnline}
								disabledReason={isOnline ? undefined : t("common:offlineActionDisabled")}
								onClick={() => {
									setSaveTarget({
										items: browseSaveItems(picked, link),
										name: picked[0] === undefined ? current.name : entryName(picked[0]),
										glyph: browseSaveGlyph(picked)
									})
								}}
							/>
						) : null}
					</SelectionActionBar>
				</div>
			) : null}

			{saveTarget !== null ? (
				<SaveToDriveDialog
					items={saveTarget.items}
					name={saveTarget.name}
					glyph={saveTarget.glyph}
					onClose={() => {
						setSaveTarget(null)
					}}
				/>
			) : null}
		</div>
	)
}

function Breadcrumbs({ stack, onJump }: { stack: BrowseCrumb[]; onJump: (index: number) => void }) {
	const { t } = useTranslation("publicLinks")

	return (
		<nav
			aria-label={t("publicLinksBreadcrumbLabel")}
			className="flex shrink-0 flex-wrap items-center gap-1 text-sm text-muted-foreground"
			{...KEEP_SELECTION_PROPS}
		>
			{stack.map((crumb, index) => {
				const isLast = index === stack.length - 1

				return (
					<span
						key={crumb.uuid}
						className="flex items-center gap-1"
					>
						{index > 0 && <ChevronRightIcon className="size-3.5 shrink-0" />}
						{isLast ? (
							<span
								aria-current="location"
								className="max-w-[12rem] truncate font-medium text-foreground"
							>
								{crumb.name}
							</span>
						) : (
							<button
								type="button"
								onClick={() => {
									onJump(index)
								}}
								className="max-w-[10rem] truncate rounded-md px-1 focus-ring-row transition-colors outline-none hover:text-foreground"
							>
								{crumb.name}
							</button>
						)}
					</span>
				)
			})}
		</nav>
	)
}

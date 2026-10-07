import { useId, useRef, useState, type MouseEvent } from "react"
import { useTranslation } from "react-i18next"
import type { DriveItem } from "@/features/drive/lib/item"
import type { DriveVariant } from "@/features/drive/lib/preferences"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { useIsOnline } from "@/lib/useIsOnline"
import { usePreviewDownloadable } from "@/features/preview/lib/accessMode"
import { archiveSourceOf, type ArchiveSource } from "@/features/archive/lib/archiveSource"
import type { EntryStore } from "@/features/archive/lib/entryStore"
import type { ListingDeps } from "@/features/archive/lib/listingSession"
import { SEARCH_CAP } from "@/features/archive/lib/search"
import {
	commonBaseDir,
	fullExtractRequest,
	resolveSelection,
	selectionExtractRequest,
	selectionNeedsPassword,
	startBrowserExtract,
	targetDestination,
	type ExtractTarget,
	type ResolvedSelection
} from "@/features/archive/lib/extractSelection"
import { EMPTY_SELECTION, selectAll, setMany, toggle, type Selection } from "@/features/archive/lib/selection"
import { dirOfRef, dirRef, isDirRef, type ChildSort, type ChildSortKey, type RowRef } from "@/features/archive/lib/sortedChildren"
import {
	ARCHIVE_PROGRESS_DELAY_MS,
	ARCHIVE_SPINNER_DELAY_MS,
	ARCHIVE_VISIBLE_CRUMBS,
	canExtractSelection,
	crumbTrail,
	cursorTarget,
	directoryRows,
	dirOfPath,
	dirSelectable,
	failureLabelKey,
	headerCheck,
	holdsSlot,
	positionIndex,
	readsWholeArchive,
	refsView,
	rowRange,
	selectionTotalsOf,
	splitCrumbs,
	summaryOf,
	type BrowserKeyAction,
	type RowPosition
} from "@/features/archive/lib/archiveBrowser.logic"
import { useArchiveListing } from "@/features/archive/components/useArchiveListing"
import { useArchiveSearch } from "@/features/archive/components/useArchiveSearch"
import { ArchiveGate } from "@/features/archive/components/archiveGate"
import { ArchiveReading, ArchiveStatus, ArchiveWaiting, Delayed } from "@/features/archive/components/archiveStatus"
import { ArchiveToolbar } from "@/features/archive/components/archiveToolbar"
import { ArchiveEntryList } from "@/features/archive/components/archiveEntryList"
import { ArchiveFooter } from "@/features/archive/components/archiveFooter"
import { ArchivePasswordGate, ArchivePasswordPrompt } from "@/features/archive/components/archivePasswordPrompt"
import { ArchiveLinkTargetsDialog } from "@/features/archive/components/archiveLinkTargetsDialog"
import { ArchiveExtractPicker } from "@/features/archive/components/archiveExtractMenu"
import { ArchiveEntryViewer } from "@/features/archive/components/archiveEntryViewer"
import { useEntryActions, type EntryTarget } from "@/features/archive/components/useEntryActions"
import { EntryMenuContext, type EntryMenuAction, type EntryMenuHost } from "@/features/archive/lib/entryMenu"
import { PreviewErrorState, PreviewLoading } from "@/features/preview/components/previewErrorState"
import { LoadingState } from "@/components/loadingState"

interface PendingExtract {
	target: ExtractTarget
	resolved: ResolvedSelection
	baseDir: number
}

interface LinkTargetsAsk extends PendingExtract {
	resolved: Extract<ResolvedSelection, { kind: "entries" }>
	// The directory holding the base and every target outside it.
	common: number
	// The selection without those links; null when nothing would be left to extract.
	leaveOut: Selection | null
}

interface PasswordAsk {
	wrong: boolean
	// The extract to start once the password checks out; null when asked from the listing's banner.
	extract: PendingExtract | null
}

const DEFAULT_SORT: ChildSort = { key: "name", descending: false }
const NO_REFS = new Int32Array(0)

export interface ArchiveBrowserProps {
	item: DriveItem
	variant: DriveVariant
}

// The preview overlay's body for an archive.
export function ArchiveBrowser({ item, variant }: ArchiveBrowserProps) {
	const source = archiveSourceOf(item, variant)

	return (
		<ArchiveSourceBrowser
			key={source.uuid}
			source={source}
		/>
	)
}

export interface ArchiveSourceBrowserProps {
	source: ArchiveSource
	// Another listing transport (a public link's).
	deps?: ListingDeps | undefined
}

// The archive's directories, browsed and searched, with an extract of the selection or of everything.
// The selection's base is the directory shown (owner decision), so navigating clears it; extracts land in
// the user's own drive whatever the archive's source.
export function ArchiveSourceBrowser({ source, deps }: ArchiveSourceBrowserProps) {
	const { t } = useTranslation(["preview", "drive", "common"])
	const isOnline = useIsOnline()
	// A public link that allows no downloads can still be browsed, but nothing leaves it.
	const downloadable = usePreviewDownloadable()
	const listId = useId()
	const searchBoxRef = useRef<HTMLDivElement>(null)
	const listing = useArchiveListing(source, deps)
	const { snapshot } = listing
	const { phase, store, info } = snapshot
	// Every hook before anything derived: a value computed across a hook call loses its memo.
	const [path, setPath] = useState(listing.restoredDirPath)
	const [sort, setSort] = useState<ChildSort>(DEFAULT_SORT)
	const [query, setQuery] = useState("")
	// Per store: a new listing run (List again, a password) starts from nothing.
	const [picked, setPicked] = useState<{ store: EntryStore; selection: Selection }>(() => ({ store, selection: EMPTY_SELECTION }))
	const [cursor, setCursor] = useState<RowPosition | null>(null)
	const [anchor, setAnchor] = useState<RowPosition | null>(null)
	const [passwordAsk, setPasswordAsk] = useState<PasswordAsk | null>(null)
	const [linkAsk, setLinkAsk] = useState<LinkTargetsAsk | null>(null)
	// A row's "Choose destination…", kept here: the row may unmount while the picker is open.
	const [rowPick, setRowPick] = useState<EntryTarget | null>(null)
	const [viewStore, setViewStore] = useState(store)
	const entries = useEntryActions({ source, session: listing.session, downloadable, isOnline })
	// Ends the wait for a password check that an extract is waiting on.
	const pendingCheck = useRef<(() => void) | null>(null)

	// A new run (List again, a password) lists into a fresh store: the view starts over at its root. A
	// store replacing one that holds nothing (the placeholder before the session opened, a run that read
	// nothing) loses nothing, and keeps where a cached listing reopens.
	if (viewStore !== store) {
		setViewStore(store)

		if (viewStore.entryCount > 0) {
			setPath("")
			setCursor(null)
			setAnchor(null)
		}
	}

	const dir = dirOfPath(snapshot, path)
	const search = useArchiveSearch(snapshot, dir, query)
	const summary = summaryOf(phase)
	const searchMode = query.trim() !== ""
	const searchRefs = searchMode ? (search.shown?.refs ?? NO_REFS) : null
	const rows = searchRefs === null ? directoryRows(snapshot, dir, sort) : refsView(searchRefs)
	const selection = picked.store === store ? picked.selection : EMPTY_SELECTION
	const format = summary?.format ?? info?.format ?? null
	const single = format?.type === "single"
	const dirName = dir === 0 ? source.name : store.dirName(dir)
	const baseFolderName = dir === 0 ? (info?.defaultName ?? source.name) : store.dirName(dir)
	const totals = selectionTotalsOf(snapshot, selection)
	const extractOff = info === null || !isOnline || !downloadable
	const notAllowed = downloadable ? undefined : t("previewArchiveExtractNotAllowed")
	const extractOffTitle = notAllowed ?? (isOnline ? undefined : t("common:offlineActionDisabled"))
	const { hidden, shown } = splitCrumbs(crumbTrail(store, dir), ARCHIVE_VISIBLE_CRUMBS)

	// Resolved when a handler runs, not in render, where the React Compiler would memoize the rows together
	// with the cursor: every cursor step would hand the virtualizer new rows.
	function cursorIndexNow(): number {
		return positionIndex(rows, cursor)
	}

	function anchorIndexNow(): number {
		return anchor === null ? cursorIndexNow() : positionIndex(rows, anchor)
	}

	function select(next: Selection): void {
		setPicked({ store, selection: next })
	}

	function placeCursor(position: RowPosition | null, moveAnchor: boolean): void {
		setCursor(position)

		if (moveAnchor) {
			setAnchor(position)
		}
	}

	function navigate(target: number, focus: RowRef | null): void {
		const nextPath = store.dirPath(target)

		setPath(nextPath)
		listing.session()?.rememberDirPath(nextPath)
		select(EMPTY_SELECTION)
		setQuery("")
		placeCursor(focus === null ? null : { ref: focus, index: -1 }, true)
	}

	function goParent(): void {
		if (dir !== 0) {
			navigate(store.dirParent(dir), dirRef(dir))
		}
	}

	// Rows `from` to `to`, and only those; the whole directory is one rule.
	function rangeSelection(from: number, to: number): Selection {
		if (searchRefs === null && Math.min(from, to) === 0 && Math.max(from, to) === rows.count - 1) {
			return selectAll(store, dir)
		}

		return setMany(store, EMPTY_SELECTION, rowRange(rows, from, to), true)
	}

	function toggleAt(index: number): void {
		if (index < 0) {
			return
		}

		const ref = rows.at(index)

		select(toggle(store, selection, ref))
		placeCursor({ ref, index }, true)
	}

	// Like the drive listing: a click selects only that row (or clears it when it was all there was),
	// mod-click toggles, shift-click selects the range from the anchor.
	function handlePointer(index: number, ref: RowRef, event: MouseEvent<HTMLDivElement>): void {
		const position = { ref, index }

		if (event.shiftKey) {
			const anchorIndex = anchorIndexNow()

			select(rangeSelection(anchorIndex < 0 ? index : anchorIndex, index))
			placeCursor(position, false)

			return
		}

		if (event.metaKey || event.ctrlKey) {
			select(toggle(store, selection, ref))
		} else {
			const sole = selection.rules.size === 1 && selection.rules.get(ref) === true

			select(sole && event.detail === 1 ? EMPTY_SELECTION : toggle(store, EMPTY_SELECTION, ref))
		}

		placeCursor(position, true)
	}

	// A directory opens; a file previews when it can, else it is saved.
	function handleOpen(ref: RowRef): void {
		if (isDirRef(ref)) {
			navigate(dirOfRef(ref), null)
		} else {
			entries.activate({ store, slot: ref })
		}
	}

	function handleKeyAction(action: BrowserKeyAction, pageSize: number): number | null {
		const cursorIndex = cursorIndexNow()

		switch (action.type) {
			case "move": {
				const next = cursorTarget(action.move, Math.max(cursorIndex, 0), rows.count, pageSize)

				if (next === null) {
					return null
				}

				const position = { ref: rows.at(next), index: next }

				if (action.extend) {
					const anchorIndex = anchorIndexNow()

					select(rangeSelection(anchorIndex < 0 ? next : anchorIndex, next))
				}

				placeCursor(position, !action.extend)

				return next
			}
			case "open": {
				if (cursorIndex < 0) {
					return null
				}

				const ref = rows.at(cursorIndex)

				if (isDirRef(ref)) {
					navigate(dirOfRef(ref), null)
				} else if (!entries.activate({ store, slot: ref })) {
					toggleAt(cursorIndex)
				}

				return null
			}
			case "toggle":
				toggleAt(cursorIndex)

				return null
			case "parent":
				goParent()

				return null
			case "selectAll":
				select(searchRefs === null ? selectAll(store, dir) : setMany(store, selection, searchRefs, true))

				return null
			case "clear":
				select(EMPTY_SELECTION)

				return null
			case "focusSearch":
				searchBoxRef.current?.querySelector("input")?.focus()

				return null
		}
	}

	// In search mode only the matches change: the rest of the selection stays.
	function handleHeaderCheck(): void {
		const on = headerCheck(snapshot, selection, dir, searchRefs) === "on"

		if (searchRefs !== null) {
			select(setMany(store, selection, searchRefs, !on))
		} else {
			select(on ? EMPTY_SELECTION : selectAll(store, dir))
		}
	}

	function handleSort(key: ChildSortKey): void {
		setSort(sort.key === key ? { key, descending: !sort.descending } : { key, descending: false })
		placeCursor(null, true)
	}

	function handleQueryChange(next: string): void {
		setQuery(next)
		placeCursor(null, true)
	}

	function startExtract({ target, resolved, baseDir }: PendingExtract): void {
		const session = listing.session()

		if (session === null || info === null) {
			return
		}

		const destination = targetDestination(source, target, t("drive:driveMyDrive"))

		if (destination === null) {
			return
		}

		const input = { source, info, summary, target, destination }

		startBrowserExtract(
			session,
			resolved.kind === "all" ? fullExtractRequest(input) : selectionExtractRequest(input, store, resolved, baseDir)
		)
	}

	// An extract naming encrypted entries the listing has no password for asks for it first, and checks it
	// against the entries shown; one the listing can't check (still running, or failed) asks when it runs.
	function proceed(pending: PendingExtract): void {
		const session = listing.session()
		const verifiable = (phase.type === "done" || phase.type === "stopped") && store.entryCount > 0

		if (session !== null && verifiable && selectionNeedsPassword(pending.resolved, summary, session.password())) {
			setPasswordAsk({ wrong: summary?.password === "wrong", extract: pending })

			return
		}

		startExtract(pending)
	}

	function resolveAt(next: Selection, baseDir: number): ResolvedSelection {
		return resolveSelection(store, next, baseDir, format?.type ?? null, phase.type === "done")
	}

	function extractResolved(target: ExtractTarget, from: Selection, baseDir: number): void {
		const resolved = resolveAt(from, baseDir)

		if (resolved.kind === "entries") {
			if (resolved.indexes.length === 0) {
				return
			}

			if (resolved.outsideBase.length > 0) {
				const leaveOut = setMany(store, from, resolved.outsideLinks, false)
				const rest = resolveAt(leaveOut, baseDir)

				setLinkAsk({
					target,
					resolved,
					baseDir,
					common: commonBaseDir(store, baseDir, resolved.outsideBase),
					leaveOut: rest.kind === "entries" && rest.indexes.length === 0 ? null : leaveOut
				})

				return
			}
		}

		proceed({ target, resolved, baseDir })
	}

	function extractSelected(target: ExtractTarget): void {
		extractResolved(target, selection, dir)
	}

	// A row's own Extract: that entry alone, from the directory shown.
	function extractEntry(target: ExtractTarget, entry: EntryTarget): void {
		if (entry.store === store) {
			extractResolved(target, toggle(store, EMPTY_SELECTION, entry.slot), dir)
		}
	}

	function handleEntryMenu(slot: number, action: EntryMenuAction): void {
		const entry = { store, slot }

		switch (action.type) {
			case "open":
			case "download":
				entries.request(entry, action.type)

				break
			case "extract":
				extractEntry(action.target, entry)

				break
			case "chooseDestination":
				setRowPick(entry)

				break
		}
	}

	// The listing holds the page's one archive slot, which the extract needs: it stops first.
	function extractAll(target: ExtractTarget): void {
		if (holdsSlot(phase)) {
			listing.session()?.stop()
		}

		proceed({ target, resolved: { kind: "all" }, baseDir: 0 })
	}

	function leaveLinksOut({ target, baseDir, leaveOut }: LinkTargetsAsk): void {
		if (leaveOut === null) {
			return
		}

		setLinkAsk(null)
		select(leaveOut)
		extractResolved(target, leaveOut, baseDir)
	}

	function extractFromCommon(ask: LinkTargetsAsk): void {
		setLinkAsk(null)
		proceed({ target: ask.target, resolved: resolveAt(selection, ask.common), baseDir: ask.common })
	}

	// The password is checked by relisting; the waiting extract starts once it is accepted, or asks again.
	function submitPassword(password: string): void {
		const session = listing.session()
		const pending = passwordAsk?.extract ?? null

		setPasswordAsk(null)

		if (session === null) {
			return
		}

		session.submitPassword(password)

		if (pending === null) {
			return
		}

		pendingCheck.current?.()

		const unsubscribe = session.subscribe(() => {
			const current = summaryOf(session.getSnapshot().phase)

			if (current === null || current.verifying) {
				return
			}

			unsubscribe()
			pendingCheck.current = null

			if (session.password() !== undefined) {
				startExtract(pending)
			} else if (current.verifyError === null) {
				setPasswordAsk({ wrong: true, extract: pending })
			}
		})

		pendingCheck.current = unsubscribe
	}

	// A cancelled check starts no extract and asks nothing again.
	function cancelCheck(): void {
		pendingCheck.current?.()
		pendingCheck.current = null
		listing.session()?.stop()
	}

	const viewing = entries.viewing

	if (viewing !== null) {
		return (
			<>
				<ArchiveEntryViewer
					archiveUuid={source.uuid}
					entry={viewing.entry}
					password={viewing.password}
					onPasswordAccepted={password => {
						listing.session()?.acceptPassword(password)
					}}
					onDownload={
						downloadable
							? () => {
									entries.request(viewing, "download")
								}
							: null
					}
					onBack={entries.closeViewer}
				/>
				{entries.dialogs}
			</>
		)
	}

	if (phase.type === "gate") {
		return (
			<ArchiveGate
				source={source}
				format={phase.format}
				newFolderName={single ? null : (info?.defaultName ?? source.name)}
				extractDisabled={extractOff}
				extractDisabledTitle={extractOffTitle}
				note={notAllowed}
				onBrowse={() => {
					listing.session()?.start()
				}}
				onExtractAll={extractAll}
			/>
		)
	}

	if (phase.type === "needsPassword") {
		return (
			<ArchivePasswordGate
				name={source.name}
				wrong={phase.wrong}
				onSubmit={password => {
					listing.session()?.submitPassword(password)
				}}
			/>
		)
	}

	if (phase.type === "waiting") {
		return (
			<ArchiveWaiting
				onCancel={() => {
					listing.session()?.stop()
				}}
			/>
		)
	}

	if ((phase.type === "resolving" || phase.type === "starting") && store.entryCount === 0) {
		return (
			<Delayed ms={ARCHIVE_SPINNER_DELAY_MS}>
				<PreviewLoading />
			</Delayed>
		)
	}

	if (phase.type === "failed" && store.entryCount === 0) {
		const failureKey = failureLabelKey(phase.error)

		return (
			<PreviewErrorState
				message={failureKey === null ? errorLabel(phase.error) : t(failureKey)}
				onRetry={() => {
					listing.session()?.retry()
				}}
			/>
		)
	}

	const menuHost: EntryMenuHost = {
		source,
		newFolderName: single ? null : baseFolderName,
		extractDisabled: extractOff || !canExtractSelection(phase, store.entryCount),
		offers: slot => entries.offers({ store, slot }),
		onAction: handleEntryMenu
	}
	const running = holdsSlot(phase) || phase.type === "resolving"
	const empty =
		searchRefs !== null ? (
			search.shown === null || (search.pending && search.shown.refs.length === 0) ? (
				<LoadingState size="sm" />
			) : (
				<p className="px-6 py-10 text-center text-sm text-muted-foreground">
					{t("previewArchiveNoResults", { query: search.shown.query })}
				</p>
			)
		) : running ? (
			<LoadingState size="sm" />
		) : (
			<p className="px-6 py-10 text-center text-sm text-muted-foreground">
				{t(store.entryCount === 0 ? "previewArchiveEmpty" : "previewArchiveDirectoryEmpty")}
			</p>
		)

	return (
		<div className="flex size-full flex-col">
			<ArchiveToolbar
				rootName={source.name}
				shown={shown.map(id => ({ id, name: store.dirName(id) }))}
				hidden={hidden.map(id => ({ id, name: store.dirName(id) }))}
				query={query}
				searchBoxRef={searchBoxRef}
				onNavigate={target => {
					if (target !== dir || searchMode) {
						navigate(target, null)
					}
				}}
				onQueryChange={handleQueryChange}
			/>
			{phase.type === "reading" ? (
				<Delayed ms={ARCHIVE_PROGRESS_DELAY_MS}>
					<ArchiveReading
						phase={phase}
						wholeArchive={readsWholeArchive(format)}
						onStop={() => {
							listing.session()?.stop()
						}}
					/>
				</Delayed>
			) : null}
			<ArchiveStatus
				phase={phase}
				summary={summary}
				entries={store.entryCount}
				onListAgain={() => {
					listing.session()?.retry()
				}}
				onEnterPassword={() => {
					setPasswordAsk({ wrong: summary?.password === "wrong", extract: null })
				}}
				onCancelCheck={cancelCheck}
			/>
			{searchRefs !== null && search.shown?.truncated === true ? (
				<p className="shrink-0 border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
					{t("previewArchiveSearchTruncated", { count: SEARCH_CAP })}
				</p>
			) : null}
			<EntryMenuContext value={menuHost}>
				<ArchiveEntryList
					listId={listId}
					label={t("previewArchiveListLabel", { name: dirName })}
					viewKey={`${String(dir)}:${searchMode ? "search" : "dir"}`}
					snapshot={snapshot}
					rows={rows}
					selection={selection}
					cursor={cursor}
					searchMode={searchMode}
					sort={sort}
					headerCheck={headerCheck(snapshot, selection, dir, searchRefs)}
					headerDisabled={searchRefs === null ? !dirSelectable(snapshot, dir) : searchRefs.length === 0}
					empty={empty}
					onSort={handleSort}
					onHeaderCheck={handleHeaderCheck}
					onKeyAction={handleKeyAction}
					onPointer={handlePointer}
					onOpen={handleOpen}
					onCheck={toggleAt}
				/>
			</EntryMenuContext>
			<ArchiveFooter
				source={source}
				totals={totals}
				selectedFolderName={single ? null : baseFolderName}
				allFolderName={single ? null : (info?.defaultName ?? source.name)}
				selectedDisabled={extractOff || !canExtractSelection(phase, store.entryCount) || totals.entries === 0}
				allDisabled={extractOff}
				disabledTitle={extractOffTitle}
				note={notAllowed}
				onExtractSelected={extractSelected}
				onExtractAll={extractAll}
			/>
			<ArchivePasswordPrompt
				open={passwordAsk !== null}
				name={source.name}
				wrong={passwordAsk?.wrong ?? false}
				onOpenChange={open => {
					if (!open) {
						setPasswordAsk(null)
					}
				}}
				onSubmit={submitPassword}
			/>
			{entries.dialogs}
			{rowPick === null ? null : (
				<ArchiveExtractPicker
					onPick={target => {
						extractEntry(target, rowPick)
					}}
					onClose={() => {
						setRowPick(null)
					}}
				/>
			)}
			{linkAsk === null ? null : (
				<ArchiveLinkTargetsDialog
					open
					count={linkAsk.resolved.outsideLinks.length}
					baseName={dirName}
					parentName={linkAsk.common === 0 ? source.name : store.dirName(linkAsk.common)}
					onLeaveOut={
						linkAsk.leaveOut === null
							? undefined
							: () => {
									leaveLinksOut(linkAsk)
								}
					}
					onFromParent={() => {
						extractFromCommon(linkAsk)
					}}
					onCancel={() => {
						setLinkAsk(null)
					}}
				/>
			)}
		</div>
	)
}

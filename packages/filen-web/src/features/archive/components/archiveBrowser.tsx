import { useEffect, useEffectEvent, useId, useRef, useState, type MouseEvent, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { formatBytes } from "@filen/shared"
import { isImeKeydown, matchesCombo } from "@filen/shared/keymap"
import { isRecordingCombo, useBindings } from "@/lib/keymap/registry"
import { isMacPlatform } from "@/lib/keymap/kbd.logic"
import { bindingOf } from "@/lib/keymap/bindingOf"
import { ARCHIVE_ACTIONS } from "@/features/archive/lib/keymap"
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
import {
	dirOfRef,
	dirRef,
	isDirRef,
	type ChildSort,
	type ChildSortKey,
	type RowRef,
	type RowView
} from "@/features/archive/lib/sortedChildren"
import {
	ARCHIVE_PROGRESS_DELAY_MS,
	ARCHIVE_SPINNER_DELAY_MS,
	ARCHIVE_VISIBLE_CRUMBS,
	canExtractSelection,
	crumbTrail,
	cursorTarget,
	defaultExtractTarget,
	directoryRows,
	dirOfPath,
	dirSelectable,
	failureLabelKey,
	headerCheck,
	holdsSlot,
	positionIndex,
	readingRowOf,
	readsWholeArchive,
	refsView,
	marqueeSelection,
	rangeSelection,
	rowMenuOf,
	rowMenuSelection,
	selectionTotalsOf,
	splitCrumbs,
	summaryOf,
	type BrowserListKeyAction,
	type RowPosition
} from "@/features/archive/lib/archiveBrowser.logic"
import { useArchiveListing } from "@/features/archive/components/useArchiveListing"
import { useArchiveSearch } from "@/features/archive/components/useArchiveSearch"
import { ArchiveGate } from "@/features/archive/components/archiveGate"
import { ArchiveReading, ArchiveStatus, ArchiveWaiting, Delayed } from "@/features/archive/components/archiveStatus"
import { ArchiveToolbar, type OuterCrumb } from "@/features/archive/components/archiveToolbar"
import { ArchiveEntryList } from "@/features/archive/components/archiveEntryList"
import { ArchiveFooter } from "@/features/archive/components/archiveFooter"
import { ArchivePasswordGate, ArchivePasswordPrompt } from "@/features/archive/components/archivePasswordPrompt"
import { ArchiveLinkTargetsDialog } from "@/features/archive/components/archiveLinkTargetsDialog"
import { ArchiveExtractPicker } from "@/features/archive/components/archiveExtractMenu"
import { ArchiveEntryViewer } from "@/features/archive/components/archiveEntryViewer"
import { useEntryActions, type EnteredArchive, type EntryTarget } from "@/features/archive/components/useEntryActions"
import {
	EntryMenuContext,
	type EntryMenuAction,
	type EntryMenuHost,
	type RowMenu,
	type SelectionMenuAction
} from "@/features/archive/lib/entryMenu"
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

interface MarqueeStep {
	rows: RowView
	preset: Selection | null
	first: number
	last: number
	result: Selection
}

const DEFAULT_SORT: ChildSort = { key: "name", descending: false }
const NO_REFS = new Int32Array(0)
const IS_MAC = isMacPlatform()
const BACK = ARCHIVE_ACTIONS.find(def => def.id === "archive.back")

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
			// A trashed file's bytes go to no device (previewDownloadable), but an extract lands in the user's own drive.
			extractable={variant === "trash"}
		/>
	)
}

export interface ArchiveSourceBrowserProps {
	source: ArchiveSource
	// Another listing transport (a public link's).
	deps?: ListingDeps | undefined
	// Extracts offered even where the archive's bytes are not downloadable.
	extractable?: boolean
}

// One archive entered from another: its source, the directory of the archive holding it that it was entered
// from, and how it was entered.
interface NestedLevel {
	source: ArchiveSource
	fromDirPath: string
	entered: EnteredArchive
}

// Where an outer level goes once shown again: a directory an outer crumb named. `at` tells one ask from the next.
interface Revisit {
	dirPath: string
	at: number
}

// The archive and those entered from it, one inside the next (at most MAX_NESTED_DEPTH deep), each browsed in the place of
// the one holding it. The outer levels stay mounted, hidden, while an inner one is shown: their listing (running,
// stopped, gated or done), password, accepted cost and place survive the visit, and none can be evicted from the
// listing cache meanwhile. The crumbs run on through the archives holding the one shown, a crossing named where they
// enter it; leaving an inner archive (an outer crumb, Back or Escape at its root) shows the outer one again, its cursor
// on the archive's row.
export function ArchiveSourceBrowser({ source, deps, extractable }: ArchiveSourceBrowserProps) {
	const [nested, setNested] = useState<readonly NestedLevel[]>([])
	const [revisit, setRevisit] = useState<Revisit | null>(null)
	const levels = [{ source, fromDirPath: "", entered: null }, ...nested]
	const depth = levels.length - 1

	const leaveTo = (level: number, dirPath: string | null): void => {
		setNested(nested.slice(0, level))
		setRevisit(dirPath === null ? null : { dirPath, at: (revisit?.at ?? 0) + 1 })
	}

	const outerOf = (level: number): OuterCrumb[] =>
		nested.slice(0, level).flatMap((inner, i) => {
			const holder = levels[i]?.source ?? source
			const segments = inner.fromDirPath === "" ? [] : inner.fromDirPath.split("/")

			return [
				{
					key: `${holder.uuid}:`,
					name: holder.name,
					onSelect: () => {
						leaveTo(i, "")
					}
				},
				...segments.map((segment, at) => {
					const dirPath = segments.slice(0, at + 1).join("/")

					return {
						key: `${holder.uuid}:${dirPath}`,
						name: segment,
						onSelect: () => {
							leaveTo(i, dirPath)
						}
					}
				})
			]
		})

	return (
		<>
			{levels.map((level, i) => (
				<div
					key={level.source.uuid}
					hidden={i !== depth}
					className="size-full"
				>
					<ArchiveLevelBrowser
						source={level.source}
						deps={deps}
						extractable={extractable === true}
						active={i === depth}
						outer={outerOf(i)}
						revisit={i === depth ? revisit : null}
						entered={level.entered}
						onEnter={(inner, fromDirPath, entered) => {
							setNested([...nested.slice(0, i), { source: inner, fromDirPath, entered }])
							setRevisit(null)
						}}
						onLeave={
							i === 0
								? null
								: () => {
										leaveTo(i - 1, null)
									}
						}
					/>
				</div>
			))}
		</>
	)
}

interface InnerLevelFrameProps {
	outer: readonly OuterCrumb[]
	rootName: string
	active: boolean
	onLeave: () => void
	children: ReactNode
}

// An inner archive while no list is shown (its gate, password, wait, failure): the outer crumbs stay, and Escape (or the
// back key) leaves it as the list's would, instead of closing the overlay. Heard at the document before the overlay's
// dismissal, for a key pressed in the frame and for one nothing shown holds (focus on the overlay or the page, or left on
// the hidden outer list it was entered from); a key in a dialog or menu over it (the password prompt's Escape, which
// only dismisses that prompt) is not its own.
function InnerLevelFrame({ outer, rootName, active, onLeave, children }: InnerLevelFrameProps) {
	const bindings = useBindings()
	const frameRef = useRef<HTMLDivElement>(null)

	const handleDocumentKey = useEffectEvent((event: KeyboardEvent) => {
		const frame = frameRef.current
		const target = event.target

		if (
			frame === null ||
			event.defaultPrevented ||
			isImeKeydown(event) ||
			isRecordingCombo() ||
			!(target instanceof Node) ||
			!(frame.contains(target) || target.contains(frame) || (target instanceof Element && target.closest("[hidden]") !== null))
		) {
			return
		}

		const escape = event.key === "Escape" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey

		if (!escape && (BACK === undefined || !matchesCombo(event, bindingOf(bindings, BACK, IS_MAC), IS_MAC))) {
			return
		}

		event.preventDefault()
		event.stopPropagation()

		if (!event.repeat) {
			onLeave()
		}
	})

	useEffect(() => {
		if (!active) {
			return
		}

		const listener = (event: KeyboardEvent): void => {
			handleDocumentKey(event)
		}

		document.addEventListener("keydown", listener, true)

		return () => {
			document.removeEventListener("keydown", listener, true)
		}
	}, [active])

	return (
		<div
			ref={frameRef}
			className="flex size-full flex-col"
		>
			<ArchiveToolbar
				outer={outer}
				rootName={rootName}
				shown={[]}
				hidden={[]}
				onNavigate={() => undefined}
			/>
			<div className="min-h-0 flex-1">{children}</div>
		</div>
	)
}

interface ArchiveLevelBrowserProps extends ArchiveSourceBrowserProps {
	// The level shown; an outer one stays mounted, hidden, while an archive it holds is browsed.
	active: boolean
	// The crumbs of the archives holding this one (empty for a file's own).
	outer: readonly OuterCrumb[]
	// A directory an outer crumb asked it to show again.
	revisit: Revisit | null
	// How it was entered from the archive holding it; null for a file's own.
	entered: EnteredArchive | null
	// Browses an archive held in one of its entries in its place, entered from the directory `fromDirPath`.
	onEnter: (inner: ArchiveSource, fromDirPath: string, entered: EnteredArchive) => void
	// Back to the archive holding this one; null for a file's own.
	onLeave: (() => void) | null
}

// The archive's directories, browsed and searched, with an extract of the selection or of everything.
// The selection's base is the directory shown, so navigating clears it; extracts land in
// the user's own drive whatever the archive's source. An archive held in another is never extracted from: it has no
// drive file of its own.
function ArchiveLevelBrowser({ source, deps, extractable, active, outer, revisit, entered, onEnter, onLeave }: ArchiveLevelBrowserProps) {
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
	// What was last acted on of the shown-again state: an outer crumb's directory, the level shown again, a listing an
	// entry's own checks looked at.
	const [seenRevisit, setSeenRevisit] = useState<Revisit | null>(null)
	const [wasActive, setWasActive] = useState(active)
	const [focusKey, setFocusKey] = useState(0)
	const [sort, setSort] = useState<ChildSort>(DEFAULT_SORT)
	const [query, setQuery] = useState("")
	// Per store: a new listing run (List again, a password) starts from nothing.
	const [picked, setPicked] = useState<{ store: EntryStore; selection: Selection }>(() => ({ store, selection: EMPTY_SELECTION }))
	const [cursor, setCursor] = useState<RowPosition | null>(null)
	const [anchor, setAnchor] = useState<RowPosition | null>(null)
	const [passwordAsk, setPasswordAsk] = useState<PasswordAsk | null>(null)
	const [linkAsk, setLinkAsk] = useState<LinkTargetsAsk | null>(null)
	// A row's "Choose destination…" (for its entry, or for the selection from its context menu), kept here:
	// the row may unmount while the picker is open.
	const [rowPick, setRowPick] = useState<EntryTarget | "selection" | null>(null)
	const [viewStore, setViewStore] = useState(store)
	const entries = useEntryActions({
		source,
		session: listing.session,
		downloadable,
		isOnline,
		onEnterArchive: (inner, target, how) => {
			// Shown again, its cursor is on the archive's row.
			placeCursor({ ref: target.slot, index: -1 }, true)
			onEnter(inner, path, how)
		}
	})
	// Ends the wait for a password check that an extract is waiting on.
	const pendingCheck = useRef<(() => void) | null>(null)
	// The last marquee step: the rows it covered and the selection that made.
	const marqueeStep = useRef<MarqueeStep | null>(null)
	// A password was typed for this archive itself: a refusal after it is its own, not the outer one's.
	const typedPassword = useRef(false)
	// The confirmed entry's gate was listed once: a cancel back to the gate shows it, never starts again.
	const autoStarted = useRef(false)

	// A new run (List again, a password) lists into a fresh store: the view starts over at its root. A
	// store replacing one that holds nothing (the placeholder before the session opened, a run that read
	// nothing) loses nothing, and keeps where a cached listing reopens.
	if (viewStore !== store) {
		setViewStore(store)

		// The replaced store's selection is never shown again; dropped, it no longer holds that listing's entries.
		if (picked.store !== store) {
			setPicked({ store, selection: EMPTY_SELECTION })
		}

		if (viewStore.entryCount > 0) {
			setPath("")
			setCursor(null)
			setAnchor(null)
		}
	}

	// An outer crumb asked for one of its directories: shown there, focus on the list.
	if (revisit !== null && revisit !== seenRevisit) {
		setSeenRevisit(revisit)
		setPath(revisit.dirPath)
		setQuery("")
		setPicked({ store, selection: EMPTY_SELECTION })
		setFocusKey(focusKey + 1)
	}

	// Shown again after an archive it holds: focus goes back to its list, the cursor on that archive's row.
	if (active !== wasActive) {
		setWasActive(active)

		if (active) {
			setFocusKey(focusKey + 1)
		}
	}

	const enteredCheck = useEffectEvent(() => {
		if (entered === null) {
			return
		}

		// Confirmed on the way in: its own gate asks nothing again, once.
		if (entered.confirmed && phase.type === "gate" && !autoStarted.current) {
			const session = listing.session()

			if (session !== null) {
				autoStarted.current = true
				session.start()
			}
		}

		const parent = entered.parentPassword

		if (parent === null) {
			return
		}

		// The outer password typed to reach its entry: proved by a listing, refused by the SDK before the inner archive
		// asked a password of its own (none was typed for it), which asks the outer one again.
		if (phase.type === "done" || (phase.type === "stopped" && store.entryCount > 0)) {
			parent.accepted()
		} else if (phase.type === "needsPassword" && phase.wrong && !typedPassword.current && listing.session()?.password() === undefined) {
			onLeave?.()
			parent.rejected()
		}
	})

	useEffect(() => {
		enteredCheck()
	}, [phase.type])

	// The last marquee step's rows read the store they were built from.
	useEffect(() => {
		marqueeStep.current = null
	}, [store])

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
	const inner = source.nested !== null
	const extractAllowed = (downloadable || extractable === true) && !inner
	const extractOff = info === null || !isOnline || !extractAllowed
	const notAllowed = inner ? t("previewArchiveExtractNestedNote") : extractAllowed ? undefined : t("previewArchiveExtractNotAllowed")
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
		if (next !== selection) {
			setPicked({ store, selection: next })
		}
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

	// At an inner archive's root, back to the archive holding it.
	function goParent(): void {
		if (dir !== 0) {
			navigate(store.dirParent(dir), dirRef(dir))
		} else {
			onLeave?.()
		}
	}

	// Rows `from` to `to`, and only those; the whole directory is one rule.
	function rangeOf(from: number, to: number): Selection {
		return rangeSelection(store, rows, searchRefs === null ? dir : null, from, to)
	}

	// A marquee step: a pointer move over the rows the last step covered selects nothing anew, so it
	// re-renders nothing.
	function coverMarquee(indices: readonly number[], preset: Selection | null): Selection {
		const first = indices[0] ?? -1
		const last = indices.at(-1) ?? -1
		const step = marqueeStep.current

		if (step !== null && step.rows === rows && step.preset === preset && step.first === first && step.last === last) {
			return step.result
		}

		const result = marqueeSelection(store, rows, searchRefs === null ? dir : null, indices, preset)

		marqueeStep.current = { rows, preset, first, last, result }

		return result
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

			select(rangeOf(anchorIndex < 0 ? index : anchorIndex, index))
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

	// Every extract ends here: none while extracting is off (offline, a link allowing no downloads, an archive held in
	// another, whose request would name the outer file), whichever trigger asked.
	function startExtract({ target, resolved, baseDir }: PendingExtract): void {
		const session = listing.session()

		if (session === null || info === null || extractOff) {
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
		if (extractOff) {
			return
		}

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

	function handleSelectionMenu(action: SelectionMenuAction): void {
		switch (action.type) {
			case "extract":
				extractSelected(action.target)

				break
			case "chooseDestination":
				setRowPick("selection")

				break
		}
	}

	// Like the drive listing, a right-click outside the selection makes the row the selection (and moves
	// the cursor there, as a click would) before its menu opens.
	function openRowMenu(index: number, ref: RowRef): RowMenu | null {
		const next = rowMenuSelection(store, selection, ref)
		const menu = rowMenuOf(store, next, ref)

		if (menu !== null) {
			select(next)
			placeCursor({ ref, index }, true)
		}

		return menu
	}

	// The listing holds the page's one archive slot, which the extract needs: it stops first.
	function extractAll(target: ExtractTarget): void {
		if (extractOff) {
			return
		}

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

	function handleKeyAction(action: BrowserListKeyAction, pageSize: number): number | null {
		const cursorIndex = cursorIndexNow()

		switch (action.type) {
			case "move": {
				const next = cursorTarget(action.move, cursorIndex, rows.count, pageSize)

				if (next === null) {
					return null
				}

				const position = { ref: rows.at(next), index: next }

				if (action.extend) {
					const anchorIndex = anchorIndexNow()

					select(rangeOf(anchorIndex < 0 ? next : anchorIndex, next))
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
			case "leave":
				onLeave?.()

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
			case "download": {
				const ref = cursorIndex < 0 ? null : rows.at(cursorIndex)

				if (ref !== null && !isDirRef(ref) && entries.offers({ store, slot: ref }).download) {
					entries.request({ store, slot: ref }, "download")
				}

				return null
			}
			case "extractSelected": {
				const target = defaultExtractTarget(source, single ? null : baseFolderName)

				if (target !== null && !extractOff && canExtractSelection(phase, store.entryCount) && totals.entries > 0) {
					extractSelected(target)
				}

				return null
			}
			case "extractAll": {
				const target = defaultExtractTarget(source, single ? null : (info?.defaultName ?? source.name))

				if (target !== null && !extractOff) {
					extractAll(target)
				}

				return null
			}
		}
	}

	// The password is checked by relisting; the waiting extract starts once it is accepted, or asks again.
	function submitPassword(password: string): void {
		const session = listing.session()
		const pending = passwordAsk?.extract ?? null

		setPasswordAsk(null)

		if (session === null) {
			return
		}

		typedPassword.current = true
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
					listing={{ source, store }}
					readAhead={listing.session()?.costAccepted() === true}
					extractAllowed={extractAllowed}
				/>
				{entries.dialogs}
			</>
		)
	}

	// An inner archive's states shown in the list's place keep the way back out.
	const framed = (body: ReactNode): ReactNode =>
		onLeave === null ? (
			body
		) : (
			<InnerLevelFrame
				outer={outer}
				rootName={source.name}
				active={active}
				onLeave={onLeave}
			>
				{body}
			</InnerLevelFrame>
		)

	if (phase.type === "gate") {
		return framed(
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
		return framed(
			<ArchivePasswordGate
				name={source.name}
				wrong={phase.wrong}
				onSubmit={password => {
					typedPassword.current = true
					listing.session()?.submitPassword(password)
				}}
			/>
		)
	}

	if (phase.type === "waiting") {
		return framed(
			<ArchiveWaiting
				onCancel={() => {
					listing.session()?.stop()
				}}
			/>
		)
	}

	if ((phase.type === "resolving" || phase.type === "starting") && store.entryCount === 0) {
		return framed(
			<Delayed ms={ARCHIVE_SPINNER_DELAY_MS}>
				<PreviewLoading />
			</Delayed>
		)
	}

	if (phase.type === "failed" && store.entryCount === 0) {
		const failureKey = failureLabelKey(phase.error)

		return framed(
			<PreviewErrorState
				message={failureKey === null ? errorLabel(phase.error) : t(failureKey)}
				onRetry={() => {
					listing.session()?.retry()
				}}
			/>
		)
	}

	const extractSelectionOff = extractOff || !canExtractSelection(phase, store.entryCount)
	const menuHost: EntryMenuHost = {
		source,
		newFolderName: single ? null : baseFolderName,
		extractDisabled: extractSelectionOff,
		selectionExtractDisabled: extractSelectionOff || totals.entries === 0,
		offers: slot => entries.offers({ store, slot }),
		onAction: handleEntryMenu,
		openRowMenu,
		onSelectionAction: handleSelectionMenu,
		onOpenDir: target => {
			navigate(target, null)
		}
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
		) : phase.type === "reading" && store.entryCount === 0 && phase.bytesRead > 0 ? (
			// A tar's member is listed once its data was read: a large first one shows nothing until then.
			<p className="px-6 py-10 text-center text-sm text-muted-foreground">
				{t("previewArchiveReadingFirst", { read: formatBytes(phase.bytesRead), total: formatBytes(phase.archiveBytes) })}
			</p>
		) : running ? (
			<LoadingState size="sm" />
		) : (
			<p className="px-6 py-10 text-center text-sm text-muted-foreground">
				{t(
					store.entryCount > 0
						? "previewArchiveDirectoryEmpty"
						: phase.type === "stopped"
							? "previewArchiveStoppedBeforeFirst"
							: "previewArchiveEmpty"
				)}
			</p>
		)

	return (
		<div className="flex size-full flex-col">
			<ArchiveToolbar
				outer={outer}
				rootName={source.name}
				shown={shown.map(id => ({ id, name: store.dirName(id) }))}
				hidden={hidden.map(id => ({ id, name: store.dirName(id) }))}
				search={{ query, onQueryChange: handleQueryChange }}
				searchBoxRef={searchBoxRef}
				onNavigate={target => {
					if (target !== dir || searchMode) {
						navigate(target, null)
					}
				}}
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
					escapeLeaves={onLeave !== null}
					focusKey={focusKey}
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
					reading={readingRowOf(store, phase, dir, searchMode)}
					onSort={handleSort}
					onHeaderCheck={handleHeaderCheck}
					onKeyAction={handleKeyAction}
					onPointer={handlePointer}
					onOpen={handleOpen}
					onCheck={toggleAt}
					onSelect={select}
					onMarquee={coverMarquee}
					onCursor={index => {
						placeCursor({ ref: rows.at(index), index }, true)
					}}
				/>
			</EntryMenuContext>
			<ArchiveFooter
				source={source}
				totals={totals}
				selectedFolderName={single ? null : baseFolderName}
				allFolderName={single ? null : (info?.defaultName ?? source.name)}
				selectedDisabled={extractSelectionOff || totals.entries === 0}
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
						if (rowPick === "selection") {
							extractSelected(target)
						} else {
							extractEntry(target, rowPick)
						}
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

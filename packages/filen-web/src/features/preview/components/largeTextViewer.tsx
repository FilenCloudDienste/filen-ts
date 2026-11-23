import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import { useTranslation } from "react-i18next"
import * as Comlink from "comlink"
import { ListOrderedIcon, LockIcon, SearchIcon, SlidersHorizontalIcon, TextCursorInputIcon } from "lucide-react"
import { formatBytes } from "@filen/shared"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { InputDialog } from "@/components/dialogs/inputDialog"
import { OfficeCommandBar, type RibbonGroup } from "@/features/office/components/ribbon/officeRibbon"
import { RibbonButton } from "@/features/office/components/ribbon/ribbonControls"
import { type DriveItem } from "@/features/drive/lib/item"
import { DownloadFile, EncodingMenu } from "@/features/preview/components/codeCommandBar"
import { FullScreenButton } from "@/features/preview/components/commandBarControls"
import { BAR_BUTTON, useLeaveViewerFullScreen } from "@/features/preview/components/commandBar.logic"
import { DocxFindField } from "@/features/preview/components/docxToolbar"
import type { DocxFindControls } from "@/features/preview/components/docxViewer.logic"
import { BinaryInfoViewer } from "@/features/preview/components/binaryInfoViewer"
import { LargeTextRows, type PagerJump } from "@/features/preview/components/largeTextRows"
import { positionStore, type PositionStore } from "@/features/preview/lib/textPager/viewport.logic"
import {
	PreviewErrorState,
	PreviewLoading,
	PreviewNotTextState,
	PreviewUnsupportedState
} from "@/features/preview/components/previewErrorState"
import { useTextPagerSession, type TextPagerReading } from "@/features/preview/hooks/useTextPagerSession"
import { originServesRanges } from "@/features/drive/lib/preview.logic"
import { usePreviewDownload, usePreviewOrigin } from "@/features/preview/lib/accessMode"
import { useCodeViewSettings } from "@/features/preview/lib/codeViewSettings"
import { usePublishPreviewDocument } from "@/features/preview/lib/activeDocumentScope"
import { elementSelection } from "@/lib/activeDocument"
import { pagerDocumentReader } from "@/features/preview/lib/documentReaders"
import { searchPattern } from "@/features/preview/lib/textPager/search.logic"
import { keyForEditor } from "@/lib/keymap/dialogGuard"
import { IN_EDITORS, useAction } from "@/lib/keymap/useAction"
import { Kbd } from "@/lib/keymap/kbd"
import { errorLabel } from "@/lib/i18n/errorLabel"

// A text file too large to load whole, read-only in ranges (textPager.worker.ts): the command bar (File, Find with go to
// line, View with Count lines), the size, position, encoding and a read-only badge, then the rows. Line numbers show
// only for what a find, a go to line or Count lines has counted. An archive's entry read only whole stays too large.

// The scan running (a find, Count lines or a go to line, each its own `id`) and how far it has read.
type Scan = { readonly id: number; readonly kind: "search" | "count"; readonly scanned: number } | null

interface FindState {
	readonly open: boolean
	readonly focus: number
	readonly query: string
	readonly caseSensitive: boolean
	readonly count: number
	readonly capped: boolean
	readonly active: number
}

const CLOSED_FIND: FindState = { open: false, focus: 0, query: "", caseSensitive: false, count: 0, capped: false, active: -1 }

// A positive line number, as typed.
function typedLine(value: string): number | null {
	const line = /^\s*(\d{1,15})\s*$/.exec(value)?.[1]

	return line === undefined || Number(line) < 1 ? null : Number(line)
}

function Position({ position, size }: { position: PositionStore; size: number }) {
	const { t } = useTranslation("preview")
	const at = useSyncExternalStore(position.subscribe, position.get)

	return <span>{t("previewLargeTextPosition", { percent: size === 0 ? 100 : Math.floor((at / size) * 100) })}</span>
}

function LargeTextReader({ reading, alt, publishes }: { reading: TextPagerReading; alt: string; publishes: boolean }) {
	const { t } = useTranslation(["preview", "common"])
	const { pager, size, fail } = reading
	// The text selected in the rows shown (only those are in the page: a selection past them reads as far as shown).
	const [selection] = useState(elementSelection)

	// Read from the file's start through the pager's rows, as far as a reader asks.
	usePublishPreviewDocument(
		publishes
			? {
					kind: "text",
					position: {},
					selection: selection.reader,
					editable: false,
					reader: pagerDocumentReader(reading.start, (from, continuation, count) =>
						pager.run(remote => remote.after(from, continuation, count, null))
					)
				}
			: null
	)

	const settings = useCodeViewSettings()
	const download = usePreviewDownload()
	const [position] = useState(positionStore)
	const [jump, setJump] = useState<PagerJump | null>(null)
	const [linesVersion, setLinesVersion] = useState(0)
	const [lines, setLines] = useState<{ readonly count: number; readonly complete: boolean } | null>(null)
	const [scan, setScan] = useState<Scan>(null)
	const [find, setFind] = useState<FindState>(CLOSED_FIND)
	const [goToLine, setGoToLine] = useState(false)
	// The current query: bumped by a new search and by closing find, so an older one's answers are dropped.
	const searches = useRef(0)
	// Every scan started: its own progress and end touch the status only while it is the one shown.
	const scans = useRef(0)
	const rootRef = useRef<HTMLDivElement | null>(null)

	useEffect(() => {
		selection.attach(rootRef.current)
	})
	const pattern = find.open && find.query !== "" ? searchPattern(find.query, find.caseSensitive) : null
	const rowsAbove = 3

	const jumpTo = (offset: number, line: number | null, match: boolean): void => {
		setJump(previous => ({ seq: (previous?.seq ?? 0) + 1, offset, before: rowsAbove, line, match }))
	}

	// Match `index` of the query `seq`; dropped when another query has started meanwhile.
	const showMatch = (index: number, seq: number): void => {
		void pager
			.run(remote => remote.match(index))
			.then(match => {
				if (match !== null && searches.current === seq) jumpTo(match.offset, match.line, true)
			}, fail)
	}

	const startScan = (kind: "search" | "count"): number => {
		const id = ++scans.current

		setScan({ id, kind, scanned: 0 })

		return id
	}

	const scanned = (id: number, at: number): void => {
		setScan(current => (current?.id === id ? { ...current, scanned: at } : current))
	}

	const ended = (id: number): void => {
		setScan(current => (current?.id === id ? null : current))
	}

	const counted = (next: { lines: number; complete: boolean }): void => {
		setLines({ count: next.lines, complete: next.complete })
		setLinesVersion(version => version + 1)
	}

	const progress = (id: number) =>
		Comlink.proxy((at: number) => {
			scanned(id, at)
		})

	const search = (query: string, caseSensitive: boolean): void => {
		const seq = ++searches.current

		setFind(previous => ({ ...previous, query, caseSensitive, count: 0, capped: false, active: -1 }))

		if (query === "") {
			setScan(current => (current?.kind === "search" ? null : current))
			void pager.run(remote => remote.stop()).catch(fail)

			return
		}

		// The first match at or after the view's top is shown as soon as the search reaches it.
		let shown = false
		// Progress comes over the callback's own port, which keeps no order with the result's: a report after the result
		// would put back an earlier count.
		let settled = false
		const from = position.get()
		const id = startScan("search")
		const onProgress = Comlink.proxy((at: number, count: number, first: number) => {
			if (searches.current !== seq || settled) {
				return
			}

			scanned(id, at)
			setFind(previous => ({ ...previous, count, active: !shown && first !== -1 ? first : previous.active }))

			if (!shown && first !== -1) {
				shown = true
				showMatch(first, seq)
			}
		})

		void pager
			.run(remote => remote.search(query, caseSensitive, from, onProgress))
			.then(result => {
				settled = true

				if (searches.current !== seq) {
					return
				}

				const active = shown ? null : result.first !== -1 ? result.first : result.count > 0 ? 0 : -1

				ended(id)
				// Stopped (Stop, or a count or go to line that took over) or at the cap: there may be more.
				setFind(previous => ({
					...previous,
					count: result.count,
					capped: result.end !== "done",
					active: active ?? previous.active
				}))
				counted(result)

				if (active !== null && active !== -1) showMatch(active, seq)
			}, fail)
	}

	const stop = (): void => {
		void pager.run(remote => remote.stop()).catch(fail)
	}

	const countLines = (): void => {
		const id = startScan("count")

		void pager
			.run(remote => remote.countLines(progress(id)))
			.then(result => {
				ended(id)
				counted(result)
			}, fail)
	}

	const goTo = (line: number): void => {
		const id = startScan("count")

		void pager
			.run(remote => remote.lineStart(line, progress(id)))
			.then(offset => {
				ended(id)
				void pager.run(remote => remote.lines()).then(counted, fail)

				if (offset !== null) jumpTo(offset, null, false)
			}, fail)
	}

	const findControls: DocxFindControls = {
		query: find.query,
		caseSensitive: find.caseSensitive,
		count: find.count,
		// More may come while the search runs.
		capped: find.capped || scan?.kind === "search",
		active: find.active,
		search: (query, caseSensitive) => {
			search(query, caseSensitive)
		},
		step: direction => {
			if (find.count === 0) {
				return
			}

			const next = find.active === -1 ? (direction > 0 ? 0 : find.count - 1) : (find.active + direction + find.count) % find.count

			setFind(previous => ({ ...previous, active: next }))
			showMatch(next, searches.current)
		},
		close: () => {
			searches.current++

			if (scan?.kind === "search") stop()

			setScan(current => (current?.kind === "search" ? null : current))
			setFind(CLOSED_FIND)
		}
	}

	const openFind = (): void => {
		setFind(previous => ({ ...previous, open: true, focus: previous.focus + 1 }))
	}

	// Find, the next and previous match and go to line, with focus anywhere in the viewer or on its bar.
	const onKey = (keyboardEvent: KeyboardEvent, run: () => void): void => {
		const root = rootRef.current

		if (root === null || keyboardEvent.defaultPrevented || !keyForEditor(root, keyboardEvent.target)) {
			return
		}

		keyboardEvent.preventDefault()
		run()
	}

	useAction(
		"editor.find",
		keyboardEvent => {
			onKey(keyboardEvent, openFind)
		},
		IN_EDITORS
	)
	useAction(
		"editor.goToLine",
		keyboardEvent => {
			onKey(keyboardEvent, () => {
				setGoToLine(true)
			})
		},
		IN_EDITORS
	)
	useAction(
		"editor.findNext",
		keyboardEvent => {
			onKey(keyboardEvent, () => {
				findControls.step(1)
			})
		},
		IN_EDITORS,
		[find]
	)
	useAction(
		"editor.findPrevious",
		keyboardEvent => {
			onKey(keyboardEvent, () => {
				findControls.step(-1)
			})
		},
		IN_EDITORS,
		[find]
	)

	const groups: RibbonGroup[] = [
		{
			id: "find",
			label: t("previewOfficeRibbonEditing"),
			icon: SearchIcon,
			width: 2 * BAR_BUTTON,
			priority: Infinity,
			content: (
				<>
					<RibbonButton
						label={t("previewEditorFind")}
						icon={<SearchIcon />}
						shortcut={<Kbd action="editor.find" />}
						onClick={openFind}
					/>
					<RibbonButton
						label={t("previewCommandBarGoToLine")}
						icon={<TextCursorInputIcon />}
						shortcut={<Kbd action="editor.goToLine" />}
						onClick={() => {
							setGoToLine(true)
						}}
					/>
				</>
			)
		},
		{
			id: "view",
			label: t("previewOfficeRibbonTabView"),
			icon: SlidersHorizontalIcon,
			width: 2 * BAR_BUTTON,
			priority: 2,
			content: (
				<>
					<RibbonButton
						label={t("previewLargeTextCountLines")}
						icon={<ListOrderedIcon />}
						disabled={lines?.complete === true || scan !== null}
						onClick={countLines}
					/>
					<FullScreenButton />
				</>
			)
		}
	]

	const stopButton = (
		<Button
			variant="outline"
			size="sm"
			className="h-6 px-2 text-xs"
			onClick={stop}
		>
			{t("previewLargeTextStop")}
		</Button>
	)
	const progressOf = (scanned: number) => ({ done: formatBytes(scanned), total: formatBytes(size) })

	return (
		<div
			ref={rootRef}
			className="flex size-full flex-col"
		>
			<OfficeCommandBar
				label={t("previewOfficeRibbonCommands")}
				file={<DownloadFile onDownload={download} />}
				groups={groups}
				replacement={
					find.open ? (
						<div className="flex min-w-0 flex-wrap items-center gap-2">
							<DocxFindField
								find={findControls}
								focus={find.focus}
								onClosed={() => {
									rootRef.current?.querySelector<HTMLElement>("[role=document]")?.focus()
								}}
							/>
							{scan?.kind === "search" ? (
								<span className="flex items-center gap-2 text-xs whitespace-nowrap text-muted-foreground tabular-nums">
									{t("previewLargeTextSearching", progressOf(scan.scanned))}
									{stopButton}
								</span>
							) : null}
						</div>
					) : undefined
				}
				status={
					<span className="flex items-center gap-3 text-xs whitespace-nowrap text-muted-foreground tabular-nums">
						{scan?.kind === "count" ? (
							<span className="flex items-center gap-2">
								{t("previewLargeTextCounting", progressOf(scan.scanned))}
								{stopButton}
							</span>
						) : lines?.complete === true ? (
							<span className="max-sm:hidden">{t("previewLargeTextLines", { count: lines.count })}</span>
						) : null}
						<span className="max-sm:hidden">{formatBytes(size)}</span>
						<Position
							position={position}
							size={size}
						/>
						<EncodingMenu
							format={{ encoding: reading.label, bom: reading.start > 0 }}
							encoding={{
								detected: reading.detected,
								chosen: reading.label === reading.detected ? null : reading.label,
								reopen: reading.reopen,
								convert: null,
								converted: false
							}}
							dirty={false}
						/>
						<Badge
							variant="outline"
							className="text-muted-foreground max-sm:hidden"
						>
							<LockIcon data-icon="inline-start" />
							{t("previewCommandBarReadOnly")}
						</Badge>
					</span>
				}
			/>
			<LargeTextRows
				reading={reading}
				alt={alt}
				fontSize={settings.fontSize}
				pattern={pattern}
				jump={jump}
				linesVersion={linesVersion}
				position={position}
			/>
			<InputDialog
				open={goToLine}
				pending={false}
				title={t("previewCommandBarGoToLine")}
				body={t("previewLargeTextGoToLineLabel")}
				label={t("previewCommandBarGoToLine")}
				inputMode="numeric"
				submitLabel={t("previewCommandBarGoToLineSubmit")}
				validate={value => typedLine(value) !== null}
				onOpenChange={setGoToLine}
				onSubmit={value => {
					const line = typedLine(value)

					setGoToLine(false)

					if (line !== null) goTo(line)
				}}
			/>
		</div>
	)
}

function LargeTextSession({ item, alt, publishes }: { item: DriveItem; alt: string; publishes: boolean }) {
	const session = useTextPagerSession(item)

	switch (session.status) {
		case "pending":
			return <PreviewLoading />
		case "error":
			return (
				<PreviewErrorState
					message={errorLabel(session.dto)}
					onRetry={session.retry}
				/>
			)
		case "notText":
			return session.executable ? (
				<BinaryInfoViewer item={item} />
			) : (
				<PreviewNotTextState
					item={item}
					onShowAnyway={session.showAnyway}
				/>
			)
		case "ready":
			return (
				<LargeTextReader
					// Read again with another encoding: new rows, a new find.
					key={session.reading.label}
					reading={session.reading}
					alt={alt}
					publishes={publishes}
				/>
			)
	}
}

// Never editable. Read in ranges from any origin that serves them (originServesRanges); an archive entry the SDK worker
// would have to hold whole past its buffer cap is too large to show. `publishes`: a text, code or markdown file, published
// as the open document.
export function LargeTextViewer({ item, alt, publishes }: { item: DriveItem; alt: string; publishes?: boolean }) {
	const { t } = useTranslation("preview")
	const origin = usePreviewOrigin(item)

	useLeaveViewerFullScreen()

	if (!originServesRanges(origin)) {
		return (
			<PreviewUnsupportedState
				item={item}
				message={t("previewTextTooLarge")}
			/>
		)
	}

	return (
		<LargeTextSession
			item={item}
			alt={alt}
			publishes={publishes === true}
		/>
	)
}

import { useEffect, useRef, useState, useSyncExternalStore, type DragEvent, type RefObject } from "react"
import { useTranslation } from "react-i18next"
import { useVirtualizer } from "@tanstack/react-virtual"
import { ChevronDownIcon, ChevronRightIcon, ChevronUpIcon, SearchIcon, XIcon } from "lucide-react"
import type { DocumentMatch, StorySearch } from "@filen/office/core/docx/edit"
import {
	canMoveOutlineEntry,
	docxOutline,
	goToOutlineEntry,
	moveOutlineEntry,
	outlineEntryAt,
	type DocxOutline,
	type PagedEditor
} from "@filen/office/core/docx/paged"
import { paintThumbnail, thumbnailHeight, type DocxEditorHandle } from "@filen/office/react/docx/editor"
import { cn } from "@filen/shared"
import type { DocxSurface } from "@/features/preview/components/docxEditor.logic"
import type { DocxFindControls } from "@/features/preview/components/docxViewer.logic"
import type { DocxPageStore } from "@/features/preview/components/docxGoTo.logic"
import {
	dropBefore,
	headingKeys,
	headingRows,
	matchContext,
	sameHeadings,
	storyLabel,
	type DocxNavigationState,
	type DocxNavigationTab,
	type HeadingRow
} from "@/features/preview/components/docxNavigation.logic"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { TooltipIconButton } from "@/components/ui/tooltipIconButton"
import { observeElementOffsetFromAttach } from "@/lib/virtualScroll"

// Word's Navigation pane, docked left of the pages: a search box (Ctrl+F lands there; its matches are the find's,
// marked on the pages), and three tabs. Headings: the outline from heading and outline-level paragraphs, collapsible,
// the heading where the view is highlighted as it scrolls, a heading dragged with its content elsewhere. Pages: a
// thumbnail of each page (painted from its layout, only those in view). Results: each match in its context. Only the
// tab shown does any work: the outline is read once edits pause, thumbnails repaint only for pages laid out again.

// The pause after an edit before the outline is read again.
const OUTLINE_IDLE_MS = 300
const HEADING_ROW = 28
const RESULT_ROW = 52
const THUMB_WIDTH = 150
// Room under a thumbnail for its page number, and between thumbnails.
const THUMB_LABEL = 28
const OVERSCAN = 6
// Rows drawn before the list's height is measured (its first paint).
const INITIAL_RECT = { width: 0, height: 800 }
// Where in the view the heading in view is read: this far below its top.
const VIEW_PROBE = 48

export interface DocxNavigationPaneProps {
	editor: PagedEditor
	handleRef: RefObject<DocxEditorHandle | null>
	state: DocxNavigationState
	onTab: (tab: DocxNavigationTab) => void
	onClose: () => void
	find: DocxFindControls
	// The matches, and the stories they were found in (empty until a search ran).
	results: { readonly stories: readonly StorySearch[]; readonly matches: readonly DocumentMatch[] }
	onResult: (index: number) => void
	pages: DocxPageStore
	surface: DocxSurface
	readOnly: boolean
	focusEditor: () => void
}

// The body's outline while `enabled`, read again once edits pause (the same object while the headings' document is).
function useOutline(editor: PagedEditor, enabled: boolean): [DocxOutline | null, (outline: DocxOutline) => void] {
	const [outline, setOutline] = useState<{ editor: PagedEditor; outline: DocxOutline } | null>(null)

	useEffect(() => {
		if (!enabled) {
			return
		}

		let timer: ReturnType<typeof setTimeout> | undefined
		const read = (): void => {
			timer = undefined
			setOutline(previous => {
				const next = docxOutline(editor)

				return previous?.editor === editor && previous.outline === next ? previous : { editor, outline: next }
			})
		}
		const schedule = (): void => {
			if (timer !== undefined) {
				clearTimeout(timer)
			}

			timer = setTimeout(read, OUTLINE_IDLE_MS)
		}
		const stopSession = editor.body.session.subscribe(schedule)
		const stopEditor = editor.subscribe(event => {
			if (event.type === "pages") {
				schedule()
			}
		})

		read()

		return () => {
			stopSession()
			stopEditor()

			if (timer !== undefined) {
				clearTimeout(timer)
			}
		}
	}, [editor, enabled])

	return [
		outline?.editor === editor ? outline.outline : null,
		next => {
			setOutline({ editor, outline: next })
		}
	]
}

export function DocxNavigationPane(props: DocxNavigationPaneProps) {
	const { t } = useTranslation("preview")
	const { state, find } = props
	const searchRef = useRef<HTMLInputElement | null>(null)
	const pagesTab = props.surface === "pages"
	const tab: DocxNavigationTab = state.tab === "pages" && !pagesTab ? "headings" : state.tab
	const tabs: { id: DocxNavigationTab; label: string }[] = [
		{ id: "headings", label: t("previewDocxNavigationHeadings") },
		...(pagesTab ? [{ id: "pages" as const, label: t("previewDocxNavigationPages") }] : []),
		{ id: "results", label: t("previewDocxNavigationResults") }
	]
	const searching = find.query.length > 0
	const status = !searching
		? null
		: find.count === 0
			? t("previewDocxNavigationNoMatches")
			: find.capped
				? t("previewDocxNavigationResultCapped", { current: find.active + 1, total: find.count })
				: t("previewDocxNavigationResultOf", { current: find.active + 1, total: find.count })

	// Ctrl+F (or Find) with the pane open or opening: the search box, its text selected (Word's).
	useEffect(() => {
		if (state.focus > 0) {
			searchRef.current?.focus()
			searchRef.current?.select()
		}
	}, [state.focus])

	return (
		<aside
			aria-label={t("previewDocxNavigation")}
			data-preview-surface
			className="flex w-72 max-w-[85%] shrink-0 flex-col border-r bg-background max-sm:absolute max-sm:inset-y-0 max-sm:left-0 max-sm:z-20 max-sm:shadow-lg"
			// Escape in the pane goes back to the document (taken: the preview closes only on an Escape nothing took).
			onKeyDown={event => {
				if (event.key === "Escape" && !event.defaultPrevented) {
					event.preventDefault()
					props.focusEditor()
				}
			}}
		>
			<div className="flex shrink-0 items-center justify-between gap-2 px-3 pt-2">
				<h2 className="text-sm font-semibold">{t("previewDocxNavigation")}</h2>
				<TooltipIconButton
					label={t("previewDocxNavigationClose")}
					onClick={props.onClose}
				>
					<XIcon />
				</TooltipIconButton>
			</div>
			<div className="flex shrink-0 flex-col gap-1 px-3 py-2">
				<div className="relative flex items-center">
					<SearchIcon
						aria-hidden
						className="pointer-events-none absolute left-2 size-3.5 text-muted-foreground"
					/>
					<Input
						ref={searchRef}
						type="search"
						aria-label={t("previewDocxNavigationSearch")}
						placeholder={t("previewDocxNavigationSearch")}
						value={find.query}
						className="pl-7 leading-5"
						onChange={event => {
							const query = event.target.value

							find.search(query, find.caseSensitive, find.wholeWord)

							if (query.length > 0) {
								props.onTab("results")
							}
						}}
						onKeyDown={event => {
							if (event.key === "Enter") {
								event.preventDefault()
								find.step(event.shiftKey ? -1 : 1)
							} else if (event.key === "Escape") {
								event.preventDefault()
								event.stopPropagation()

								if (searching) {
									find.search("", find.caseSensitive, find.wholeWord)
								} else {
									props.focusEditor()
								}
							}
						}}
					/>
				</div>
				{status === null ? null : (
					<div className="flex items-center justify-between gap-2">
						<p
							role="status"
							className="truncate text-xs text-muted-foreground tabular-nums"
						>
							{status}
						</p>
						<div className="flex shrink-0">
							<TooltipIconButton
								label={t("previewDocxNavigationPrevious")}
								disabled={find.count === 0}
								onClick={() => {
									find.step(-1)
								}}
							>
								<ChevronUpIcon />
							</TooltipIconButton>
							<TooltipIconButton
								label={t("previewDocxNavigationNext")}
								disabled={find.count === 0}
								onClick={() => {
									find.step(1)
								}}
							>
								<ChevronDownIcon />
							</TooltipIconButton>
						</div>
					</div>
				)}
			</div>
			<div
				role="tablist"
				aria-label={t("previewDocxNavigation")}
				className="flex shrink-0 gap-1 border-b px-3"
			>
				{tabs.map(entry => (
					<button
						key={entry.id}
						type="button"
						role="tab"
						id={`docx-navigation-tab-${entry.id}`}
						aria-selected={tab === entry.id}
						aria-controls="docx-navigation-panel"
						className={cn(
							"-mb-px border-b-2 px-2 py-1.5 text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
							tab === entry.id ? "border-primary text-foreground" : "border-transparent"
						)}
						onClick={() => {
							props.onTab(entry.id)
						}}
					>
						{entry.label}
					</button>
				))}
			</div>
			<div
				role="tabpanel"
				id="docx-navigation-panel"
				aria-labelledby={`docx-navigation-tab-${tab}`}
				className="flex min-h-0 flex-1 flex-col"
			>
				{tab === "headings" ? (
					<HeadingsTab
						editor={props.editor}
						handleRef={props.handleRef}
						readOnly={props.readOnly}
						focusEditor={props.focusEditor}
					/>
				) : tab === "pages" ? (
					<PagesTab
						editor={props.editor}
						handleRef={props.handleRef}
						pages={props.pages}
						focusEditor={props.focusEditor}
					/>
				) : (
					<ResultsTab
						editor={props.editor}
						query={find.query}
						active={find.active}
						results={props.results}
						onResult={props.onResult}
					/>
				)}
			</div>
		</aside>
	)
}

interface TabProps {
	editor: PagedEditor
	handleRef: RefObject<DocxEditorHandle | null>
	focusEditor: () => void
}

// The outline as a tree: what it shows is worked out here (once per outline or collapse), drawn by HeadingList.
function HeadingsTab({ editor, handleRef, readOnly, focusEditor }: TabProps & { readOnly: boolean }) {
	const { t } = useTranslation("preview")
	const [outline, setOutline] = useOutline(editor, true)
	const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
	const [current, setCurrent] = useState(-1)
	const keys = outline === null ? NO_KEYS : headingKeys(outline.entries)
	const rows = outline === null ? NO_ROWS : headingRows(outline, keys, collapsed)

	// The heading where the view is: the last at or above a point near the view's top, read once a frame while it
	// scrolls (the body's, never while a header or note is being edited).
	useEffect(() => {
		const element = handleRef.current?.scrollElement()

		if (outline === null || element === null || element === undefined) {
			return
		}

		let frame = 0
		const read = (): void => {
			frame = 0

			if (editor.activeStory !== editor.body.session.story.story.index) {
				return
			}

			const rect = element.getBoundingClientRect()
			const hit = handleRef.current?.hitTest(rect.left + rect.width / 2, rect.top + Math.min(VIEW_PROBE, rect.height / 4))

			if (hit !== undefined) {
				setCurrent(outlineEntryAt(outline, hit.pos))
			}
		}
		const onScroll = (): void => {
			if (frame === 0) {
				frame = requestAnimationFrame(read)
			}
		}

		frame = requestAnimationFrame(read)
		element.addEventListener("scroll", onScroll, { passive: true })

		return () => {
			element.removeEventListener("scroll", onScroll)

			if (frame !== 0) {
				cancelAnimationFrame(frame)
			}
		}
	}, [editor, handleRef, outline])

	if (outline === null) {
		return null
	}

	if (rows.length === 0) {
		return <p className="px-3 py-4 text-xs text-muted-foreground">{t("previewDocxNavigationNoHeadings")}</p>
	}

	const go = (row: HeadingRow): void => {
		if (goToOutlineEntry(editor, outline, row.entry)) {
			handleRef.current?.scrollToCaret()
		}

		focusEditor()
	}

	const toggle = (row: HeadingRow): void => {
		const key = keys[row.index] ?? ""
		const next = new Set(collapsed)

		if (!next.delete(key)) {
			next.add(key)
		}

		setCollapsed(next)
	}

	// A heading dropped before entry `before`: moved with its content, read against the outline as it is now (its
	// text may have changed since this one was read; its headings must not have).
	const move = (from: number, before: number): void => {
		const now = docxOutline(editor)

		if (!sameHeadings(now, outline)) {
			setOutline(now)

			return
		}

		if (moveOutlineEntry(editor, now, from, before)) {
			setOutline(docxOutline(editor))
			handleRef.current?.scrollToCaret()
		}
	}

	return (
		<HeadingList
			rows={rows}
			keys={keys}
			count={outline.entries.length}
			current={current}
			movable={readOnly ? NO_ROWS_MOVABLE : index => canMoveOutlineEntry(outline, index)}
			onGo={go}
			onToggle={toggle}
			onMove={move}
		/>
	)
}

const NO_KEYS: readonly string[] = []
const NO_ROWS: readonly HeadingRow[] = []

function NO_ROWS_MOVABLE(): boolean {
	return false
}

// useVirtualizer opts this component out of the React Compiler: it takes the rows worked out above and draws those
// in view.
function HeadingList({
	rows,
	keys,
	count,
	current,
	movable,
	onGo,
	onToggle,
	onMove
}: {
	rows: readonly HeadingRow[]
	keys: readonly string[]
	count: number
	current: number
	movable: (index: number) => boolean
	onGo: (row: HeadingRow) => void
	onToggle: (row: HeadingRow) => void
	onMove: (from: number, before: number) => void
}) {
	const { t } = useTranslation("preview")
	const [scroller, setScroller] = useState<HTMLDivElement | null>(null)
	const [drop, setDrop] = useState<{ row: number; lower: boolean } | null>(null)
	const dragRef = useRef<number | null>(null)
	const virtualizer = useVirtualizer({
		count: rows.length,
		getScrollElement: () => scroller,
		observeElementOffset: observeElementOffsetFromAttach,
		initialRect: INITIAL_RECT,
		estimateSize: () => HEADING_ROW,
		overscan: OVERSCAN
	})

	const onDrop = (event: DragEvent, row: number): void => {
		event.preventDefault()

		const from = dragRef.current
		const lower = drop?.row === row && drop.lower

		dragRef.current = null
		setDrop(null)

		if (from !== null) {
			onMove(from, dropBefore(rows, row, lower, count))
		}
	}

	return (
		<div
			ref={setScroller}
			className="min-h-0 flex-1 overflow-y-auto py-1"
		>
			<ul
				aria-label={t("previewDocxNavigationHeadings")}
				className="relative"
				style={{ height: virtualizer.getTotalSize() }}
			>
				{virtualizer.getVirtualItems().map(item => {
					const row = rows[item.index]

					if (row === undefined) {
						return null
					}

					// A collapsed heading stands for the subheadings it hides.
					const isCurrent = current === row.index || (row.collapsed && current > row.index && isUnder(rows, item.index, current))

					return (
						<li
							key={keys[row.index] ?? item.index}
							className={cn(
								"absolute inset-x-0 flex items-center pr-2",
								drop?.row === item.index && (drop.lower ? "border-b-2 border-primary" : "border-t-2 border-primary")
							)}
							style={{ top: item.start, height: item.size, paddingLeft: 8 + row.depth * 14 }}
							onDragOver={event => {
								if (dragRef.current === null) {
									return
								}

								event.preventDefault()

								const rect = event.currentTarget.getBoundingClientRect()
								const lower = event.clientY > rect.top + rect.height / 2

								if (drop?.row !== item.index || drop.lower !== lower) {
									setDrop({ row: item.index, lower })
								}
							}}
							onDragLeave={() => {
								if (drop?.row === item.index) {
									setDrop(null)
								}
							}}
							onDrop={event => {
								onDrop(event, item.index)
							}}
						>
							{row.parent ? (
								<button
									type="button"
									aria-label={t(row.collapsed ? "previewDocxNavigationExpand" : "previewDocxNavigationCollapse", {
										heading: row.entry.text
									})}
									aria-expanded={!row.collapsed}
									className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent"
									onClick={() => {
										onToggle(row)
									}}
								>
									{row.collapsed ? <ChevronRightIcon className="size-3.5" /> : <ChevronDownIcon className="size-3.5" />}
								</button>
							) : (
								<span className="size-5 shrink-0" />
							)}
							<button
								type="button"
								draggable={movable(row.index)}
								aria-current={isCurrent ? "location" : undefined}
								title={row.entry.text}
								className={cn(
									"min-w-0 flex-1 truncate rounded px-1.5 py-1 text-left text-xs hover:bg-accent",
									row.depth === 0 && "font-medium",
									isCurrent && "bg-accent text-accent-foreground"
								)}
								onClick={() => {
									onGo(row)
								}}
								onDragStart={event => {
									dragRef.current = row.index
									event.dataTransfer.effectAllowed = "move"
									event.dataTransfer.setData("text/plain", row.entry.text)
								}}
								onDragEnd={() => {
									dragRef.current = null
									setDrop(null)
								}}
							>
								{row.entry.text}
							</button>
						</li>
					)
				})}
			</ul>
		</div>
	)
}

// Whether entry `current` is under the collapsed heading of row `row` (before the next row's heading).
function isUnder(rows: readonly HeadingRow[], row: number, current: number): boolean {
	const next = rows[row + 1]

	return next === undefined || current < next.index
}

function PageThumbnail({
	editor,
	index,
	width,
	height,
	current,
	onGo
}: {
	editor: PagedEditor
	index: number
	width: number
	height: number
	current: boolean
	onGo: (index: number) => void
}) {
	const { t } = useTranslation("preview")
	const canvasRef = useRef<HTMLCanvasElement | null>(null)
	const page = editor.page(index)

	// Painted again only when the page was laid out again (a new display list).
	useEffect(() => {
		const canvas = canvasRef.current

		if (canvas !== null && page !== undefined) {
			paintThumbnail(canvas, page, width, window.devicePixelRatio, getComputedStyle(canvas).color)
		}
	}, [page, width])

	return (
		<button
			type="button"
			aria-label={t("previewDocxNavigationPage", { page: index + 1 })}
			aria-current={current ? "page" : undefined}
			className="group flex flex-col items-center gap-1 outline-none"
			onClick={() => {
				onGo(index)
			}}
		>
			<canvas
				ref={canvasRef}
				aria-hidden
				className={cn(
					"rounded-[2px] bg-white text-neutral-700 shadow-sm ring-1 ring-border group-focus-visible:ring-2 group-focus-visible:ring-ring",
					current && "ring-2 ring-primary"
				)}
				style={{ width, height }}
			/>
			<span className="text-xs text-muted-foreground tabular-nums">{index + 1}</span>
		</button>
	)
}

function PagesTab({ editor, handleRef, pages, focusEditor }: TabProps & { pages: DocxPageStore }) {
	const [scroller, setScroller] = useState<HTMLDivElement | null>(null)
	// Bumped (once a frame at most) as pages are laid out: the thumbnails in view read their pages again.
	const [, setVersion] = useState(0)
	const { page: inView } = useSyncExternalStore(pages.subscribe, pages.get)
	const count = editor.pageCount
	const sizeOf = (index: number): number => {
		const page = editor.page(index) ?? editor.page(count - 1)

		return page === undefined ? THUMB_WIDTH : thumbnailHeight(page.width, page.height, THUMB_WIDTH)
	}
	const virtualizer = useVirtualizer({
		count,
		getScrollElement: () => scroller,
		observeElementOffset: observeElementOffsetFromAttach,
		initialRect: INITIAL_RECT,
		estimateSize: index => sizeOf(index) + THUMB_LABEL,
		overscan: 2
	})

	useEffect(() => {
		let frame = 0
		const stop = editor.subscribe(event => {
			if (event.type === "pages" && frame === 0) {
				frame = requestAnimationFrame(() => {
					frame = 0
					setVersion(version => version + 1)
				})
			}
		})

		return () => {
			stop()

			if (frame !== 0) {
				cancelAnimationFrame(frame)
			}
		}
	}, [editor])

	const go = (index: number): void => {
		handleRef.current?.goToPage(index)
		focusEditor()
	}

	return (
		<div
			ref={setScroller}
			className="min-h-0 flex-1 overflow-y-auto py-2"
		>
			<div
				className="relative"
				style={{ height: virtualizer.getTotalSize() }}
			>
				{virtualizer.getVirtualItems().map(item => (
					<div
						key={item.index}
						className="absolute inset-x-0 flex justify-center"
						style={{ top: item.start, height: item.size }}
					>
						<PageThumbnail
							editor={editor}
							index={item.index}
							width={THUMB_WIDTH}
							height={sizeOf(item.index)}
							current={item.index === inView}
							onGo={go}
						/>
					</div>
				))}
			</div>
		</div>
	)
}

function ResultsTab({
	editor,
	query,
	active,
	results,
	onResult
}: {
	editor: PagedEditor
	query: string
	active: number
	results: DocxNavigationPaneProps["results"]
	onResult: (index: number) => void
}) {
	const { t } = useTranslation("preview")
	const [scroller, setScroller] = useState<HTMLDivElement | null>(null)
	const { stories, matches } = results
	const searched = stories.length > 0
	const virtualizer = useVirtualizer({
		count: searched ? matches.length : 0,
		getScrollElement: () => scroller,
		observeElementOffset: observeElementOffsetFromAttach,
		initialRect: INITIAL_RECT,
		estimateSize: () => RESULT_ROW,
		overscan: OVERSCAN
	})
	// The current match's row stays in view as Enter and the arrows step through them.
	useEffect(() => {
		if (active >= 0) {
			virtualizer.scrollToIndex(active, { align: "auto" })
		}
	}, [active, virtualizer])

	if (query.length === 0 || !searched) {
		return <p className="px-3 py-4 text-xs text-muted-foreground">{t("previewDocxNavigationSearchHint")}</p>
	}

	if (matches.length === 0) {
		return <p className="px-3 py-4 text-xs text-muted-foreground">{t("previewDocxNavigationNoMatches")}</p>
	}

	return (
		<div
			ref={setScroller}
			className="min-h-0 flex-1 overflow-y-auto py-1"
		>
			<ul
				aria-label={t("previewDocxNavigationResults")}
				className="relative"
				style={{ height: virtualizer.getTotalSize() }}
			>
				{virtualizer.getVirtualItems().map(item => {
					const match = matches[item.index]
					// A few stories: found by a scan, for the rows in view only.
					const doc = match === undefined ? undefined : stories.find(entry => entry.story === match.story)?.doc

					if (match === undefined || doc === undefined) {
						return null
					}

					const context = matchContext(doc, match)
					const label = storyLabel(editor.edits.model.stories[match.story]?.kind)

					return (
						<li
							key={item.index}
							className="absolute inset-x-0 px-2"
							style={{ top: item.start, height: item.size }}
						>
							<Button
								variant="ghost"
								aria-current={item.index === active ? "true" : undefined}
								className={cn(
									"h-full w-full justify-start overflow-hidden px-2 py-1 text-left text-xs font-normal whitespace-normal",
									item.index === active && "bg-accent"
								)}
								onClick={() => {
									onResult(item.index)
								}}
							>
								<span className="line-clamp-2 break-words">
									{label === undefined ? null : <span className="mr-1 text-muted-foreground">{t(label)}</span>}
									{context.before}
									<mark className="rounded-[2px] bg-yellow-200 px-0.5 font-semibold text-inherit dark:bg-yellow-500/40">
										{context.match}
									</mark>
									{context.after}
								</span>
							</Button>
						</li>
					)
				})}
			</ul>
		</div>
	)
}

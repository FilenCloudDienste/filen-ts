import {
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	useSyncExternalStore,
	type KeyboardEvent,
	type ReactNode,
	type WheelEvent
} from "react"
import { useTranslation } from "react-i18next"
import { preview } from "@/locales/en/preview"
import { CheckIcon, MessageSquareTextIcon, MoreHorizontalIcon, XIcon } from "lucide-react"
import { cn } from "@filen/shared"
import { isImeKeydown, isMacPlatform, matchesCombo } from "@filen/shared/keymap"
import type { DocxEditorCommand } from "@filen/office/core/docx/edit"
import type { DocxCommentThread, DocxComment as LiveComment, EditAnnotationRevision, PagedEditor } from "@filen/office/core/docx/paged"
import { markupInfo, revisionColor, type DocxMarkupMode } from "@filen/office/dom/docx"
import type { DocxObjectPress, DocxPageOverlay } from "@filen/office/react/docx/editor"
import type { DocxAuthorGate } from "@/features/preview/components/docxAuthorGate.logic"
import { useInputForm, type DocxInputChannelProps } from "@/features/preview/components/docxEditor.logic"
import { Byline } from "@/features/preview/components/docxAnnotations"
import {
	asideRoom,
	changeTitle,
	type ReviewTranslate,
	pageBalloons,
	placeColumn,
	reviewDate,
	reviewView,
	sessionSubscriber,
	threadAt,
	type ReviewAnchor,
	type ReviewBalloon,
	type ReviewPage,
	type ReviewView
} from "@/features/preview/components/docxReview.logic"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useLatestRef } from "@/lib/useLatestRef"

const IS_MAC = isMacPlatform()

// Takes comment.add input requests (a new comment composed at the selection).
export interface DocxReviewLayerProps extends DocxInputChannelProps {
	editor: PagedEditor
	// Unused: the hub's to drop (nothing here depends on the renderer's document).
	document?: unknown
	markup: DocxMarkupMode
	zoom: number
	// Space between pages (px at 100 %).
	gap: number
	// The scrolling element the pages are in.
	container: HTMLDivElement | null
	readOnly: boolean
	execute: (command: DocxEditorCommand) => void
	withAuthor: DocxAuthorGate
	// The last press on a comment marker, until dismissed.
	press: DocxObjectPress | null
	onPressDone: () => void
}

// Space between the page and the balloon column, and between balloons (screen px).
const COLUMN_GAP = 16
const BALLOON_GAP = 8
const MIN_BALLOON_WIDTH = 200
const MAX_BALLOON_WIDTH = 248
const ESTIMATED_HEIGHT = 64
// Where a balloon's connector meets it, below its top.
const CONNECTOR_Y = 14
const MORE_HEIGHT = 28
// Comment markers closer than this on screen share one marker.
const MARKER_SPACING = 26
// A pointer resting this long on a tracked change shows its card; leaving it this long hides it.
const HOVER_SHOW_MS = 350
const HOVER_HIDE_MS = 250
const COMMENT_FIELD_CLASS =
	"max-h-40 min-h-16 w-full resize-none rounded-xl border border-border bg-background px-2 py-1.5 text-xs leading-5 outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
// Text fields and menus in the review layer keep their own keys and presses (DocxEditor's input does not).
const REVIEW_ATTRIBUTE = { "data-docx-review": "" }

const SIZES = { estimate: ESTIMATED_HEIGHT, connector: CONNECTOR_Y, gap: BALLOON_GAP, more: MORE_HEIGHT }

// The thread of the comment holding the caret, as the toolbar's snapshot tells (the same string while it is).
function useCaretThread(editor: PagedEditor): string | null {
	return useSyncExternalStore(
		sessionSubscriber(editor),
		() => editor.snapshot().context.comment?.thread ?? null,
		() => null
	)
}

function authorColor(authors: readonly string[], name: string | undefined): string {
	return revisionColor(name === undefined ? -1 : authors.indexOf(name.trim()))
}

function commentDate(comment: LiveComment): string {
	return reviewDate(comment.dateUtc ?? comment.date)
}

// Mod+Enter (Cmd on a Mac, Ctrl elsewhere) submits a comment field, Escape cancels it; neither while an input method
// composes, whose Enter commits its text and whose Escape cancels it.
function fieldKeys(event: KeyboardEvent<HTMLTextAreaElement>, submit: () => void, cancel: () => void): void {
	if (isImeKeydown(event.nativeEvent)) {
		return
	}

	if (matchesCombo(event, "mod+enter", IS_MAC)) {
		event.preventDefault()
		submit()
	} else if (event.key === "Escape") {
		event.preventDefault()
		event.stopPropagation()
		cancel()
	}
}

// A comment field with its buttons: a new comment, a reply, or a comment's text being edited.
export function CommentField({
	initial,
	placeholder,
	submitLabel,
	onSubmit,
	onCancel,
	autoFocus
}: {
	initial: string
	placeholder: string
	submitLabel: string
	onSubmit: (text: string) => void
	onCancel: () => void
	autoFocus: boolean
}) {
	const { t } = useTranslation("preview")
	const [text, setText] = useState(initial)
	const empty = text.trim().length === 0
	const submit = (): void => {
		if (!empty) {
			onSubmit(text.replace(/\r\n?/g, "\n"))
		}
	}

	return (
		<div
			className="flex flex-col gap-1.5"
			{...REVIEW_ATTRIBUTE}
		>
			<textarea
				value={text}
				aria-label={placeholder}
				placeholder={placeholder}
				// The editor's own field had focus: the comment field takes it once shown.
				autoFocus={autoFocus}
				rows={2}
				className={COMMENT_FIELD_CLASS}
				onChange={event => {
					setText(event.target.value)
				}}
				onKeyDown={event => {
					fieldKeys(event, submit, onCancel)
				}}
			/>
			<div className="flex justify-end gap-1">
				<Button
					type="button"
					variant="ghost"
					size="xs"
					onClick={onCancel}
				>
					{t("previewDocxCommentCancel")}
				</Button>
				<Button
					type="button"
					size="xs"
					disabled={empty}
					onClick={submit}
				>
					{submitLabel}
				</Button>
			</div>
		</div>
	)
}

function CommentMenu({
	comment,
	readOnly,
	thread,
	execute,
	onEdit
}: {
	comment: LiveComment
	readOnly: boolean
	thread: DocxCommentThread
	execute: (command: DocxEditorCommand) => void
	onEdit: () => void
}) {
	const { t } = useTranslation("preview")
	const root = comment.id === thread.id
	const canResolve = root && comment.canResolve

	if (readOnly || !(comment.canEdit || comment.canDelete || canResolve)) {
		return null
	}

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<Button
						variant="ghost"
						size="icon-xs"
						aria-label={t("previewDocxCommentActions")}
					/>
				}
			>
				<MoreHorizontalIcon />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				{comment.canEdit ? <DropdownMenuItem onClick={onEdit}>{t("previewDocxCommentEdit")}</DropdownMenuItem> : null}
				{canResolve ? (
					<DropdownMenuItem
						onClick={() => {
							execute({ type: thread.done ? "comment.reopen" : "comment.resolve", id: thread.id })
						}}
					>
						{thread.done ? t("previewDocxCommentReopen") : t("previewDocxCommentResolve")}
					</DropdownMenuItem>
				) : null}
				{comment.canDelete ? (
					<DropdownMenuItem
						variant="destructive"
						onClick={() => {
							execute({ type: "comment.delete", id: comment.id })
						}}
					>
						{t("previewDocxCommentDelete")}
					</DropdownMenuItem>
				) : null}
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

// One comment of a thread: who and when, its text (or a field changing it) and its ⋯ menu.
function ThreadComment({
	comment,
	thread,
	authors,
	readOnly,
	expanded,
	execute,
	withAuthor
}: {
	comment: LiveComment
	thread: DocxCommentThread
	authors: readonly string[]
	readOnly: boolean
	expanded: boolean
	execute: (command: DocxEditorCommand) => void
	withAuthor: DocxAuthorGate
}) {
	const { t } = useTranslation("preview")
	const [editing, setEditing] = useState(false)

	return (
		<div className="flex flex-col gap-1">
			<div className="flex items-center justify-between gap-2">
				<Byline
					name={comment.author ?? t("previewDocxUnknownAuthor")}
					date={commentDate(comment)}
					color={authorColor(authors, comment.author)}
				/>
				<div className="flex shrink-0 items-center gap-1">
					{comment.id === thread.id && thread.done ? (
						<span className="text-muted-foreground">{t("previewDocxCommentResolved")}</span>
					) : null}
					<CommentMenu
						comment={comment}
						readOnly={readOnly}
						thread={thread}
						execute={execute}
						onEdit={() => {
							setEditing(true)
						}}
					/>
				</div>
			</div>
			{editing && !readOnly ? (
				<CommentField
					initial={comment.text.replaceAll(" ", "\n")}
					placeholder={t("previewDocxCommentPlaceholder")}
					submitLabel={t("previewDocxCommentSave")}
					autoFocus
					onCancel={() => {
						setEditing(false)
					}}
					// The field stays (with what was typed) until there is a name to edit with.
					onSubmit={text => {
						withAuthor(() => {
							setEditing(false)
							execute({ type: "comment.edit", id: comment.id, text })
						})
					}}
				/>
			) : (
				<p className={cn("break-words whitespace-pre-wrap", !expanded && "line-clamp-4")}>{comment.text.replaceAll(" ", "\n")}</p>
			)}
		</div>
	)
}

// A comment thread: its first comment, the replies, and (expanded) the reply field. Shared by the margin
// balloons and the popover.
export function CommentThreadCard({
	thread,
	authors,
	readOnly,
	expanded,
	execute,
	withAuthor
}: {
	thread: DocxCommentThread
	authors: readonly string[]
	readOnly: boolean
	expanded: boolean
	execute: (command: DocxEditorCommand) => void
	withAuthor: DocxAuthorGate
}) {
	const { t } = useTranslation("preview")
	const [replying, setReplying] = useState(false)

	return (
		<div className={cn("flex flex-col gap-2", thread.done && !expanded && "opacity-70")}>
			{[thread.comment, ...thread.replies].map((comment, k) => (
				<div
					key={comment.id}
					className={cn(k > 0 && "border-t border-border pt-2")}
				>
					<ThreadComment
						comment={comment}
						thread={thread}
						authors={authors}
						readOnly={readOnly}
						expanded={expanded}
						execute={execute}
						withAuthor={withAuthor}
					/>
				</div>
			))}
			{expanded && !readOnly && thread.comment.canReply ? (
				replying ? (
					<CommentField
						initial=""
						placeholder={t("previewDocxReplyPlaceholder")}
						submitLabel={t("previewDocxCommentReply")}
						autoFocus
						onCancel={() => {
							setReplying(false)
						}}
						onSubmit={text => {
							withAuthor(() => {
								setReplying(false)
								execute({ type: "comment.reply", id: thread.id, text })
							})
						}}
					/>
				) : (
					<button
						type="button"
						className="rounded-xl border border-border px-2 py-1.5 text-left text-muted-foreground outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/30"
						onClick={event => {
							event.stopPropagation()
							setReplying(true)
						}}
					>
						{t("previewDocxReplyPlaceholder")}
					</button>
				)
			) : null}
		</div>
	)
}

// A tracked change: who, when, what, and (writable) Accept and Reject.
export function ChangeCard({
	revision,
	authors,
	readOnly,
	execute
}: {
	revision: EditAnnotationRevision
	authors: readonly string[]
	readOnly: boolean
	execute: (command: DocxEditorCommand) => void
}) {
	const { t } = useTranslation("preview")
	// Keys picked at run time: the catalog's English as the default value lets any of them take values.
	const translate: ReviewTranslate = (key, values) => (values === undefined ? t(key) : t(key, { ...values, defaultValue: preview[key] }))

	return (
		<div className="flex flex-col gap-1.5">
			<Byline
				name={authors[revision.author] ?? t("previewDocxUnknownAuthor")}
				date={reviewDate(revision.date)}
				color={revisionColor(revision.author)}
			/>
			<p className="break-words">
				<span className="font-medium">{changeTitle(revision, translate)}</span>
				{revision.text.length > 0 ? <span className="text-muted-foreground"> “{revision.text}”</span> : null}
			</p>
			{readOnly ? null : (
				<div className="flex gap-1">
					<Button
						type="button"
						size="xs"
						variant="outline"
						onClick={() => {
							execute({ type: "review.accept", id: revision.id })
						}}
					>
						<CheckIcon data-icon="inline-start" />
						{t("previewDocxAccept")}
					</Button>
					<Button
						type="button"
						size="xs"
						variant="outline"
						onClick={() => {
							execute({ type: "review.reject", id: revision.id })
						}}
					>
						<XIcon data-icon="inline-start" />
						{t("previewDocxReject")}
					</Button>
				</div>
			)}
		</div>
	)
}

// What a page shows of the review in page px: commented text shaded in its author's colour (strongest for the
// active thread) and change bars beside changed lines. Tells the review layer the page is mounted.
export interface DocxReviewPageOverlayProps {
	page: DocxPageOverlay
	editor: PagedEditor
	markup: DocxMarkupMode
}

export function DocxReviewPageOverlay({ page, editor, markup }: DocxReviewPageOverlayProps) {
	const view = reviewView(editor)
	const index = page.index
	const shown = useSyncExternalStore(view.subscribe, () => view.page(index))
	const active = useSyncExternalStore(view.subscribe, view.active)
	const [element, setElement] = useState<HTMLDivElement | null>(null)

	// Told on every render: the page's place may have changed (zoom, the view's width).
	useLayoutEffect(() => {
		const pageElement = element?.closest<HTMLElement>("[data-fo-page]") ?? null

		if (pageElement === null) {
			return
		}

		view.mount(index, pageElement)

		return () => {
			view.unmount(index, pageElement)
		}
	})

	return (
		<div
			ref={setElement}
			aria-hidden="true"
			className="absolute inset-0"
		>
			{shown === undefined ? null : (
				<PageMarks
					page={shown}
					markup={markup}
					active={active}
				/>
			)}
		</div>
	)
}

function PageMarks({ page, markup, active }: { page: ReviewPage; markup: DocxMarkupMode; active: string | null }) {
	const info = markupInfo(markup)
	const marks: ReactNode[] = []

	if (info.highlights || active !== null) {
		for (let k = 0; k < page.boxThreads.length; k++) {
			const current = page.boxThreads[k] === active

			if (!info.highlights && !current) {
				continue
			}

			const f = k * 4

			marks.push(
				<div
					key={k}
					className="absolute mix-blend-multiply"
					style={{
						left: page.boxes[f] ?? 0,
						top: page.boxes[f + 1] ?? 0,
						width: Math.max(2, page.boxes[f + 2] ?? 0),
						height: page.boxes[f + 3] ?? 0,
						backgroundColor: `color-mix(in oklab, ${revisionColor(page.boxAuthors[k] ?? -1)} ${current ? "38%" : "16%"}, transparent)`
					}}
				/>
			)
		}
	}

	if (info.changeBars) {
		for (let k = 0; k + 1 < page.bars.length; k += 2) {
			marks.push(
				<div
					key={`bar${String(k)}`}
					className="absolute"
					style={{
						left: page.barX,
						top: page.bars[k] ?? 0,
						width: 2,
						height: page.bars[k + 1] ?? 0,
						backgroundColor: info.highlights
							? "var(--fo-revision-bar)"
							: "var(--fo-revision-bar-simple, var(--fo-revision-bar))"
					}}
				/>
			)
		}
	}

	return marks
}

interface Compose {
	readonly page: number
	readonly x: number
	readonly y: number
	readonly height: number
}

interface Card {
	readonly id: string
	// Content px.
	readonly x: number
	readonly y: number
	readonly source: "hover" | "caret"
}

// What every page's column gets from the layer: the same values while nothing the columns show changed.
interface ColumnProps {
	view: ReviewView
	zoom: number
	markup: DocxMarkupMode
	width: number
	activeKey: string | null
	heights: ReadonlyMap<string, number>
	readOnly: boolean
	execute: (command: DocxEditorCommand) => void
	withAuthor: DocxAuthorGate
	register: (element: HTMLElement | null) => (() => void) | undefined
	onActivate: (key: string | null) => void
	onComposed: (text: string | null) => void
}

// Comment balloons in the margin beside their anchors, composed and edited in place (a field in the balloon, a
// reply field under the thread), formatting changes with Accept and Reject, and a card for the tracked change
// under the pointer (or reached with the caret). Without room beside the pages, markers at the pages' edge
// open the threads in a popover (DocxCommentPopover composes then). Drawn over the editor's scrolled pages,
// following their scroll. Each page's column reads its own page: a keystroke draws again only the page whose
// annotations moved.
export function DocxReviewLayer({
	editor,
	markup,
	zoom,
	readOnly,
	execute,
	withAuthor,
	press,
	onPressDone,
	inputRequest,
	onInputDone
}: DocxReviewLayerProps) {
	const { t } = useTranslation("preview")
	const view = reviewView(editor)
	const layout = useSyncExternalStore(view.subscribe, view.layout)
	const scroller = layout.scroller
	const innerRef = useRef<HTMLDivElement | null>(null)
	const caretThread = useCaretThread(editor)
	const caretRef = useLatestRef(caretThread)
	const executeRef = useLatestRef(execute)
	const [picked, setPicked] = useState<{ key: string; caret: string | null } | null>(null)
	const [card, setCard] = useState<Card | null>(null)
	const [heights, setHeights] = useState<ReadonlyMap<string, number>>(() => new Map())
	const [observer] = useState(() =>
		typeof ResizeObserver === "function"
			? new ResizeObserver(entries => {
					setHeights(previous => {
						const changed: [string, number][] = []

						for (const entry of entries) {
							const key = entry.target instanceof HTMLElement ? entry.target.dataset["balloon"] : undefined
							const height = entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height

							if (key !== undefined && Math.abs((previous.get(key) ?? -1) - height) >= 1) {
								changed.push([key, height])
							}
						}

						return changed.length === 0 ? previous : new Map([...previous, ...changed])
					})
				})
			: null
	)
	// Stable for the layer's life: the columns take no new props from them.
	const [register] = useState(() => (element: HTMLElement | null): (() => void) | undefined => {
		if (element === null || observer === null) {
			return undefined
		}

		observer.observe(element)

		return () => {
			observer.unobserve(element)
		}
	})
	const [onActivate] = useState(() => (key: string | null): void => {
		setPicked(key === null ? null : { key, caret: caretRef.current })
	})
	// The request a balloon composes for, until it is done with (posted or dropped).
	const composingRef = useRef<number | null>(null)
	const onInputDoneRef = useLatestRef(onInputDone)
	const [onComposed] = useState(() => (text: string | null): void => {
		const nonce = composingRef.current

		if (nonce !== null) {
			onInputDoneRef.current(nonce)
		}

		if (text !== null) {
			executeRef.current({ type: "comment.add", text })
		}
	})
	const room = asideRoom(layout.frames, layout.width, COLUMN_GAP)
	const aside = layout.frames.length > 0 && room >= MIN_BALLOON_WIDTH
	const balloonWidth = Math.min(MAX_BALLOON_WIDTH, room)
	// A balloon picked stays active until the caret moves to another thread.
	const activeKey = picked !== null && picked.caret === caretThread ? picked.key : caretThread === null ? null : `c:${caretThread}`
	const activeThread = activeKey?.startsWith("c:") === true ? activeKey.slice(2) : null

	useEffect(() => {
		view.setAside(aside)
	}, [view, aside])

	useEffect(() => {
		view.setActive(activeThread)
	}, [view, activeThread])

	useEffect(() => {
		return () => {
			observer?.disconnect()
		}
	}, [observer])

	// The balloons move with the pages' scroll (set directly: no render per scroll step).
	useEffect(() => {
		const inner = innerRef.current

		if (scroller === null || inner === null) {
			return
		}

		const sync = (): void => {
			inner.style.transform = `translate(${String(-scroller.scrollLeft)}px, ${String(-scroller.scrollTop)}px)`
		}

		sync()
		scroller.addEventListener("scroll", sync, { passive: true })

		return () => {
			scroller.removeEventListener("scroll", sync)
		}
	}, [scroller])

	// A new comment is composed in a balloon beside the selection's end when there is room (else the popover takes
	// the request), the request held while it is.
	const composing = useInputForm<Compose>(
		inputRequest,
		request => request.type === "comment.add" && aside,
		() => {
			const end = editor.ends().end

			return readOnly || end === undefined || !editor.canExecute("comment.add")
				? null
				: { page: end.page, x: end.x, y: end.top, height: end.height }
		}
	)
	const compose = composing.form
	const composingNonce = composing.request?.nonce ?? null

	useEffect(() => {
		composingRef.current = composingNonce

		// Asked where no comment can be added: done at once.
		if (composingNonce !== null && compose === null) {
			onInputDone(composingNonce)
		}
	}, [composingNonce, compose, onInputDone])

	// A press on a comment's marker activates its thread. Taken while rendering, told done after.
	const [taken, setTaken] = useState<DocxObjectPress | null>(null)

	if (press !== null && aside && taken !== press) {
		const id = press.hit.part ?? threadAt(view.comments, press.hit.story, press.hit.pos)

		setTaken(press)

		if (id !== undefined) {
			setPicked({ key: `c:${view.comments.threadOf(id) ?? id}`, caret: caretThread })
		}
	}

	useEffect(() => {
		if (taken !== null) {
			onPressDone()
		}
	}, [taken, onPressDone])

	// The tracked change under a resting pointer shows its card (pages in view only, once a frame).
	const hoverable = layout.revisions && (markupInfo(markup).view === "markup" || markupInfo(markup).changeBars)
	const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

	useEffect(() => {
		if (scroller === null || !hoverable) {
			return
		}

		let frame = 0
		let point = { x: 0, y: 0 }
		let shown: string | null = null
		const probe = (): void => {
			frame = 0

			const rect = scroller.getBoundingClientRect()
			const x = point.x - rect.left + scroller.scrollLeft
			const y = point.y - rect.top + scroller.scrollTop
			const target = view
				.layout()
				.frames.find(
					candidate =>
						x >= candidate.left &&
						x <= candidate.left + candidate.width &&
						y >= candidate.top &&
						y <= candidate.top + candidate.height
				)
			const hit =
				target === undefined || editor.session !== editor.body.session
					? undefined
					: editor.hitTest(target.index, (x - target.left) / zoom, (y - target.top) / zoom)
			const id = (hit === undefined ? undefined : view.annotations.changeAt(editor.activeStory, hit.pos)?.id) ?? null

			if (id === shown) {
				return
			}

			shown = id
			clearTimeout(hoverTimer.current)
			hoverTimer.current = setTimeout(
				() => {
					setCard(previous =>
						id === null ? (previous?.source === "hover" ? null : previous) : { id, x: x + 8, y: y + 12, source: "hover" }
					)
				},
				id === null ? HOVER_HIDE_MS : HOVER_SHOW_MS
			)
		}
		const onMove = (event: PointerEvent): void => {
			if (event.pointerType !== "mouse") {
				return
			}

			point = { x: event.clientX, y: event.clientY }

			if (frame === 0) {
				frame = requestAnimationFrame(probe)
			}
		}

		scroller.addEventListener("pointermove", onMove, { passive: true })

		return () => {
			scroller.removeEventListener("pointermove", onMove)
			cancelAnimationFrame(frame)
			clearTimeout(hoverTimer.current)
		}
	}, [scroller, hoverable, view, editor, zoom])

	// The change the caret reached by moving (a click, Previous/Next change, the keyboard) shows its card; an edit
	// hides it.
	const currentChange = useSyncExternalStore(
		sessionSubscriber(editor),
		() => editor.snapshot().review.current,
		() => null
	)
	const caretCard = useRef<{ doc: unknown; shown: boolean }>({ doc: null, shown: false })

	useEffect(() => {
		const seen = caretCard.current

		seen.doc = editor.state.doc

		return editor.subscribeSession(() => {
			const doc = editor.state.doc

			if (doc === seen.doc) {
				return
			}

			seen.doc = doc

			if (seen.shown) {
				seen.shown = false
				setCard(previous => (previous?.source === "caret" ? null : previous))
			}
		})
	}, [editor])

	useEffect(() => {
		const seen = caretCard.current
		const caret = currentChange === null ? undefined : editor.caret()
		const frame = caret === undefined ? undefined : view.layout().frames.find(candidate => candidate.index === caret.page)

		// Reached by typing (the document changed with it): no card.
		if (currentChange === null || caret === undefined || frame === undefined || seen.doc !== editor.state.doc) {
			seen.shown = false
			setCard(previous => (previous?.source === "caret" ? null : previous))

			return
		}

		seen.shown = true
		setCard({
			id: currentChange,
			x: frame.left + caret.x * zoom,
			y: frame.top + (caret.top + caret.height) * zoom + 6,
			source: "caret"
		})
	}, [currentChange, editor, view, zoom])

	const columnProps: ColumnProps = {
		view,
		zoom,
		markup,
		width: balloonWidth,
		activeKey: activeKey ?? (compose === null ? null : "new"),
		heights,
		readOnly,
		execute,
		withAuthor,
		register,
		onActivate,
		onComposed
	}

	return (
		<div
			aria-label={t("previewDocxComments")}
			role="complementary"
			className="pointer-events-none absolute top-0 left-0 overflow-hidden"
			style={{ width: layout.width, height: layout.height }}
			onWheel={(event: WheelEvent) => {
				if (!event.ctrlKey && !event.metaKey) {
					scroller?.scrollBy({ left: event.deltaX, top: event.deltaY })
				}
			}}
			{...REVIEW_ATTRIBUTE}
		>
			<div
				ref={innerRef}
				className="absolute top-0 left-0"
			>
				{layout.frames.map(frame =>
					aside ? (
						<PageColumn
							key={frame.index}
							index={frame.index}
							compose={compose?.page === frame.index ? compose : null}
							{...columnProps}
						/>
					) : (
						<PageMarkers
							key={frame.index}
							index={frame.index}
							{...columnProps}
						/>
					)
				)}
				{card === null ? null : (
					<ChangePopup
						view={view}
						card={card}
						readOnly={readOnly}
						onEnter={() => {
							clearTimeout(hoverTimer.current)
						}}
						onClose={() => {
							setCard(null)
						}}
						execute={execute}
					/>
				)}
			</div>
		</div>
	)
}

// The card of the tracked change `card.id`, while it is on the pages in view.
function ChangePopup({
	view,
	card,
	readOnly,
	onEnter,
	onClose,
	execute
}: {
	view: ReviewView
	card: Card
	readOnly: boolean
	onEnter: () => void
	onClose: () => void
	execute: (command: DocxEditorCommand) => void
}) {
	const { t } = useTranslation("preview")
	const revision = useSyncExternalStore(view.subscribe, () => view.revision(card.id))
	const authors = useSyncExternalStore(view.subscribe, view.authors)

	if (revision === undefined) {
		return null
	}

	return (
		<div
			role="dialog"
			aria-label={t("previewDocxChangeCard", { author: authors[revision.author] ?? t("previewDocxUnknownAuthor") })}
			className="pointer-events-auto absolute z-20 w-64 rounded-xl border border-border bg-popover p-2.5 text-xs text-popover-foreground shadow-md"
			style={{ left: card.x, top: card.y, borderLeftColor: revisionColor(revision.author) }}
			onPointerEnter={onEnter}
			onPointerLeave={() => {
				if (card.source === "hover") {
					onClose()
				}
			}}
			onKeyDown={event => {
				if (event.key === "Escape") {
					onClose()
				}
			}}
		>
			<ChangeCard
				revision={revision}
				authors={authors}
				readOnly={readOnly}
				execute={command => {
					onClose()
					execute(command)
				}}
			/>
		</div>
	)
}

// One page's balloon column, with the lines joining each balloon to its text: drawn again only when that
// page's annotations, the threads or the layer's choices change.
function PageColumn({
	view,
	index,
	compose,
	zoom,
	markup,
	width,
	activeKey,
	heights,
	readOnly,
	execute,
	withAuthor,
	register,
	onActivate,
	onComposed
}: ColumnProps & { index: number; compose: Compose | null }) {
	const { t } = useTranslation("preview")
	// What the balloons read of the page, each kept while unchanged: not drawn again for a change typed there.
	const frame = useSyncExternalStore(view.subscribe, () => view.page(index)?.frame)
	const pageThreads = useSyncExternalStore(view.subscribe, () => view.page(index)?.threads)
	const changes = useSyncExternalStore(view.subscribe, () => view.page(index)?.changes)
	const threads = useSyncExternalStore(view.subscribe, view.threads)
	const authors = useSyncExternalStore(view.subscribe, view.authors)
	const info = markupInfo(markup)

	if (frame === undefined || pageThreads === undefined || changes === undefined) {
		return null
	}

	const balloons = pageBalloons({ threads: pageThreads, changes }, { comments: info.comments, formatting: info.formatting }, compose)

	if (balloons.length === 0) {
		return null
	}
	const placed = placeColumn(balloons, frame, zoom, heights, activeKey, SIZES)
	const left = frame.left + frame.width + COLUMN_GAP
	const shown = balloons.slice(0, placed.shown)

	return (
		<div>
			<svg
				aria-hidden="true"
				className="pointer-events-none absolute overflow-visible"
				style={{ left: frame.left, top: frame.top, width: frame.width + COLUMN_GAP, height: frame.height }}
			>
				{shown.map((balloon, k) => {
					const current = balloon.key === activeKey || balloon.kind === "compose"

					if (balloon.x < 0 || (!info.highlights && !current)) {
						return null
					}

					const ax = balloon.x * zoom
					const ay = (balloon.y + balloon.height) * zoom
					const by = (placed.tops[k] ?? 0) - frame.top + CONNECTOR_Y

					return (
						<path
							key={balloon.key}
							d={`M ${String(ax)} ${String(ay)} H ${String(frame.width)} L ${String(frame.width + COLUMN_GAP)} ${String(by)}`}
							fill="none"
							stroke={revisionColor(balloon.author)}
							strokeWidth={current ? 1.5 : 1}
							strokeDasharray={current ? undefined : "3 3"}
							opacity={current ? 1 : 0.7}
						/>
					)
				})}
			</svg>
			{shown.map((balloon, k) => (
				<Balloon
					key={balloon.key}
					balloon={balloon}
					top={placed.tops[k] ?? 0}
					left={left}
					width={width}
					active={balloon.key === activeKey || balloon.kind === "compose"}
					thread={threads.get(balloon.id)}
					authors={authors}
					readOnly={readOnly}
					execute={execute}
					withAuthor={withAuthor}
					register={register}
					onActivate={onActivate}
					onComposed={onComposed}
				/>
			))}
			{placed.shown < balloons.length ? (
				<Popover>
					<PopoverTrigger
						className="pointer-events-auto absolute flex items-center justify-center rounded-xl border border-border bg-popover text-xs font-medium text-popover-foreground shadow-sm outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50"
						style={{ left, top: placed.moreTop, width, height: MORE_HEIGHT }}
					>
						{t("previewDocxMoreBalloons", { count: balloons.length - placed.shown })}
					</PopoverTrigger>
					<PopoverContent
						align="start"
						className="max-h-96 w-72 gap-3 overflow-y-auto rounded-2xl p-3 text-xs"
						{...REVIEW_ATTRIBUTE}
					>
						{balloons.slice(placed.shown).map(balloon => (
							<BalloonBody
								key={balloon.key}
								balloon={balloon}
								thread={threads.get(balloon.id)}
								authors={authors}
								readOnly={readOnly}
								expanded
								execute={execute}
								withAuthor={withAuthor}
								onComposed={onComposed}
							/>
						))}
					</PopoverContent>
				</Popover>
			) : null}
		</div>
	)
}

function BalloonBody({
	balloon,
	thread,
	authors,
	readOnly,
	expanded,
	execute,
	withAuthor,
	onComposed
}: {
	balloon: ReviewBalloon
	thread: DocxCommentThread | undefined
	authors: readonly string[]
	readOnly: boolean
	expanded: boolean
	execute: (command: DocxEditorCommand) => void
	withAuthor: DocxAuthorGate
	onComposed: (text: string | null) => void
}) {
	const { t } = useTranslation("preview")

	if (balloon.kind === "compose") {
		return (
			<CommentField
				initial=""
				placeholder={t("previewDocxCommentPlaceholder")}
				submitLabel={t("previewDocxCommentPost")}
				autoFocus
				onCancel={() => {
					onComposed(null)
				}}
				// The field stays (with what was typed) until there is a name to comment with.
				onSubmit={text => {
					withAuthor(() => {
						onComposed(text)
					})
				}}
			/>
		)
	}

	if (balloon.kind === "change") {
		return balloon.revision === undefined ? null : (
			<ChangeCard
				revision={balloon.revision}
				authors={authors}
				readOnly={readOnly}
				execute={execute}
			/>
		)
	}

	return thread === undefined ? null : (
		<CommentThreadCard
			thread={thread}
			authors={authors}
			readOnly={readOnly}
			expanded={expanded}
			execute={execute}
			withAuthor={withAuthor}
		/>
	)
}

function Balloon({
	balloon,
	top,
	left,
	width,
	active,
	thread,
	authors,
	readOnly,
	execute,
	withAuthor,
	register,
	onActivate,
	onComposed
}: {
	balloon: ReviewBalloon
	top: number
	left: number
	width: number
	active: boolean
	thread: DocxCommentThread | undefined
	authors: readonly string[]
	readOnly: boolean
	execute: (command: DocxEditorCommand) => void
	withAuthor: DocxAuthorGate
	register: (element: HTMLElement | null) => (() => void) | undefined
	onActivate: (key: string | null) => void
	onComposed: (text: string | null) => void
}) {
	const { t } = useTranslation("preview")
	const author = balloon.kind === "thread" ? thread?.comment.author : authors[balloon.author]

	return (
		<article
			ref={register}
			data-balloon={balloon.key}
			aria-label={
				balloon.kind === "change"
					? t("previewDocxChangeCard", { author: author ?? t("previewDocxUnknownAuthor") })
					: t("previewDocxCommentThread", { author: author ?? t("previewDocxUnknownAuthor") })
			}
			className={cn(
				"pointer-events-auto absolute rounded-xl border border-l-[3px] border-border bg-popover p-2.5 text-xs text-popover-foreground shadow-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/30",
				active && "z-10 shadow-md"
			)}
			style={{
				left,
				top,
				width,
				borderLeftColor: balloon.kind === "thread" ? authorColor(authors, author) : revisionColor(balloon.author)
			}}
			tabIndex={balloon.kind === "compose" ? undefined : 0}
			onClick={() => {
				if (balloon.kind !== "compose" && !active) {
					onActivate(balloon.key)
				}
			}}
			onKeyDown={event => {
				if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
					event.preventDefault()
					onActivate(active ? null : balloon.key)
				}
			}}
		>
			<BalloonBody
				balloon={balloon}
				thread={thread}
				authors={authors}
				readOnly={readOnly}
				expanded={active}
				execute={execute}
				withAuthor={withAuthor}
				onComposed={onComposed}
			/>
		</article>
	)
}

// Without room for balloons: a marker at a page's right edge per group of nearby threads, the threads in a
// popover.
function PageMarkers({ view, index, zoom, markup, readOnly, execute, withAuthor }: ColumnProps & { index: number }) {
	const { t } = useTranslation("preview")
	// What the markers read of the page, each kept while unchanged: not drawn again for a change typed there.
	const frame = useSyncExternalStore(view.subscribe, () => view.page(index)?.frame)
	const pageThreads = useSyncExternalStore(view.subscribe, () => view.page(index)?.threads)
	const threads = useSyncExternalStore(view.subscribe, view.threads)
	const authors = useSyncExternalStore(view.subscribe, view.authors)

	if (frame === undefined || pageThreads === undefined || !markupInfo(markup).comments) {
		return null
	}

	const groups: ReviewAnchor[][] = []

	for (const anchor of pageThreads) {
		const group = groups[groups.length - 1]
		const first = group?.[0]

		if (group !== undefined && first !== undefined && Math.abs(first.y - anchor.y) * zoom < MARKER_SPACING) {
			group.push(anchor)
		} else {
			groups.push([anchor])
		}
	}

	return groups.map(group => {
		const first = group[0]
		const author = first === undefined ? undefined : threads.get(first.id)?.comment.author

		return first === undefined ? null : (
			<Popover key={first.id}>
				<PopoverTrigger
					aria-label={t("previewDocxCommentMarker", { author: author ?? t("previewDocxUnknownAuthor") })}
					className="pointer-events-auto absolute flex size-6 items-center justify-center rounded-full bg-popover shadow-sm ring-1 ring-border outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
					style={{
						left: frame.left + frame.width - 30,
						top: frame.top + Math.max(0, first.y * zoom - 2),
						color: authorColor(authors, author)
					}}
				>
					<MessageSquareTextIcon className="size-3.5" />
				</PopoverTrigger>
				<PopoverContent
					align="end"
					className="max-h-96 w-72 gap-3 overflow-y-auto rounded-2xl p-3 text-xs"
					{...REVIEW_ATTRIBUTE}
				>
					{group.map(anchor => {
						const thread = threads.get(anchor.id)

						return thread === undefined ? null : (
							<CommentThreadCard
								key={anchor.id}
								thread={thread}
								authors={authors}
								readOnly={readOnly}
								expanded
								execute={execute}
								withAuthor={withAuthor}
							/>
						)
					})}
				</PopoverContent>
			</Popover>
		)
	})
}

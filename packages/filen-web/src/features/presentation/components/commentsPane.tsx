import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual"
import { Menu as MenuPrimitive } from "@base-ui/react/menu"
import { ArrowLeftIcon, CheckIcon, MoreHorizontalIcon, PlusIcon, RotateCcwIcon, XIcon } from "lucide-react"
import { cn } from "@filen/shared"
import type { CommentView, DeckOp, SlideRef, SlideReview } from "@filen/office/core/presentation"
import { revisionColor } from "@filen/office/dom/docx"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { AuthorNameDialog } from "@/features/office/components/authorNameDialog"
import { ensureAuthorName, useOfficeSettings } from "@/features/office/lib/officeSettings"
import { Byline } from "@/features/preview/components/docxAnnotations"
import { CardField } from "@/features/spreadsheet/comments/annotationCards"
import type { PresentationRibbonEditor } from "@/features/presentation/components/ribbon/tabs"
import { formatShortDate } from "@/lib/formatDate"
import {
	focusSettled,
	newCommentGuid,
	slideReview,
	useSlideReview,
	useSlideReviewState
} from "@/features/presentation/components/commentsPane.logic"
import { useElementSize } from "@/lib/useElementSize"
import { observeElementOffsetFromAttach } from "@/lib/virtualScroll"

// The Comments pane beside the slide (Review ▸ Show Comments): the slide's threads (modern, legacy or ODF comments,
// core/presentation/comments.ts), each with its first comment, its replies' count and whether it is resolved; one
// opened shows every comment with reply, edit (one's own), resolve (modern threads) and delete. The slide's review
// comes from commentsPane.logic.ts. The list is a window over fixed-height rows and an opened thread a window over
// measured ones, so a pane over a thousand threads or replies draws what is in view. Focus follows what the user did:
// an opened thread's first comment, the thread's row again after "All comments", a posted thread's row.

// The user's author name, asked for the first time (as the document editor does); null when the dialog was dismissed.
function useCommentAuthor() {
	const settings = useOfficeSettings()
	const [asking, setAsking] = useState<((name: string | null) => void) | null>(null)
	const ask = (): Promise<string | null> =>
		ensureAuthorName(
			() =>
				new Promise<string | null>(resolve => {
					setAsking(() => resolve)
				})
		)
	const dialog = (
		<AuthorNameDialog
			open={asking !== null}
			pending={false}
			initialValue={settings.authorName}
			onOpenChange={next => {
				if (!next) {
					asking?.(null)
					setAsking(null)
				}
			}}
			onSubmit={name => {
				asking?.(name)
				setAsking(null)
			}}
		/>
	)

	return { author: settings.authorName, ask, dialog }
}

interface Thread {
	readonly root: CommentView
	readonly replies: readonly CommentView[]
}

function threadsOf(review: SlideReview | undefined): Thread[] {
	const out: Thread[] = []

	for (const comment of review?.comments ?? []) {
		const last = out[out.length - 1]

		if (comment.parent !== undefined && last?.root.id === comment.parent) (last.replies as CommentView[]).push(comment)
		else out.push({ root: comment, replies: [] })
	}

	return out
}

// A comment's text as the deck takes it: U+000B, the soft line break PowerPoint and Word put on the clipboard, is a
// line break (every comment form writes a line as its own paragraph and reads a DrawingML <a:br/> back as one).
function commentText(text: string): string {
	return text.replaceAll("\u000b", "\n")
}

const ROW_PX = 76
const OVERSCAN_PX = 8 * ROW_PX
// The characters of a thread's first comment its row's accessible name carries.
const EXCERPT_CHARS = 80

function shownDate(created: string): string {
	return created === "" || Number.isNaN(Date.parse(created)) ? "" : formatShortDate(created)
}

function excerptOf(text: string): string {
	const flat = text.replace(/\s+/gu, " ").trim()

	return flat.length <= EXCERPT_CHARS ? flat : `${flat.slice(0, EXCERPT_CHARS - 1)}…`
}

function ThreadRow({
	thread,
	top,
	colors,
	list
}: {
	thread: Thread
	top: number
	colors: ReadonlyMap<string, string>
	list: Intl.ListFormat
}) {
	const { t } = useTranslation("preview")
	const author = thread.root.author === "" ? t("previewPptxCommentUnknownAuthor") : thread.root.author
	const date = shownDate(thread.root.created)
	const excerpt = excerptOf(thread.root.text)
	// Rows of one author tell apart by what they say, when, and their state.
	const name = list.format([
		date === "" ? t("previewPptxCommentThreadUndated", { author, excerpt }) : t("previewPptxCommentThread", { author, date, excerpt }),
		...(thread.replies.length > 0 ? [t("previewPptxCommentReplies", { count: thread.replies.length })] : []),
		...(thread.root.resolved ? [t("previewPptxCommentResolved")] : [])
	])

	return (
		<li
			style={{ top, height: ROW_PX - 4 }}
			className="absolute inset-x-0"
		>
			<button
				type="button"
				aria-label={name}
				data-thread={thread.root.id}
				className={cn(
					"flex size-full flex-col gap-1 overflow-hidden rounded-lg border border-border px-2 py-1.5 text-left text-xs outline-none",
					"hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/30",
					thread.root.resolved && "opacity-70"
				)}
			>
				<span className="flex w-full min-w-0 items-center justify-between gap-2">
					<Byline
						name={author}
						date={date}
						color={colors.get(thread.root.authorId) ?? revisionColor(0)}
					/>
					{thread.root.resolved ? (
						<span className="shrink-0 text-muted-foreground">{t("previewPptxCommentResolved")}</span>
					) : null}
				</span>
				<span className="line-clamp-2 break-words whitespace-pre-wrap">{thread.root.text}</span>
				{thread.replies.length > 0 ? (
					<span className="text-muted-foreground">{t("previewPptxCommentReplies", { count: thread.replies.length })}</span>
				) : null}
			</button>
		</li>
	)
}

interface PaneActions {
	readonly editable: boolean
	readonly author: string | null
	// Whether the op applied (the editor told a refusal; a dismissed name dialog sends nothing).
	command(op: (author: string) => DeckOp): Promise<boolean>
}

// What a comment's ⋯ menu acts on (one menu serves every comment of the thread).
interface MenuTarget {
	readonly index: number
	readonly comment: CommentView
}

// One comment of the opened thread, or the field editing it.
function CommentItem({
	comment,
	index,
	colors,
	actions,
	editing,
	menu,
	onMenu,
	onEdited,
	slide
}: {
	comment: CommentView
	index: number
	colors: ReadonlyMap<string, string>
	actions: PaneActions
	editing: boolean
	menu: MenuPrimitive.Handle<MenuTarget>
	onMenu: (index: number) => void
	onEdited: (saved: boolean) => void
	slide: SlideRef
}) {
	const { t } = useTranslation("preview")
	const [saving, setSaving] = useState(false)

	return (
		<>
			<div className="flex items-center justify-between gap-2">
				<Byline
					name={comment.author === "" ? t("previewPptxCommentUnknownAuthor") : comment.author}
					date={shownDate(comment.created)}
					color={colors.get(comment.authorId) ?? revisionColor(0)}
				/>
				{actions.editable ? (
					<DropdownMenuTrigger
						handle={menu}
						payload={{ index, comment }}
						onClick={() => {
							onMenu(index)
						}}
						render={
							<Button
								variant="ghost"
								size="icon-xs"
								aria-label={t("previewPptxCommentActions")}
							/>
						}
					>
						<MoreHorizontalIcon />
					</DropdownMenuTrigger>
				) : null}
			</div>
			{editing ? (
				<CardField
					initial={comment.text}
					label={t("previewPptxCommentEdit")}
					placeholder={t("previewPptxCommentPlaceholder")}
					submitLabel={t("previewPptxCommentSave")}
					allowEmpty={false}
					onSubmit={text => {
						if (saving) return

						setSaving(true)
						void actions
							.command(() => ({ family: "comment", kind: "edit", slide, id: comment.id, text: commentText(text) }))
							.then(ok => {
								setSaving(false)

								// A refused edit keeps the field and its text.
								if (ok) onEdited(true)
							})
					}}
					onCancel={() => {
						onEdited(false)
					}}
				/>
			) : (
				<p className="break-words whitespace-pre-wrap">{comment.text}</p>
			)}
		</>
	)
}

// Estimated height of one comment (px) before it is measured: its byline and two lines of text.
const COMMENT_ESTIMATE_PX = 64
const COMMENT_OVERSCAN = 6

// The opened thread's comments: a window over rows measured as they mount, so a thread of a thousand replies draws
// what is in view. `keep`: rows that stay mounted out of view (the one being edited, the one whose menu is open).
// `focus`: a row to bring into view and focus (onFocused once it has). useVirtualizer keeps this component out of the
// React Compiler (its derived values are memoized here by hand); the rows themselves are compiled components.
function ThreadComments({
	comments,
	scroller,
	keep,
	focus,
	onFocused,
	item
}: {
	comments: readonly CommentView[]
	scroller: HTMLElement | null
	keep: readonly number[]
	focus: number | null
	onFocused: () => void
	item: (comment: CommentView, index: number) => ReactNode
}) {
	const keepKey = keep.join(",")
	const rangeExtractor = useCallback(
		(range: Range) => {
			const out = defaultRangeExtractor(range)
			const extra = keepKey === "" ? [] : keepKey.split(",").map(Number)

			for (const index of extra) if (index < range.count && !out.includes(index)) out.push(index)

			return extra.length === 0 ? out : out.sort((a, b) => a - b)
		},
		[keepKey]
	)
	const getItemKey = useCallback((index: number) => comments[index]?.id ?? index, [comments])
	const estimateSize = useCallback(() => COMMENT_ESTIMATE_PX, [])
	const virtualizer = useVirtualizer({
		count: comments.length,
		getScrollElement: () => scroller,
		observeElementOffset: observeElementOffsetFromAttach,
		estimateSize,
		overscan: COMMENT_OVERSCAN,
		paddingStart: 8,
		getItemKey,
		rangeExtractor,
		// Rows measured in the next frame, not inside the ResizeObserver callback (a resize there is a loop error).
		useAnimationFrameWithResizeObserver: true
	})
	const rows = useRef<HTMLDivElement>(null)

	useEffect(() => {
		if (focus === null || rows.current === null) return

		const row = rows.current.querySelector<HTMLElement>(`[data-index="${String(focus)}"]`)

		if (row === null) {
			virtualizer.scrollToIndex(focus, { align: "auto" })

			return
		}

		row.scrollIntoView({ block: "nearest" })
		focusSettled(row)
		onFocused()
	})

	return (
		<div
			ref={rows}
			className="relative"
			style={{ height: virtualizer.getTotalSize() }}
		>
			{virtualizer.getVirtualItems().map(row => {
				const comment = comments[row.index]

				return comment === undefined ? null : (
					<div
						key={row.key}
						ref={virtualizer.measureElement}
						data-index={row.index}
						tabIndex={-1}
						className={cn(
							"absolute inset-x-2 top-0 flex flex-col gap-1 rounded-sm pb-2 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/30",
							row.index > 0 && "border-t border-border pt-2"
						)}
						style={{ transform: `translateY(${String(row.start)}px)` }}
					>
						{item(comment, row.index)}
					</div>
				)
			})}
		</div>
	)
}

// One thread whole: its comments with one ⋯ menu for all of them, the reply field, and resolve. A field stays open,
// its text kept, until the op applied. `onRootDeleted`: the thread's first comment was deleted with its replies.
function ThreadView({
	thread,
	slide,
	actions,
	colors,
	scroller,
	onRootDeleted
}: {
	thread: Thread
	slide: SlideRef
	actions: PaneActions
	colors: ReadonlyMap<string, string>
	scroller: HTMLElement | null
	onRootDeleted: () => void
}) {
	const { t } = useTranslation("preview")
	const [editing, setEditing] = useState<string | null>(null)
	const [replying, setReplying] = useState(false)
	const [posting, setPosting] = useState(false)
	const [menu] = useState(() => MenuPrimitive.createHandle<MenuTarget>())
	const [menuAt, setMenuAt] = useState<number | null>(null)
	// The opened thread's first comment takes focus.
	const [focus, setFocus] = useState<number | null>(0)
	// The reply button takes focus when it comes back (the reply posted or its field closed).
	const refocusReply = useRef(false)
	// The menu's own focus return is skipped where what follows sets focus (an edit field, a deleted comment).
	const skipReturn = useRef(false)
	const comments = [thread.root, ...thread.replies]
	const resolvable = thread.root.format === "modern"
	const editingAt = editing === null ? -1 : comments.findIndex(comment => comment.id === editing)
	const keep = [...(editingAt >= 0 ? [editingAt] : []), ...(menuAt === null ? [] : [menuAt])]

	const remove = (target: MenuTarget): void => {
		void actions
			.command(() => ({ family: "comment", kind: "delete", slide, id: target.comment.id }))
			.then(ok => {
				if (!ok) setFocus(target.index)
				else if (target.index === 0) onRootDeleted()
				else focusSettled(replyButtonOf(scroller))
			})
	}

	return (
		<div className={cn("flex flex-col text-xs", thread.root.resolved && "opacity-90")}>
			<ThreadComments
				comments={comments}
				scroller={scroller}
				keep={keep}
				focus={focus}
				onFocused={() => {
					setFocus(null)
				}}
				item={(comment, index) => (
					<CommentItem
						comment={comment}
						index={index}
						colors={colors}
						actions={actions}
						editing={editing === comment.id}
						menu={menu}
						onMenu={setMenuAt}
						onEdited={() => {
							setEditing(null)
							setFocus(index)
						}}
						slide={slide}
					/>
				)}
			/>
			<DropdownMenu
				handle={menu}
				onOpenChange={open => {
					if (!open) setMenuAt(null)
				}}
			>
				{({ payload }) =>
					payload === undefined ? null : (
						<DropdownMenuContent
							align="end"
							finalFocus={() => {
								const skip = skipReturn.current

								skipReturn.current = false

								return !skip
							}}
						>
							{payload.comment.editable && actions.author !== null && payload.comment.author === actions.author ? (
								<DropdownMenuItem
									onClick={() => {
										skipReturn.current = true
										setEditing(payload.comment.id)
									}}
								>
									{t("previewPptxCommentEdit")}
								</DropdownMenuItem>
							) : null}
							<DropdownMenuItem
								variant="destructive"
								onClick={() => {
									skipReturn.current = true
									remove(payload)
								}}
							>
								{payload.index === 0 ? t("previewPptxCommentDeleteThread") : t("previewPptxCommentDelete")}
							</DropdownMenuItem>
						</DropdownMenuContent>
					)
				}
			</DropdownMenu>
			{actions.editable ? (
				<div className="mx-2 flex flex-col gap-1.5 border-t border-border pt-2 pb-2">
					{replying ? (
						<CardField
							initial=""
							label={t("previewPptxCommentReplyPlaceholder")}
							placeholder={t("previewPptxCommentReplyPlaceholder")}
							submitLabel={t("previewPptxCommentReply")}
							allowEmpty={false}
							onSubmit={text => {
								if (posting) return

								setPosting(true)
								void actions
									.command(author => ({
										family: "comment",
										kind: "reply",
										slide,
										parent: thread.root.id,
										comment: {
											id: newCommentGuid(),
											author: newCommentGuid(),
											text: commentText(text),
											created: new Date().toISOString()
										},
										authorName: author
									}))
									.then(ok => {
										setPosting(false)

										// A refused reply keeps the field and its text.
										if (!ok) return

										refocusReply.current = true
										setReplying(false)
									})
							}}
							onCancel={() => {
								refocusReply.current = true
								setReplying(false)
							}}
						/>
					) : (
						<button
							ref={element => {
								if (element === null || !refocusReply.current) return

								refocusReply.current = false
								focusSettled(element)
							}}
							data-reply=""
							type="button"
							className="rounded-xl border border-border px-2 py-1.5 text-left text-muted-foreground outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/30"
							onClick={() => {
								setReplying(true)
							}}
						>
							{t("previewPptxCommentReplyPlaceholder")}
						</button>
					)}
					{resolvable ? (
						<Button
							type="button"
							size="xs"
							variant="outline"
							className="self-start"
							onClick={() => {
								void actions.command(() => ({
									family: "comment",
									kind: "resolve",
									slide,
									id: thread.root.id,
									resolved: !thread.root.resolved
								}))
							}}
						>
							{thread.root.resolved ? <RotateCcwIcon data-icon="inline-start" /> : <CheckIcon data-icon="inline-start" />}
							{thread.root.resolved ? t("previewPptxCommentReopen") : t("previewPptxCommentResolve")}
						</Button>
					) : (
						<p className="text-muted-foreground">{t("previewPptxCommentNoResolve")}</p>
					)}
				</div>
			) : null}
		</div>
	)
}

// The opened thread's reply button.
function replyButtonOf(scroller: HTMLElement | null): HTMLElement | null {
	return scroller?.querySelector<HTMLElement>("[data-reply]") ?? null
}

function authorColors(review: SlideReview | undefined): Map<string, string> {
	const out = new Map<string, string>()

	for (const comment of review?.comments ?? []) if (!out.has(comment.authorId)) out.set(comment.authorId, revisionColor(out.size))

	return out
}

// Where focus goes once the slide's review shows it: a thread's row again (its thread was closed), the row of a thread
// just posted (`count`: threads before it; a form that renames ids puts a new thread last), or the row in the place of
// a deleted thread; -1: no thread is left. Each is for the slide it was made on.
type FocusWant = { readonly slide: SlideRef } & (
	| { readonly kind: "thread"; readonly id: string }
	| { readonly kind: "posted"; readonly id: string; readonly count: number }
	| { readonly kind: "gone"; readonly id: string; readonly index: number }
)

function wantedIndex(want: FocusWant, threads: readonly Thread[]): number | undefined {
	if (threads.length === 0) return want.kind === "posted" ? undefined : -1

	const at = threads.findIndex(thread => thread.root.id === want.id)

	switch (want.kind) {
		case "thread":
			return Math.max(0, at)
		case "posted":
			return at >= 0 ? at : threads.length > want.count ? threads.length - 1 : undefined
		case "gone":
			return at >= 0 ? undefined : Math.min(want.index, threads.length - 1)
	}
}

export function PresentationCommentsPane({
	editor,
	editable,
	phone
}: {
	editor: PresentationRibbonEditor | undefined
	editable: boolean
	phone: boolean
}) {
	const { t, i18n } = useTranslation("preview")
	const state = useSlideReviewState()
	const review = useSlideReview(editor, state.open)
	const headingId = useId()
	const author = useCommentAuthor()
	const [list, setList] = useState<HTMLElement | null>(null)
	const [scroller, setScroller] = useState<HTMLElement | null>(null)
	const viewport = useElementSize(list)
	const [scroll, setScroll] = useState(0)
	const [posting, setPosting] = useState(false)
	const want = useRef<FocusWant | null>(null)
	const listElement = useRef<HTMLElement | null>(null)
	const newButton = useRef<HTMLButtonElement>(null)
	const closeButton = useRef<HTMLButtonElement>(null)
	const frame = useRef(0)
	const threads = threadsOf(review)
	const colors = authorColors(review)
	const names = new Intl.ListFormat(i18n.language, { style: "short", type: "unit" })
	const slide = editor?.render?.ref
	const opened = state.thread === undefined ? undefined : threads.find(thread => thread.root.id === state.thread)
	const from = Math.max(0, Math.floor((scroll - OVERSCAN_PX) / ROW_PX))
	const to = Math.min(threads.length, Math.ceil((scroll + (viewport.height || ROW_PX * 12) + OVERSCAN_PX) / ROW_PX))

	useEffect(
		() => () => {
			cancelAnimationFrame(frame.current)
		},
		[]
	)

	// Another slide in view (the pane open or not) closes the thread and the field the last one had.
	const seen = useRef(slide)

	useEffect(() => {
		if (seen.current !== undefined && seen.current !== slide) slideReview.leaveSlide()

		seen.current = slide
	}, [slide])

	// Each render: focus the row asked for once the review shows it (scrolling it into the window first; the scroll
	// event renders the window again).
	useEffect(() => {
		const asked = want.current

		if (asked === null) return
		if (asked.slide !== slide) {
			want.current = null

			return
		}
		if (opened !== undefined || review === undefined) return

		const index = wantedIndex(asked, threads)

		if (index === undefined) return

		// No thread left: the pane's own buttons.
		if (index < 0) {
			want.current = null
			focusSettled(newButton.current ?? closeButton.current)

			return
		}

		const id = threads[index]?.root.id
		const element = listElement.current

		if (element === null || id === undefined) return

		const row = element.querySelector<HTMLElement>(`[data-thread="${CSS.escape(id)}"]`)

		if (row === null) {
			element.scrollTop = Math.max(0, index * ROW_PX - Math.max(0, element.clientHeight - ROW_PX) / 2)

			return
		}

		want.current = null
		row.scrollIntoView({ block: "nearest" })
		focusSettled(row)
	})

	if (!state.open || editor === undefined || slide === undefined) return null

	const actions: PaneActions = {
		editable,
		author: author.author,
		command: async make => {
			const name = await author.ask()

			if (name === null) return false

			// A refusal is told by the editor (one toast) and changes nothing.
			return (await editor.command(make(name))).ok
		}
	}

	return (
		<section
			data-preview-surface
			data-office-pane
			data-comments-pane=""
			aria-labelledby={headingId}
			className={cn(
				"flex min-h-0 shrink-0 flex-col bg-background",
				phone ? "max-h-[40dvh] w-full border-b border-border" : "w-64 border-l border-border lg:w-72"
			)}
		>
			<div className="flex shrink-0 items-center justify-between gap-2 border-b border-border py-1 pr-1 pl-3">
				<h2
					id={headingId}
					className="truncate text-sm font-medium"
				>
					{t("previewPptxCommentsTitle")}
				</h2>
				<div className="flex shrink-0 items-center gap-0.5">
					{editable ? (
						<Button
							ref={newButton}
							variant="ghost"
							size="icon-sm"
							aria-label={t("previewPptxCommentNew")}
							title={t("previewPptxCommentNew")}
							onClick={() => {
								slideReview.openThread(undefined)
								slideReview.compose(true)
							}}
						>
							<PlusIcon />
						</Button>
					) : null}
					<Button
						ref={closeButton}
						variant="ghost"
						size="icon-sm"
						aria-label={t("previewPptxCommentsClose")}
						title={t("previewPptxCommentsClose")}
						onClick={() => {
							slideReview.setOpen(false)
						}}
					>
						<XIcon />
					</Button>
				</div>
			</div>
			{state.composing && editable ? (
				<div className="shrink-0 border-b border-border p-2 text-xs">
					<CardField
						initial=""
						label={t("previewPptxCommentPlaceholder")}
						placeholder={t("previewPptxCommentPlaceholder")}
						submitLabel={t("previewPptxCommentPost")}
						allowEmpty={false}
						onSubmit={text => {
							if (posting) return

							const id = newCommentGuid()
							const count = threads.length

							setPosting(true)
							void actions
								.command(name => ({
									family: "comment",
									kind: "add",
									slide,
									comment: { id, author: newCommentGuid(), text: commentText(text), created: new Date().toISOString() },
									authorName: name
								}))
								.then(ok => {
									setPosting(false)

									// A refused comment keeps the field and its text.
									if (!ok) return

									slideReview.compose(false)
									want.current = { slide, kind: "posted", id, count }
								})
						}}
						onCancel={() => {
							slideReview.compose(false)
							;(newButton.current ?? closeButton.current)?.focus({ preventScroll: true })
						}}
					/>
				</div>
			) : null}
			{opened !== undefined ? (
				<>
					<div className="shrink-0">
						<Button
							type="button"
							variant="ghost"
							size="xs"
							className="m-1"
							onClick={() => {
								want.current = { slide, kind: "thread", id: opened.root.id }
								slideReview.openThread(undefined)
							}}
						>
							<ArrowLeftIcon data-icon="inline-start" />
							{t("previewPptxCommentBack")}
						</Button>
					</div>
					<div
						ref={setScroller}
						className="min-h-0 flex-1 overflow-y-auto [contain:content]"
					>
						<ThreadView
							key={opened.root.id}
							thread={opened}
							slide={slide}
							actions={actions}
							colors={colors}
							scroller={scroller}
							onRootDeleted={() => {
								want.current = { slide, kind: "gone", id: opened.root.id, index: threads.indexOf(opened) }
								slideReview.openThread(undefined)
							}}
						/>
					</div>
				</>
			) : state.failed ? (
				<p className="p-3 text-sm text-muted-foreground">{t("previewPptxCommentsFailed")}</p>
			) : review === undefined ? (
				<p
					className="p-3 text-sm text-muted-foreground"
					role="status"
				>
					{t("previewPptxCommentsLoading")}
				</p>
			) : threads.length === 0 ? (
				<p className="p-3 text-sm text-muted-foreground">{t("previewPptxCommentsEmpty")}</p>
			) : (
				// Layout and paint contained, not size: in the phone pane (a maximum height only) the list takes its
				// rows' height up to the pane's.
				<div
					ref={element => {
						listElement.current = element
						setList(element)
					}}
					className="min-h-0 flex-1 overflow-y-auto p-1 [contain:content]"
					onScroll={event => {
						const top = event.currentTarget.scrollTop

						cancelAnimationFrame(frame.current)
						frame.current = requestAnimationFrame(() => {
							setScroll(top)
						})
					}}
					onClick={event => {
						const row = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-thread]") : null

						if (row !== null) slideReview.openThread(row.dataset["thread"])
					}}
				>
					<ul
						aria-label={t("previewPptxCommentsList")}
						className="relative m-0 list-none p-0"
						style={{ height: threads.length * ROW_PX }}
					>
						{threads.slice(from, to).map((thread, k) => (
							<ThreadRow
								key={thread.root.id}
								thread={thread}
								top={(from + k) * ROW_PX}
								colors={colors}
								list={names}
							/>
						))}
					</ul>
				</div>
			)}
			{author.dialog}
		</section>
	)
}

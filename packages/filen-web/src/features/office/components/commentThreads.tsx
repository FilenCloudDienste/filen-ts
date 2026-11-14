import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual"
import { Menu as MenuPrimitive } from "@base-ui/react/menu"
import { ArrowLeftIcon, CheckIcon, MoreHorizontalIcon, PlusIcon, RotateCcwIcon, XIcon } from "lucide-react"
import { cn } from "@filen/shared"
import { revisionColor } from "@filen/office/dom/docx"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { useCommentAuthor } from "@/features/office/components/commentAuthor"
import { Byline } from "@/features/preview/components/docxAnnotations"
import { CardField } from "@/features/spreadsheet/comments/annotationCards"
import {
	excerptOf,
	focusSettled,
	shownDate,
	wantedIndex,
	type CommentThread,
	type FocusWant,
	type ThreadComment
} from "@/features/office/components/commentThreads.logic"
import { useElementSize } from "@/lib/useElementSize"
import { observeElementOffsetFromAttach } from "@/lib/virtualScroll"

// A comments pane any editor shows beside its document: a list of threads, each with its first comment, its replies'
// count and its state; one opened shows every comment with reply, edit (one's own), resolve and delete. The editor
// hands in its threads, its own strings and async actions; the pane asks the user's author name the first time one
// is needed (Settings, Office). The list is a window over fixed-height rows and an opened thread a window over
// measured ones, so a pane over a thousand threads or replies draws what is in view. Focus follows what the user did:
// an opened thread's first comment, the thread's row again after "All comments", a posted thread's row.

// Each editor's own strings (its catalog keys).
export interface CommentThreadLabels {
	readonly title: string
	readonly close: string
	// The list's accessible name.
	readonly list: string
	readonly empty: string
	readonly loading?: string
	readonly failed?: string
	readonly new: string
	readonly placeholder: string
	readonly replyPlaceholder: string
	// The button of the field starting a thread (none: no such field).
	readonly post?: string
	readonly reply: string
	readonly save: string
	readonly actions: string
	readonly edit: string
	readonly delete: string
	readonly deleteThread: string
	readonly resolve: string
	readonly reopen: string
	readonly resolved: string
	readonly back: string
	readonly unknownAuthor: string
	// Shown under a thread that cannot be resolved (none: nothing shown).
	readonly noResolve?: string
	replies(count: number): string
	// A row's accessible name; `date` is "" when the comment has none.
	thread(author: string, date: string, excerpt: string): string
}

// What the pane changes, each resolving to whether it applied (a refusal is told by the editor and changes nothing).
// Reply, resolve and post carry the user's author name, asked for first.
export interface CommentThreadActions<C extends ThreadComment> {
	readonly reply: (thread: CommentThread<C>, text: string, author: string) => Promise<boolean>
	readonly edit: (thread: CommentThread<C>, comment: C, text: string) => Promise<boolean>
	// `index` 0: the thread's first comment, with its replies.
	readonly remove: (thread: CommentThread<C>, comment: C, index: number) => Promise<boolean>
	readonly resolve: (thread: CommentThread<C>, resolved: boolean, author: string) => Promise<boolean>
	// The new thread's id, null when refused.
	readonly post?: (text: string, author: string) => Promise<string | null>
}

export interface CommentThreadsProps<C extends ThreadComment> {
	readonly open: boolean
	// What the threads belong to (a slide); a focus asked for in one scope is dropped in another.
	readonly scope: unknown
	readonly threads: readonly CommentThread<C>[]
	// Whether the threads have been read, and whether reading them failed.
	readonly loaded: boolean
	readonly failed: boolean
	readonly labels: CommentThreadLabels
	readonly editable: boolean
	readonly phone: boolean
	// The thread shown whole, and whether the field starting a thread is shown.
	readonly thread: string | undefined
	readonly composing: boolean
	readonly onOpenThread: (thread: string | undefined) => void
	readonly onClose: () => void
	// The New button (none: no button).
	readonly onNew?: () => void
	// Closes the field starting a thread.
	readonly onComposeEnd?: () => void
	// Whether an edit or a delete asks the author name first too (as reply, resolve and post do).
	readonly askAuthorOnEveryChange?: boolean
	readonly actions: CommentThreadActions<C>
}

const ROW_PX = 76
const OVERSCAN_PX = 8 * ROW_PX

function ThreadRow({
	thread,
	top,
	colors,
	list,
	labels
}: {
	thread: CommentThread
	top: number
	colors: ReadonlyMap<string, string>
	list: Intl.ListFormat
	labels: CommentThreadLabels
}) {
	const author = thread.root.author === "" ? labels.unknownAuthor : thread.root.author
	const date = shownDate(thread.root.created)
	const excerpt = excerptOf(thread.root.text)
	const status = thread.resolved ? labels.resolved : thread.status
	const replies = thread.replies.length > 0 ? labels.replies(thread.replies.length) : undefined
	// Rows of one author tell apart by what they say, when, and their state.
	const name = list.format([
		labels.thread(author, date, excerpt),
		...(replies === undefined ? [] : [replies]),
		...(status === undefined ? [] : [status]),
		...(thread.detail === undefined ? [] : [thread.detail])
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
					thread.resolved && "opacity-70"
				)}
			>
				<span className="flex w-full min-w-0 items-center justify-between gap-2">
					<Byline
						name={author}
						date={date}
						color={colors.get(thread.root.authorId) ?? revisionColor(0)}
					/>
					{status === undefined ? null : <span className="shrink-0 text-muted-foreground">{status}</span>}
				</span>
				<span className="line-clamp-2 break-words whitespace-pre-wrap">{thread.root.text}</span>
				{thread.detail === undefined ? (
					replies === undefined ? null : (
						<span className="text-muted-foreground">{replies}</span>
					)
				) : (
					<span className="flex min-w-0 gap-2 text-muted-foreground">
						<span className="truncate">{thread.detail}</span>
						{replies === undefined ? null : <span className="shrink-0">{replies}</span>}
					</span>
				)}
			</button>
		</li>
	)
}

interface PaneActions<C extends ThreadComment> {
	readonly editable: boolean
	readonly author: string | null
	readonly labels: CommentThreadLabels
	// Whether each applied (a dismissed name dialog sends nothing).
	readonly reply: (text: string) => Promise<boolean>
	readonly edit: (comment: C, text: string) => Promise<boolean>
	readonly remove: (comment: C, index: number) => Promise<boolean>
	readonly resolve: (resolved: boolean) => Promise<boolean>
}

// What a comment's ⋯ menu acts on (one menu serves every comment of the thread).
interface MenuTarget<C extends ThreadComment> {
	readonly index: number
	readonly comment: C
}

// One comment of the opened thread, or the field editing it.
function CommentItem<C extends ThreadComment>({
	comment,
	index,
	colors,
	actions,
	editing,
	menu,
	onMenu,
	onEdited
}: {
	comment: C
	index: number
	colors: ReadonlyMap<string, string>
	actions: PaneActions<C>
	editing: boolean
	menu: MenuPrimitive.Handle<MenuTarget<C>>
	onMenu: (index: number) => void
	onEdited: (saved: boolean) => void
}) {
	const [saving, setSaving] = useState(false)
	const labels = actions.labels

	return (
		<>
			<div className="flex items-center justify-between gap-2">
				<Byline
					name={comment.author === "" ? labels.unknownAuthor : comment.author}
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
								aria-label={labels.actions}
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
					label={labels.edit}
					placeholder={labels.placeholder}
					submitLabel={labels.save}
					allowEmpty={false}
					onSubmit={text => {
						if (saving) return

						setSaving(true)
						void actions.edit(comment, text).then(ok => {
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
function ThreadComments<C extends ThreadComment>({
	comments,
	scroller,
	keep,
	focus,
	onFocused,
	item
}: {
	comments: readonly C[]
	scroller: HTMLElement | null
	keep: readonly number[]
	focus: number | null
	onFocused: () => void
	item: (comment: C, index: number) => ReactNode
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
// its text kept, until the action applied. `focusFirst`: the user opened it from its row (a thread the editor opened,
// for a selection on the page, leaves focus where it is). `onRootDeleted`: the thread's first comment was deleted
// with its replies.
function ThreadView<C extends ThreadComment>({
	thread,
	actions,
	colors,
	scroller,
	focusFirst,
	onRootDeleted
}: {
	thread: CommentThread<C>
	actions: PaneActions<C>
	colors: ReadonlyMap<string, string>
	scroller: HTMLElement | null
	focusFirst: boolean
	onRootDeleted: () => void
}) {
	const labels = actions.labels
	const [editing, setEditing] = useState<string | null>(null)
	const [replying, setReplying] = useState(false)
	const [posting, setPosting] = useState(false)
	const [menu] = useState(() => MenuPrimitive.createHandle<MenuTarget<C>>())
	const [menuAt, setMenuAt] = useState<number | null>(null)
	// The opened thread's first comment takes focus.
	const [focus, setFocus] = useState<number | null>(focusFirst ? 0 : null)
	// The reply button takes focus when it comes back (the reply posted or its field closed).
	const refocusReply = useRef(false)
	// The menu's own focus return is skipped where what follows sets focus (an edit field, a deleted comment).
	const skipReturn = useRef(false)
	const comments = [thread.root, ...thread.replies]
	const editingAt = editing === null ? -1 : comments.findIndex(comment => comment.id === editing)
	const keep = [...(editingAt >= 0 ? [editingAt] : []), ...(menuAt === null ? [] : [menuAt])]

	const remove = (target: MenuTarget<C>): void => {
		void actions.remove(target.comment, target.index).then(ok => {
			if (!ok) setFocus(target.index)
			else if (target.index === 0) onRootDeleted()
			else focusSettled(replyButtonOf(scroller))
		})
	}

	return (
		<div className={cn("flex flex-col text-xs", thread.resolved && "opacity-90")}>
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
									{labels.edit}
								</DropdownMenuItem>
							) : null}
							<DropdownMenuItem
								variant="destructive"
								onClick={() => {
									skipReturn.current = true
									remove(payload)
								}}
							>
								{payload.index === 0 ? labels.deleteThread : labels.delete}
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
							label={labels.replyPlaceholder}
							placeholder={labels.replyPlaceholder}
							submitLabel={labels.reply}
							allowEmpty={false}
							onSubmit={text => {
								if (posting) return

								setPosting(true)
								void actions.reply(text).then(ok => {
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
							{labels.replyPlaceholder}
						</button>
					)}
					{thread.resolvable ? (
						<Button
							type="button"
							size="xs"
							variant="outline"
							className="self-start"
							onClick={() => {
								void actions.resolve(!thread.resolved)
							}}
						>
							{thread.resolved ? <RotateCcwIcon data-icon="inline-start" /> : <CheckIcon data-icon="inline-start" />}
							{thread.resolved ? labels.reopen : labels.resolve}
						</Button>
					) : labels.noResolve === undefined ? null : (
						<p className="text-muted-foreground">{labels.noResolve}</p>
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

function authorColors(threads: readonly CommentThread[]): Map<string, string> {
	const out = new Map<string, string>()
	const add = (comment: ThreadComment): void => {
		if (!out.has(comment.authorId)) out.set(comment.authorId, revisionColor(out.size))
	}

	for (const thread of threads) {
		add(thread.root)

		for (const reply of thread.replies) add(reply)
	}

	return out
}

export function CommentThreads<C extends ThreadComment>({
	open,
	scope,
	threads,
	loaded,
	failed,
	labels,
	editable,
	phone,
	thread,
	composing,
	onOpenThread,
	onClose,
	onNew,
	onComposeEnd,
	askAuthorOnEveryChange,
	actions
}: CommentThreadsProps<C>) {
	const { i18n } = useTranslation("preview")
	const headingId = useId()
	const author = useCommentAuthor()
	const [list, setList] = useState<HTMLElement | null>(null)
	const [scroller, setScroller] = useState<HTMLElement | null>(null)
	const viewport = useElementSize(list)
	const [scroll, setScroll] = useState(0)
	const [posting, setPosting] = useState(false)
	// The thread last opened from its row.
	const [clicked, setClicked] = useState<string | undefined>(undefined)
	const want = useRef<FocusWant | null>(null)
	const listElement = useRef<HTMLElement | null>(null)
	const newButton = useRef<HTMLButtonElement>(null)
	const closeButton = useRef<HTMLButtonElement>(null)
	const frame = useRef(0)
	const colors = authorColors(threads)
	const names = new Intl.ListFormat(i18n.language, { style: "short", type: "unit" })
	const opened = thread === undefined ? undefined : threads.find(candidate => candidate.root.id === thread)
	const from = Math.max(0, Math.floor((scroll - OVERSCAN_PX) / ROW_PX))
	const to = Math.min(threads.length, Math.ceil((scroll + (viewport.height || ROW_PX * 12) + OVERSCAN_PX) / ROW_PX))

	useEffect(
		() => () => {
			cancelAnimationFrame(frame.current)
		},
		[]
	)

	// Each render: focus the row asked for once the list shows it (scrolling it into the window first; the scroll
	// event renders the window again).
	useEffect(() => {
		const asked = want.current

		if (asked === null) return
		if (asked.scope !== scope) {
			want.current = null

			return
		}
		if (opened !== undefined || !loaded) return

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

	if (!open) return null

	// Runs `run` with the user's author name, asked for first; false when the dialog was dismissed.
	const named = async (run: (name: string) => Promise<boolean>): Promise<boolean> => {
		const name = await author.ask()

		return name === null ? false : run(name)
	}
	const unnamed = (run: () => Promise<boolean>): Promise<boolean> => (askAuthorOnEveryChange === true ? named(() => run()) : run())
	const paneActions = (current: CommentThread<C>): PaneActions<C> => ({
		editable,
		author: author.author,
		labels,
		reply: text => named(name => actions.reply(current, text, name)),
		edit: (comment, text) => unnamed(() => actions.edit(current, comment, text)),
		remove: (comment, index) => unnamed(() => actions.remove(current, comment, index)),
		resolve: resolved => named(name => actions.resolve(current, resolved, name))
	})
	const post = actions.post
	const postLabel = labels.post

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
					{labels.title}
				</h2>
				<div className="flex shrink-0 items-center gap-0.5">
					{editable && onNew !== undefined ? (
						<Button
							ref={newButton}
							variant="ghost"
							size="icon-sm"
							aria-label={labels.new}
							title={labels.new}
							onClick={onNew}
						>
							<PlusIcon />
						</Button>
					) : null}
					<Button
						ref={closeButton}
						variant="ghost"
						size="icon-sm"
						aria-label={labels.close}
						title={labels.close}
						onClick={onClose}
					>
						<XIcon />
					</Button>
				</div>
			</div>
			{composing && editable && post !== undefined && postLabel !== undefined ? (
				<div className="shrink-0 border-b border-border p-2 text-xs">
					<CardField
						initial=""
						label={labels.placeholder}
						placeholder={labels.placeholder}
						submitLabel={postLabel}
						allowEmpty={false}
						onSubmit={text => {
							if (posting) return

							const count = threads.length

							setPosting(true)
							void author
								.ask()
								.then(name => (name === null ? null : post(text, name)))
								.then(id => {
									setPosting(false)

									// A refused comment keeps the field and its text.
									if (id === null) return

									onComposeEnd?.()
									want.current = { scope, kind: "posted", id, count }
								})
						}}
						onCancel={() => {
							onComposeEnd?.()
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
								want.current = { scope, kind: "thread", id: opened.root.id }
								onOpenThread(undefined)
							}}
						>
							<ArrowLeftIcon data-icon="inline-start" />
							{labels.back}
						</Button>
					</div>
					<div
						ref={setScroller}
						className="min-h-0 flex-1 overflow-y-auto [contain:content]"
					>
						<ThreadView
							key={opened.root.id}
							thread={opened}
							actions={paneActions(opened)}
							colors={colors}
							scroller={scroller}
							focusFirst={clicked === opened.root.id}
							onRootDeleted={() => {
								want.current = { scope, kind: "gone", id: opened.root.id, index: threads.indexOf(opened) }
								onOpenThread(undefined)
							}}
						/>
					</div>
				</>
			) : failed && labels.failed !== undefined ? (
				<p className="p-3 text-sm text-muted-foreground">{labels.failed}</p>
			) : !loaded ? (
				<p
					className="p-3 text-sm text-muted-foreground"
					role="status"
				>
					{labels.loading}
				</p>
			) : threads.length === 0 ? (
				<p className="p-3 text-sm text-muted-foreground">{labels.empty}</p>
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

						if (row === null) return

						const id = row.dataset["thread"]

						setClicked(id)
						onOpenThread(id)
					}}
				>
					<ul
						aria-label={labels.list}
						className="relative m-0 list-none p-0"
						style={{ height: threads.length * ROW_PX }}
					>
						{threads.slice(from, to).map((row, k) => (
							<ThreadRow
								key={row.root.id}
								thread={row}
								top={(from + k) * ROW_PX}
								colors={colors}
								list={names}
								labels={labels}
							/>
						))}
					</ul>
				</div>
			)}
			{author.dialog}
		</section>
	)
}

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react"
import { useTranslation } from "react-i18next"
import { ExternalLinkIcon, MoreHorizontalIcon } from "lucide-react"
import { cn } from "@filen/shared"
import type { SheetSummary } from "@filen/office/core/sheet"
import { revisionColor } from "@filen/office/dom/docx"
import type { SheetGridHandle } from "@filen/office/react/sheet"
import { Byline } from "@/features/preview/components/docxAnnotations"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { formatShortDate } from "@/lib/formatDate"
import { useCardPlacement } from "@/features/spreadsheet/comments/placement"
import { linkAction, placeName, type SheetLink, type SheetNote, type SheetThread } from "@/features/spreadsheet/comments/annotations.logic"

// The cards notes, comment threads and links show beside their cells: read-only while the pointer rests on a cell,
// editable when opened from the menu or a shortcut. Drawn in the grid's overlay layer and kept beside their cell as it
// scrolls (SheetGridHandle.onFrame), never by a render per frame.

const FIELD_CLASS =
	"max-h-40 min-h-16 w-full resize-none rounded-xl border border-border bg-background px-2 py-1.5 text-xs leading-5 outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"

export interface CardFrameProps {
	gridRef: RefObject<SheetGridHandle | null>
	cell: { readonly row: number; readonly col: number }
	rightToLeft: boolean
	label: string
	// Read-only, shown while the pointer rests on the cell: a tooltip. Opened: a dialog that takes keys.
	opened: boolean
	onPointerEnter?: () => void
	onPointerLeave?: () => void
	onClose: () => void
	children: ReactNode
}

// A card in the grid's overlay layer: it takes the pointer (the layer does not), and Escape closes it. Opened, it is a
// dialog: it takes focus (a field in it takes it first), and gives it back to the grid when it goes while holding it.
export function CardFrame({
	gridRef,
	cell,
	rightToLeft,
	label,
	opened,
	onPointerEnter,
	onPointerLeave,
	onClose,
	children
}: CardFrameProps) {
	const ref = useCardPlacement(gridRef, cell, rightToLeft)

	useEffect(() => {
		const node = ref.current

		if (opened && node !== null && !node.contains(document.activeElement)) {
			node.focus({ preventScroll: true })
		}
	}, [ref, opened])

	// Before the card leaves the document, while it still holds the focus it would drop.
	useLayoutEffect(() => {
		const node = ref.current
		const grid = gridRef.current

		return () => {
			if (node?.contains(document.activeElement) === true) {
				grid?.focus()
			}
		}
	}, [ref, gridRef])

	return (
		<div
			ref={ref}
			role={opened ? "dialog" : "tooltip"}
			aria-label={label}
			tabIndex={opened ? -1 : undefined}
			data-sheet-annotation=""
			className="pointer-events-auto invisible absolute top-0 left-0 flex max-h-96 w-72 flex-col gap-3 overflow-y-auto rounded-2xl bg-popover p-3 text-xs text-popover-foreground shadow-lg ring-1 ring-foreground/5 outline-none dark:ring-foreground/10"
			onPointerEnter={onPointerEnter}
			onPointerLeave={onPointerLeave}
			// Keys typed in a card are the card's, never the grid's.
			onKeyDown={event => {
				event.stopPropagation()

				if (event.key === "Escape") {
					event.preventDefault()
					onClose()
				}
			}}
		>
			{children}
		</div>
	)
}

// Ctrl/Cmd+Enter submits a field, Escape cancels it.
function fieldKeys(event: KeyboardEvent<HTMLTextAreaElement>, submit: () => void, cancel: () => void): void {
	if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
		event.preventDefault()
		submit()
	} else if (event.key === "Escape") {
		event.preventDefault()
		event.stopPropagation()
		cancel()
	}
}

// A text field with Cancel and a submit button. `allowEmpty`: a note may be emptied; a comment may not. When `onSubmit`
// returns a promise (the author name may be asked for first), a second submit is ignored until it settles.
export function CardField({
	initial,
	label,
	placeholder,
	submitLabel,
	allowEmpty,
	onSubmit,
	onCancel
}: {
	initial: string
	label: string
	placeholder: string
	submitLabel: string
	allowEmpty: boolean
	onSubmit: (text: string) => Promise<unknown> | undefined
	onCancel: () => void
}) {
	const { t } = useTranslation("preview")
	const [text, setText] = useState(initial)
	const [pending, setPending] = useState(false)
	const ref = useRef<HTMLTextAreaElement>(null)
	const blocked = !allowEmpty && text.trim().length === 0
	const submit = (): void => {
		if (blocked || pending) {
			return
		}

		const result = onSubmit(text.replace(/\r\n?/g, "\n"))

		if (result !== undefined) {
			setPending(true)
			void result.finally(() => {
				setPending(false)
			})
		}
	}

	// The caret after what the field starts with (a new note's author line).
	useEffect(() => {
		const field = ref.current

		field?.focus({ preventScroll: true })
		field?.setSelectionRange(field.value.length, field.value.length)
	}, [])

	return (
		<div className="flex flex-col gap-1.5">
			<textarea
				ref={ref}
				value={text}
				aria-label={label}
				placeholder={placeholder}
				rows={3}
				className={FIELD_CLASS}
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
					{t("previewSheetNoteCancel")}
				</Button>
				<Button
					type="button"
					size="xs"
					disabled={blocked || pending}
					onClick={submit}
				>
					{submitLabel}
				</Button>
			</div>
		</div>
	)
}

// A note: its text as written (its first line is the author's name when Excel wrote it), or the field editing it.
export function NoteBody({
	note,
	editing,
	initial,
	onSave,
	onCancel
}: {
	note: SheetNote | null
	editing: boolean
	initial: string
	// Resolves whether the note was written (false: the author name was not given); the field stays until it was.
	onSave: (text: string) => Promise<boolean>
	onCancel: () => void
}) {
	const { t } = useTranslation("preview")

	if (editing) {
		return (
			<CardField
				initial={note?.text ?? initial}
				label={t("previewSheetNoteText")}
				placeholder={t("previewSheetNotePlaceholder")}
				submitLabel={t("previewSheetNoteSave")}
				allowEmpty
				onSubmit={onSave}
				onCancel={onCancel}
			/>
		)
	}

	return <p className="break-words whitespace-pre-wrap">{note?.text ?? ""}</p>
}

function CommentMenu({ own, root, onEdit, onDelete }: { own: boolean; root: boolean; onEdit: () => void; onDelete: () => void }) {
	const { t } = useTranslation("preview")

	return (
		<DropdownMenu>
			<Tooltip>
				<TooltipTrigger
					render={
						<DropdownMenuTrigger
							render={
								<Button
									variant="ghost"
									size="icon-xs"
									aria-label={t("previewSheetCommentActions")}
								/>
							}
						>
							<MoreHorizontalIcon />
						</DropdownMenuTrigger>
					}
				/>
				<TooltipContent>{t("previewSheetCommentActions")}</TooltipContent>
			</Tooltip>
			<DropdownMenuContent align="end">
				{own ? <DropdownMenuItem onClick={onEdit}>{t("previewSheetCommentEdit")}</DropdownMenuItem> : null}
				<DropdownMenuItem
					variant="destructive"
					onClick={onDelete}
				>
					{root ? t("previewSheetCommentDeleteThread") : t("previewSheetCommentDelete")}
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

// A comment thread: each comment with its author and date, the author's own editable; when opened and writable, the
// reply field. With no thread yet (composing), the field starting one.
export function ThreadBody({
	thread,
	opened,
	canEdit,
	onPost,
	onEdit,
	onDelete,
	onCancel
}: {
	thread: SheetThread | null
	opened: boolean
	canEdit: boolean
	// Resolves whether the comment was written (false: the author name was not given); the field stays until it was.
	onPost: (text: string) => Promise<boolean>
	onEdit: (id: string, text: string) => void
	onDelete: (id: string) => void
	onCancel: () => void
}) {
	const { t } = useTranslation("preview")
	const [editing, setEditing] = useState<string | null>(null)
	const [replying, setReplying] = useState(false)
	const authors = [...new Set(thread?.comments.map(comment => comment.author) ?? [])]

	if (thread === null) {
		return opened && canEdit ? (
			<CardField
				initial=""
				label={t("previewSheetCommentPlaceholder")}
				placeholder={t("previewSheetCommentPlaceholder")}
				submitLabel={t("previewSheetCommentPost")}
				allowEmpty={false}
				onSubmit={onPost}
				onCancel={onCancel}
			/>
		) : null
	}

	return (
		<div className={cn("flex flex-col gap-2", thread.done && "opacity-80")}>
			{thread.comments.map((comment, k) => (
				<div
					key={comment.id}
					className={cn("flex flex-col gap-1", k > 0 && "border-t border-border pt-2")}
				>
					<div className="flex items-center justify-between gap-2">
						<Byline
							name={comment.author === "" ? t("previewSheetUnknownAuthor") : comment.author}
							date={comment.date === "" ? "" : formatShortDate(comment.date)}
							color={revisionColor(authors.indexOf(comment.author))}
						/>
						<div className="flex shrink-0 items-center gap-1">
							{k === 0 && thread.done ? (
								<span className="text-muted-foreground">{t("previewSheetCommentResolved")}</span>
							) : null}
							{opened && canEdit ? (
								<CommentMenu
									own={comment.own && !comment.mentions}
									root={k === 0}
									onEdit={() => {
										setEditing(comment.id)
									}}
									onDelete={() => {
										onDelete(comment.id)
									}}
								/>
							) : null}
						</div>
					</div>
					{editing === comment.id ? (
						<CardField
							initial={comment.text}
							label={t("previewSheetCommentEdit")}
							placeholder={t("previewSheetCommentPlaceholder")}
							submitLabel={t("previewSheetCommentSave")}
							allowEmpty={false}
							onSubmit={text => {
								setEditing(null)
								onEdit(comment.id, text)
							}}
							onCancel={() => {
								setEditing(null)
							}}
						/>
					) : (
						<p className={cn("break-words whitespace-pre-wrap", !opened && "line-clamp-4")}>{comment.text}</p>
					)}
				</div>
			))}
			{opened && canEdit ? (
				replying ? (
					<CardField
						initial=""
						label={t("previewSheetCommentReplyPlaceholder")}
						placeholder={t("previewSheetCommentReplyPlaceholder")}
						submitLabel={t("previewSheetCommentReply")}
						allowEmpty={false}
						onSubmit={text =>
							onPost(text).then(posted => {
								if (posted) {
									setReplying(false)
								}
							})
						}
						onCancel={() => {
							setReplying(false)
						}}
					/>
				) : (
					<button
						type="button"
						className="rounded-xl border border-border px-2 py-1.5 text-left text-muted-foreground outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/30"
						onClick={() => {
							setReplying(true)
						}}
					>
						{t("previewSheetCommentReplyPlaceholder")}
					</button>
				)
			) : null}
		</div>
	)
}

// A link: where it goes, how to open it from the grid, and its actions.
export function LinkBody({
	link,
	sheets,
	mac,
	canEdit,
	onOpen,
	onEdit,
	onRemove
}: {
	link: SheetLink | null
	sheets: readonly SheetSummary[]
	mac: boolean
	canEdit: boolean
	onOpen: () => void
	onEdit: () => void
	onRemove: () => void
}) {
	const { t } = useTranslation("preview")
	const action = linkAction(link)

	return (
		<div className="flex flex-col gap-2">
			{link?.tooltip === null || link?.tooltip === undefined ? null : (
				<p className="break-words whitespace-pre-wrap">{link.tooltip}</p>
			)}
			<p className="truncate text-muted-foreground">
				{action.kind === "open"
					? action.href
					: action.kind === "go"
						? t("previewSheetLinkPlace", { place: placeName(sheets, action.place) })
						: action.kind === "blocked"
							? t("previewSheetLinkBlocked")
							: action.kind === "nowhere"
								? t("previewSheetLinkNowhere")
								: t("previewSheetLinkCalculated")}
			</p>
			{action.kind === "open" || action.kind === "go" ? (
				<p className="text-muted-foreground">{mac ? t("previewSheetLinkHintMac") : t("previewSheetLinkHint")}</p>
			) : null}
			<div className="flex flex-wrap gap-1">
				{action.kind === "open" || action.kind === "go" ? (
					<Button
						type="button"
						size="xs"
						variant="outline"
						onClick={onOpen}
					>
						<ExternalLinkIcon data-icon="inline-start" />
						{t("previewSheetLinkOpen")}
					</Button>
				) : null}
				{canEdit && link !== null && !link.formula ? (
					<>
						<Button
							type="button"
							size="xs"
							variant="ghost"
							onClick={onEdit}
						>
							{t("previewSheetLinkEdit")}
						</Button>
						<Button
							type="button"
							size="xs"
							variant="ghost"
							onClick={onRemove}
						>
							{t("previewSheetLinkRemove")}
						</Button>
					</>
				) : null}
			</div>
		</div>
	)
}

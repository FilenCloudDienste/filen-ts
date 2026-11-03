import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { NotesPanel, PresentationTextEditor } from "@filen/office/react/presentation"
import type { SlideRef, SlideReview } from "@filen/office/core/presentation"
import { useElementSize } from "@/lib/useElementSize"
import {
	askSlideNotesAgain,
	focusSettled,
	useAskSlideNotes,
	useSlideNotesAnswer
} from "@/features/presentation/components/commentsPane.logic"
import type { PresentationRibbonEditor } from "@/features/presentation/components/ribbon/tabs"
import { refusalKey } from "@/features/presentation/hooks/usePresentationSession"
import { usePresentationTextBindings } from "@/features/presentation/lib/keymap/text"

const STORAGE_KEY = "filen.presentation.notes"

interface NotesLayout {
	collapsed: boolean
	height: number
}

// The viewer's own preference, remembered in this browser only (absent or unreadable storage: the defaults).
function readLayout(): NotesLayout | null {
	try {
		const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null")

		if (typeof parsed === "object" && parsed !== null) {
			const { collapsed, height } = parsed as Partial<NotesLayout>

			if (typeof collapsed === "boolean" && typeof height === "number" && Number.isFinite(height)) return { collapsed, height }
		}
	} catch {
		// Storage blocked or the value damaged: the defaults.
	}

	return null
}

function writeLayout(layout: NotesLayout): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(layout))
	} catch {
		// Storage blocked: the layout lasts for this viewer only.
	}
}

// Padding around the notes body (px), as the pane shows it.
const INSET = 8
const MIN_SCALE = 0.25

type NotesBox = NonNullable<SlideReview["notesBox"]>

// The notes of an editable deck: their text as the worker last answered (the slide's render's until then), and on a
// click the notes body itself in the presentation text editor (the worker lays it out in its notes page's box, as every
// slide body), fitted to the pane's width. A slide without notes offers to start them: notes.setNotes makes its notes
// slide, and the editor opens on it. Leaving the editor (Escape) puts focus back on the notes.
function NotesEditor({
	editor,
	text,
	otherEditing,
	onEditStart
}: {
	editor: PresentationRibbonEditor
	text: string
	otherEditing: boolean
	onEditStart?: () => void
}) {
	const { t } = useTranslation("preview")
	const bindings = usePresentationTextBindings()
	const [host, setHost] = useState<HTMLElement | null>(null)
	// Focus goes back to the notes once the editor has closed.
	const refocus = useRef(false)
	// The editor's page takes focus as it opens, so a key before the editor has focused its own view (Escape at once)
	// is the notes' and never the overlay's.
	const holdFocus = useRef(false)
	// Notes this pane started (notes.setNotes) and nothing done since: `revision` the history's after it (undefined
	// while the op is in flight), `left` the editor closed meanwhile.
	const started = useRef<{ readonly slide: SlideRef; revision?: number; left: boolean } | null>(null)
	const width = useElementSize(host).width
	// The body opened on a slide (and where its first caret goes); notes started on a click open once the review names
	// their new body.
	const [opened, setOpened] = useState<{ readonly slide: SlideRef; readonly at?: { readonly x: number; readonly y: number } } | null>(
		null
	)
	const slide = editor.render?.ref
	// Another slide in view: what was opened on the last one is over (coming back does not open it again).
	const [shownSlide, setShownSlide] = useState(slide)

	if (shownSlide !== slide) {
		setShownSlide(slide)
		setOpened(null)
	}

	const answer = useSlideNotesAnswer(slide)
	const review = answer.review
	const notes = review?.notes
	const box: NotesBox | undefined = review?.notesBox
	// The notes page at its own size (its text at the size it prints), narrowed to fit a narrower pane.
	const scale = box === undefined || box.width <= 0 ? 1 : Math.min(1, Math.max(MIN_SCALE, (width - 2 * INSET) / box.width))
	const open = opened !== null && opened.slide === slide && notes !== undefined && box !== undefined && !otherEditing
	const editing = editor.text
	const shown = review?.notesText ?? text

	// Asked again after every op, undo or redo, the editor open or not: notes an undo took away (by any path: the
	// editor's, the ribbon's, the keys') close the editor, so nothing is typed into a body that is gone. The body's
	// object stays the same while it is the same body (commentsPane.logic.ts), so the open editor never restarts.
	useAskSlideNotes(editor, true)

	// Notes started here and left with nothing in them are taken back: the worker retracts the step that made them
	// while it is still the last thing done, so the history is as it was before (its redo stack too) and nothing is
	// saved. A body's text in flight, or anything done since, keeps them.
	const takeBack = (revision: number): void => {
		if (editor.text?.pending === true) return

		// The worker decides: still the last thing done, or taken back by a save meanwhile (then dropped for good, and
		// the notes are asked for again: nothing else changed).
		const slideNow = slide
		void editor.session.retract(revision).then(
			result => {
				if (result.ok && slideNow !== undefined) askSlideNotesAgain(editor.session, slideNow)
			},
			() => undefined
		)
	}
	const leave = (): void => {
		const made = started.current

		if (made === null) return
		if (made.revision === undefined) {
			made.left = true

			return
		}

		started.current = null
		takeBack(made.revision)
	}
	const wasOpen = useRef(false)

	// The editor closed (Escape, another body opened, another slide), or the slide changed before it opened.
	useEffect(() => {
		const closed = wasOpen.current && !open

		wasOpen.current = open

		// The notes went away under the open editor (an undo took them back): focus goes back to the notes.
		if (closed && notes === undefined && opened?.slide === slide) refocus.current = true

		if (closed || (started.current !== null && started.current.slide !== slide)) leave()
	})

	// After the effect above (it asks for focus when the notes went away under the editor), in the same commit.
	useEffect(() => {
		// The read view's element, once it replaced the editor's.
		if (open || !refocus.current || !host?.isConnected) return

		refocus.current = false
		focusSettled(host)
	}, [open, host])

	// Notes started here and gone before they opened (an undo, the opening window's Mod+Z, took them back): the opening
	// is over, so nothing more is held for it and they can be started again.
	useEffect(() => {
		const made = started.current

		if (made?.revision === undefined || made.slide !== slide || opened?.slide !== slide || open) return
		if (notes !== undefined || answer.key === undefined || answer.key <= made.revision) return

		started.current = null
		setOpened(null)
	}, [slide, opened, open, notes, answer.key])

	// Nothing asked for (or the pane gone): no editor will open, so no key is held for one.
	useEffect(() => {
		if (opened === null) editing?.drop()
	}, [opened, editing])

	useEffect(
		() => () => {
			editing?.drop()
		},
		[editing]
	)

	// `at`: the click's place on the notes page (px), where the first caret goes.
	const begin = (at?: { readonly x: number; readonly y: number }): void => {
		if (slide === undefined || editing === undefined) return

		if (notes === undefined) {
			// Notes asked for on this slide and not answered yet.
			if (started.current?.slide === slide && started.current.revision === undefined) return

			const made: { readonly slide: SlideRef; revision?: number; left: boolean } = { slide, left: false }

			started.current = made
			holdFocus.current = true
			// Keys typed while the notes are made and their editor opens are typed into them once it is ready.
			editing.expect({ anchor: host, keys: { bindings } })
			setOpened({ slide })
			onEditStart?.()
			void editor.command({ family: "notes", kind: "setNotes", slide, body: { bodyPr: {}, paragraphs: [] } }).then(result => {
				// The editor told the refusal.
				if (!result.ok) {
					if (started.current === made) started.current = null

					editing.drop()
					setOpened(null)

					return
				}

				made.revision = result.revision

				// Left before the notes existed (Escape at once): taken back now.
				if (made.left && started.current === made) {
					started.current = null
					takeBack(result.revision)
				}
			})

			return
		}

		holdFocus.current = true
		setOpened({ slide, ...(at === undefined ? {} : { at }) })
		onEditStart?.()
	}

	if (open && editing !== undefined) {
		return (
			// Focusable: the notes page scrolls when the pane is shorter than it (keyboard users scroll it too).
			<div
				ref={element => {
					setHost(element)

					if (element === null || !holdFocus.current) return

					holdFocus.current = false

					// Only where focus was lost with the button that opened it (the overlay or the page has it now): focus the
					// user moved meanwhile (the find field, a ribbon tab, a dialog) stays there.
					const active = element.ownerDocument.activeElement

					if (active === null || active === element.ownerDocument.body || (active.contains(element) && active !== element))
						element.focus({ preventScroll: true })
				}}
				// The body opening here: keys typed while it opens are held for it while focus is on it (editing.expect).
				data-fo-text-opening=""
				tabIndex={0}
				aria-label={t("previewPptxNotesPage")}
				className="relative size-full overflow-auto outline-none focus-visible:ring-[3px] focus-visible:ring-ring/30"
				onKeyDown={event => {
					// An Escape the editor's view did not take (it has not focused yet): the notes close, the file stays.
					if (event.key !== "Escape" || event.defaultPrevented) return

					event.preventDefault()
					event.stopPropagation()
					refocus.current = true
					setOpened(null)
				}}
			>
				{/* The notes page is paper: its text is drawn in the page's own colours, in either theme. */}
				<div
					className="relative m-1 rounded-sm bg-white ring-1 ring-border"
					style={{ height: box.height * scale + 2 * INSET, width: box.width * scale + 2 * INSET }}
				>
					<div
						className="absolute"
						style={{ left: INSET - box.x * scale, top: INSET - box.y * scale, width: 0, height: 0 }}
					>
						<PresentationTextEditor
							key={`${String(notes.slide)}:${String(notes.id)}`}
							session={editor.session}
							shape={notes}
							scale={scale}
							editing={editing}
							bindings={bindings}
							labels={{ editor: t("previewPptxNotesEditor") }}
							{...(opened.at === undefined ? {} : { at: opened.at })}
							onExit={() => {
								refocus.current = true
								setOpened(null)
							}}
							onRefused={reason => {
								toast.error(t(refusalKey(reason)))
							}}
						/>
					</div>
				</div>
			</div>
		)
	}

	const paragraphs = shown === "" ? [] : shown.split("\n")

	return (
		<div
			ref={setHost}
			role="button"
			tabIndex={0}
			aria-label={notes === undefined ? t("previewPptxNotesAdd") : t("previewPptxNotesEditor")}
			className="size-full cursor-text overflow-auto p-2 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/30"
			onClick={event => {
				const rect = event.currentTarget.getBoundingClientRect()

				begin(
					box === undefined
						? undefined
						: { x: (event.clientX - rect.left - INSET) / scale + box.x, y: (event.clientY - rect.top - INSET) / scale + box.y }
				)
			}}
			onKeyDown={event => {
				if (event.key === "Enter" || event.key === " ") {
					event.preventDefault()
					begin()
				} else if (event.key === "Escape" && opened !== null) {
					// Notes asked for and not open yet: Escape takes the request back, the file stays.
					event.preventDefault()
					event.stopPropagation()
					editing?.drop()
					setOpened(null)
					leave()
				}
			}}
		>
			{paragraphs.length === 0 ? (
				<p className="text-muted-foreground">{t("previewPptxNotesAdd")}</p>
			) : (
				paragraphs.map((paragraph, index) => (
					<p
						key={index}
						className="min-h-5 break-words whitespace-pre-wrap"
					>
						{paragraph}
					</p>
				))
			)}
		</div>
	)
}

// The slide's speaker notes under it: collapsible and resizable, collapsed on first use at phone widths. In an
// editable deck they are edited in place (`editor`); `otherEditing`: a body on the slide is open in the text editor
// (the notes editor closes, one body is edited at a time), `onEditStart`: the notes editor opens (the slide's closes).
export function PresentationNotesPane({
	text,
	phone,
	editor,
	otherEditing = false,
	onEditStart
}: {
	text: string
	phone: boolean
	editor?: PresentationRibbonEditor | undefined
	otherEditing?: boolean
	onEditStart?: () => void
}) {
	const { t } = useTranslation("preview")
	const [layout, setLayout] = useState<NotesLayout>(() => readLayout() ?? { collapsed: phone, height: 120 })
	const update = (next: NotesLayout): void => {
		setLayout(next)
		writeLayout(next)
	}

	return (
		<div
			data-preview-surface
			data-office-pane
			className="shrink-0 border-t border-border"
		>
			<NotesPanel
				text={text}
				label={t("previewPptxNotesLabel")}
				expandLabel={t("previewPptxNotesShow")}
				collapseLabel={t("previewPptxNotesHide")}
				resizeLabel={t("previewPptxNotesResize")}
				emptyText={t("previewPptxNotesEmpty")}
				collapsed={layout.collapsed}
				onCollapsedChange={collapsed => {
					update({ ...layout, collapsed })
				}}
				height={layout.height}
				onHeightChange={height => {
					update({ ...layout, height })
				}}
				maxHeight={phone ? 240 : 480}
				{...(editor === undefined || layout.collapsed
					? {}
					: {
							children: (
								<NotesEditor
									editor={editor}
									text={text}
									otherEditing={otherEditing}
									{...(onEditStart === undefined ? {} : { onEditStart })}
								/>
							)
						})}
			/>
		</div>
	)
}

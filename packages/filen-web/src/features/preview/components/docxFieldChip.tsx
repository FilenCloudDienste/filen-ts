import { isImeKeydown } from "@filen/shared/keymap"
import { useEffect, useRef } from "react"
import { useTranslation } from "react-i18next"
import { ArrowRightIcon, ChevronDownIcon, RefreshCwIcon } from "lucide-react"
import type { PagedEditor } from "@filen/office/core/docx/paged"
import type { DocxObjectPress } from "@filen/office/react/docx/editor"
import type { DocxObjectControlProps } from "@/features/preview/components/docxFormControls"
import { fieldChipAction, useCommandMenuFocus } from "@/features/preview/components/docxInsert.logic"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"

// The chip at a field or note reference pressed (Word's field shading with its Update control): Update field;
// for a table of contents Word's choice, page numbers only or the entire table; Go to note at a note reference.
// Shown only while its command is enabled (never while layout rests, as in Mobile view).

// The selection the press puts on what it hit: the caret before a field or note reference (as Word puts it in
// the field: typing never replaces it), in a table of contents' first paragraph, a locked table selected whole.
function selectPressed(editor: PagedEditor, press: DocxObjectPress): void {
	const { hit } = press

	if (hit.story !== editor.activeStory) {
		return
	}

	const node = editor.state.doc.nodeAt(hit.pos)
	const caret = { affinity: 1, page: press.page, line: 0, atom: false } as const

	if (node?.isTextblock === true) {
		editor.select({ ...caret, pos: hit.pos + 1 })
	} else if (node?.isInline === true) {
		editor.select({ ...caret, pos: hit.pos })
	} else {
		editor.select({ ...caret, pos: hit.pos, atom: true })
	}
}

export function DocxFieldChip({ editor, snapshot, container, readOnly, execute, press, onPressDone }: DocxObjectControlProps) {
	const { t } = useTranslation("preview")
	const focus = useCommandMenuFocus()
	const chipRef = useRef<HTMLDivElement | null>(null)
	const action = fieldChipAction(press, snapshot, readOnly)

	// A press puts the selection on the field (the snapshot then says what can be done with it); a double click on
	// a note's reference or its own mark goes to the other, as in Word.
	useEffect(() => {
		if (press === null) {
			return
		}

		selectPressed(editor, press)

		if (press.hit.kind === "noteRef" && press.clicks >= 2 && editor.snapshot().enabled["note.goto"]) {
			execute({ type: "note.goto" })
			onPressDone()
		}
	}, [press, editor, execute, onPressDone])

	// Gone with a press elsewhere, Escape or a scroll (it stays where the press was).
	useEffect(() => {
		if (press === null || container === null) {
			return
		}

		const done = (): void => {
			onPressDone()
		}
		// The chip and its menu (portaled) are inside.
		const onDown = (event: PointerEvent): void => {
			const target = event.target

			if (!(
				target instanceof Element &&
				(chipRef.current?.contains(target) === true || target.closest("[data-docx-field-chip-menu]") !== null)
			)) {
				onPressDone()
			}
		}
		const onKey = (event: KeyboardEvent): void => {
			if (event.key === "Escape" && !isImeKeydown(event)) {
				onPressDone()
			}
		}

		// Added once the press that opened it was dispatched: only later presses reach it.
		window.addEventListener("pointerdown", onDown, true)
		container.addEventListener("scroll", done, true)
		window.addEventListener("keydown", onKey, true)

		return () => {
			window.removeEventListener("pointerdown", onDown, true)
			container.removeEventListener("scroll", done, true)
			window.removeEventListener("keydown", onKey, true)
		}
	}, [press, container, onPressDone])

	if (press === null || action === null || container === null) {
		return null
	}

	const rect = container.getBoundingClientRect()
	const style = { left: Math.max(4, press.clientX - rect.left), top: Math.max(4, press.clientY - rect.top + 14) }
	const done = (): void => {
		onPressDone()
	}

	return (
		<div
			ref={chipRef}
			role="toolbar"
			aria-label={t("previewDocxFieldChip")}
			data-docx-field-chip
			className="absolute z-20 flex items-center rounded-full bg-popover p-0.5 shadow-md ring-1 ring-foreground/10"
			style={style}
		>
			{action === "field" ? (
				<Button
					variant="ghost"
					size="xs"
					onClick={() => {
						execute({ type: "field.update" })
						done()
					}}
				>
					<RefreshCwIcon data-icon="inline-start" />
					{t("previewDocxUpdateField")}
				</Button>
			) : action === "note" ? (
				<Button
					variant="ghost"
					size="xs"
					onClick={() => {
						execute({ type: "note.goto" })
						done()
					}}
				>
					<ArrowRightIcon data-icon="inline-start" />
					{t("previewDocxNoteGoTo")}
				</Button>
			) : (
				<DropdownMenu>
					<DropdownMenuTrigger
						render={
							<Button
								variant="ghost"
								size="xs"
							>
								<RefreshCwIcon data-icon="inline-start" />
								{t("previewDocxUpdateToc")}
								<ChevronDownIcon data-icon="inline-end" />
							</Button>
						}
					/>
					<DropdownMenuContent
						data-preview-surface
						data-docx-field-chip-menu
						finalFocus={focus.finalFocus}
					>
						<DropdownMenuItem
							onClick={() => {
								execute({ type: "toc.update", pagesOnly: true })
								focus.ran()
								done()
							}}
						>
							{t("previewDocxTocUpdatePages")}
						</DropdownMenuItem>
						<DropdownMenuItem
							onClick={() => {
								execute({ type: "toc.update", pagesOnly: false })
								focus.ran()
								done()
							}}
						>
							{t("previewDocxTocUpdateAll")}
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			)}
		</div>
	)
}

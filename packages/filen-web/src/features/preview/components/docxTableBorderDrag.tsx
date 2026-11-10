import { isImeKeydown } from "@filen/shared/keymap"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import type { DocxEditorCommand } from "@filen/office/core/docx/edit"
import { tableBorderOf, type DocxTableBorder, type PagedEditor } from "@filen/office/core/docx/paged"
import type { DocxObjectPress } from "@filen/office/react/docx/editor"
import { borderDragOffset, borderDragWidth } from "@/features/preview/components/docxEditor.logic"
import { useLatestRef } from "@/lib/useLatestRef"

// Dragging a table's column border on the pages (a press on a "tableBorder" hit): a guide follows the pointer
// over the pages, and the release sets the column's width (table.column.width, which takes the width from the
// column after it). The caret goes into the table first, as the command acts on the selection's table. In a
// right-to-left table the column's border is its left one, so the drag's direction turns.
// Esc or a lost pointer cancels.

export interface DocxTableBorderDragProps {
	editor: PagedEditor
	// The press on a table border, until done.
	press: DocxObjectPress | null
	onPressDone: () => void
	container: HTMLDivElement | null
	zoom: number
	readOnly: boolean
	execute: (command: DocxEditorCommand) => void
}

interface Drag {
	readonly press: DocxObjectPress
	readonly border: DocxTableBorder
}

export function DocxTableBorderDrag({ editor, press, onPressDone, container, zoom, readOnly, execute }: DocxTableBorderDragProps) {
	const { t } = useTranslation("preview")
	const executeRef = useLatestRef(execute)
	const doneRef = useLatestRef(onPressDone)
	// The press's border, when it is one that can be dragged (read once per press).
	const border = press === null || readOnly ? undefined : tableBorderOf(editor, press.hit)
	const drag: Drag | null = press === null || border === undefined ? null : { press, border }
	// The width the pointer gives the column now (twips), for the press it was moved in; a drag ended (or
	// cancelled) is gone until the press is done.
	const [moved, setMoved] = useState<{ press: DocxObjectPress; twips: number; ended: boolean } | null>(null)
	const twips = moved?.press === press ? moved.twips : border === undefined ? 0 : (border.widths[border.column] ?? 0)
	const ended = moved?.press === press && moved.ended

	// A press on no draggable border is done at once.
	useEffect(() => {
		if (press !== null && border === undefined) {
			doneRef.current()
		}
	}, [press, border, doneRef])

	const dragPress = drag?.press ?? null
	const dragBorder = drag?.border ?? null

	useEffect(() => {
		if (dragPress === null || dragBorder === null) {
			return
		}

		const start = dragPress
		const line = dragBorder
		const finish = (event: PointerEvent | null): void => {
			window.removeEventListener("pointermove", move)
			window.removeEventListener("pointerup", up)
			window.removeEventListener("pointercancel", cancel)
			window.removeEventListener("keydown", key, true)
			setMoved(previous => ({ press: start, twips: previous?.press === start ? previous.twips : 0, ended: true }))

			if (event !== null) {
				const width = borderDragWidth(line, event.clientX - start.clientX, zoom)

				if (width !== (line.widths[line.column] ?? 0)) {
					const hit = editor.hitTest(start.page, start.x, start.y)

					if (hit !== undefined) {
						editor.select(hit)
					}

					executeRef.current({ type: "table.column.width", index: line.column, twips: width })
				}
			}

			doneRef.current()
		}
		const move = (event: PointerEvent): void => {
			if (event.pointerId === start.pointerId) {
				setMoved({ press: start, twips: borderDragWidth(line, event.clientX - start.clientX, zoom), ended: false })
			}
		}
		const up = (event: PointerEvent): void => {
			if (event.pointerId === start.pointerId) {
				finish(event)
			}
		}
		const cancel = (event: PointerEvent): void => {
			if (event.pointerId === start.pointerId) {
				finish(null)
			}
		}
		const key = (event: KeyboardEvent): void => {
			if (event.key === "Escape" && !isImeKeydown(event)) {
				event.preventDefault()
				event.stopPropagation()
				finish(null)
			}
		}

		window.addEventListener("pointermove", move)
		window.addEventListener("pointerup", up)
		window.addEventListener("pointercancel", cancel)
		window.addEventListener("keydown", key, true)

		return () => {
			window.removeEventListener("pointermove", move)
			window.removeEventListener("pointerup", up)
			window.removeEventListener("pointercancel", cancel)
			window.removeEventListener("keydown", key, true)
		}
	}, [dragPress, dragBorder, editor, zoom, executeRef, doneRef])

	if (drag === null || ended || container === null) {
		return null
	}

	const box = container.getBoundingClientRect()
	const left = drag.press.clientX - box.left + borderDragOffset(drag.border, twips, zoom)

	return (
		<div
			role="separator"
			aria-orientation="vertical"
			aria-label={t("previewDocxTableBorderGuide")}
			data-docx-border-guide=""
			className="pointer-events-none absolute inset-y-0 z-20 w-px bg-primary"
			style={{ left }}
		/>
	)
}

import { isImeKeydown } from "@filen/shared/keymap"
import { useEffect, useLayoutEffect, useState } from "react"
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
	// Where the guide shows in the container now (px), for the press it was placed for; a drag ended (or
	// cancelled) is gone until the press is done. Placed from the container's box as each pointer event reads it,
	// never in render: the compiler would keep a box read there for as long as the container is the same element.
	const [guide, setGuide] = useState<{ press: DocxObjectPress; left: number | null; ended: boolean } | null>(null)

	// A press on no draggable border is done at once.
	useEffect(() => {
		if (press !== null && border === undefined) {
			doneRef.current()
		}
	}, [press, border, doneRef])

	const dragPress = drag?.press ?? null
	const dragBorder = drag?.border ?? null

	// Before paint, so the guide shows at the border from the press on.
	useLayoutEffect(() => {
		if (dragPress === null || dragBorder === null) {
			return
		}

		const start = dragPress
		const line = dragBorder
		// Where the guide for a column `twips` wide shows, from the container's box as it is now.
		const leftFor = (twips: number): number | null =>
			container === null ? null : start.clientX - container.getBoundingClientRect().left + borderDragOffset(line, twips, zoom)
		const finish = (event: PointerEvent | null): void => {
			window.removeEventListener("pointermove", move)
			window.removeEventListener("pointerup", up)
			window.removeEventListener("pointercancel", cancel)
			window.removeEventListener("keydown", key, true)
			setGuide(previous => ({ press: start, left: previous?.press === start ? previous.left : null, ended: true }))

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
				setGuide({ press: start, left: leftFor(borderDragWidth(line, event.clientX - start.clientX, zoom)), ended: false })
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

		// At the border itself until the pointer moves; a guide this press already has stays where it is.
		const initial = leftFor(line.widths[line.column] ?? 0)

		setGuide(previous => (previous?.press === start ? previous : { press: start, left: initial, ended: false }))
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
	}, [dragPress, dragBorder, container, editor, zoom, executeRef, doneRef])

	const left = drag !== null && guide?.press === drag.press && !guide.ended ? guide.left : null

	if (left === null) {
		return null
	}

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

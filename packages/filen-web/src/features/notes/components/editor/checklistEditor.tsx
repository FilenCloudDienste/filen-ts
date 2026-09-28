import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { CheckIcon } from "lucide-react"
import { type Checklist, cn, addChecklistLine, removeChecklistItem } from "@filen/shared"
import { isImeKeydown } from "@/lib/ime"
import type { NoteEditorController } from "@/features/notes/hooks/useNoteEditor"
import {
	parseChecklistSeed,
	serializeChecklist,
	toggleChecklistItem,
	setChecklistItemContent,
	visibleChecklistRows
} from "@/features/notes/components/editor/checklistEditor.logic"

// Custom checklist editor (mirrors mobile's content/checklist screen): one text input per row with a
// leading toggle. Enter on a non-empty row appends a row and focuses it; Backspace on an empty row
// removes it and focuses the previous; the toggle checks/unchecks. Every mutation serializes through
// @filen/shared checklistParser to the canonical `<ul data-checked>` HTML and enqueues it on the
// fault-tolerant outbox (controller.onChange). The CALLER keys this on controller.remountKey so the
// seed freezes at mount and a real reseed remounts fresh (the EDITOR INVARIANT).
//
// No didType gate is needed here (unlike mobile): the row state is seeded synchronously in the useState
// initializer, never via a hydration effect that writes-then-propagates, so every onChange call
// originates from a genuine user event and none is spurious.
export function ChecklistEditor({
	controller,
	hideCompleted: hideCompletedProp
}: {
	controller: NoteEditorController
	// "Hide completed items" filters checked rows out of the RENDER only; the underlying `rows` state
	// (and every edit handler below, which all look up by id against the full array) is untouched by this.
	hideCompleted?: boolean
}) {
	// Not a destructuring default, which the React Compiler cannot lower.
	const hideCompleted = hideCompletedProp ?? false
	const { t } = useTranslation("notes")
	const [rows, setRows] = useState<Checklist>(() => parseChecklistSeed(controller.seed, () => crypto.randomUUID()))
	// With every row hidden (all completed, "hide completed" on) no input would render, and every edit hangs
	// off one. A ghost row stands in: never in `rows` or the content until typed into, then appended under
	// this same id so the React key (and the focused input) survives the swap; a fresh id serves the next one.
	const [ghostId, setGhostId] = useState(() => crypto.randomUUID())
	// Live input elements by row id, for focus moves after add/remove. A ref (instance state), not
	// state — the React Compiler keeps it stable and mutating it never triggers a render.
	const inputRefs = useRef<Map<string, HTMLInputElement>>(new Map())
	// The outbox enqueue callback, held in a ref so the event handlers below always call the freshest
	// identity without re-subscribing anything (mobile parity: onChange is the only sync path).
	const onChangeRef = useRef(controller.onChange)

	useEffect(() => {
		onChangeRef.current = controller.onChange
	})

	function commit(next: Checklist): void {
		setRows(next)
		onChangeRef.current(serializeChecklist(next))
	}

	function focusRow(id: string): void {
		const el = inputRefs.current.get(id)

		if (!el) {
			return
		}

		el.focus()

		const caret = el.value.length

		el.setSelectionRange(caret, caret)
	}

	function handleContentChange(id: string, content: string): void {
		if (id === ghostId) {
			commit([...rows, { id, checked: false, content }])
			setGhostId(crypto.randomUUID())

			return
		}

		commit(setChecklistItemContent(rows, id, content))
	}

	function handleToggle(id: string, checked: boolean): void {
		const item = rows.find(row => row.id === id)

		if (!item) {
			return
		}

		// Mobile parity: never check an empty row (an empty checked item is meaningless and would
		// serialize a stray checked <li>).
		if (checked && item.content.trim().length === 0) {
			return
		}

		commit(toggleChecklistItem(rows, id, checked))
	}

	function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>, id: string): void {
		const item = rows.find(row => row.id === id)

		// An input method's own Enter (confirming a conversion) is not a new row.
		if (!item || isImeKeydown(event.nativeEvent)) {
			return
		}

		if (event.key === "Enter") {
			event.preventDefault()

			// An empty row's Enter just keeps focus (mobile onSubmitEditing) — nothing to append after.
			if (item.content.trim().length === 0) {
				return
			}

			const result = addChecklistLine(rows, id, crypto.randomUUID())

			if (result.changed) {
				commit(result.next)
			}

			if (result.focusId !== null) {
				const focusId = result.focusId

				// The added row's input has not mounted yet — defer the focus one frame so its ref is
				// registered by the time we reach for it (mobile defers with a macrotask for the same reason).
				requestAnimationFrame(() => {
					focusRow(focusId)
				})
			}

			return
		}

		if (event.key === "Backspace" && item.content.length === 0) {
			event.preventDefault()

			const result = removeChecklistItem(rows, id, crypto.randomUUID())

			if (!result.changed) {
				return
			}

			commit(result.next)

			if (result.focusId === null) {
				return
			}

			const target = backspaceFocusTarget(result.next, rows.indexOf(item), result.focusId)

			if (target === null) {
				// Nothing left visible: the ghost row mounts with this commit, so its input exists next frame.
				requestAnimationFrame(() => {
					focusRow(ghostId)
				})

				return
			}

			focusRow(target)
		}
	}

	// The previous row takes focus after a removal, unless "hide completed" hides it: then the nearest
	// visible row before the removed one, else after it, else null (the ghost row).
	function backspaceFocusTarget(next: Checklist, removedIndex: number, focusId: string): string | null {
		if (!hideCompleted) {
			return focusId
		}

		for (let i = removedIndex - 1; i >= 0; i--) {
			const row = next[i]

			if (row !== undefined && !row.checked) {
				return row.id
			}
		}

		return next.slice(removedIndex).find(row => !row.checked)?.id ?? null
	}

	const visibleRows = visibleChecklistRows(rows, hideCompleted)
	const renderedRows: Checklist = visibleRows.length > 0 ? visibleRows : [{ id: ghostId, checked: false, content: "" }]

	return (
		<div className="flex size-full flex-col gap-0.5 overflow-auto p-4">
			{renderedRows.map(item => (
				<div
					key={item.id}
					className="flex items-start gap-2.5 rounded-md px-2 py-1.5"
				>
					<button
						type="button"
						role="checkbox"
						aria-checked={item.checked}
						aria-label={t("noteChecklistToggle")}
						onClick={() => {
							handleToggle(item.id, !item.checked)
						}}
						className={cn(
							"mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors",
							item.checked ? "border-primary bg-primary text-primary-foreground" : "border-input"
						)}
					>
						{item.checked ? <CheckIcon className="size-3" /> : null}
					</button>
					<input
						ref={el => {
							if (el) {
								inputRefs.current.set(item.id, el)
							} else {
								inputRefs.current.delete(item.id)
							}
						}}
						type="text"
						value={item.content}
						aria-label={t("noteChecklistRowInput")}
						placeholder={t("noteChecklistItemPlaceholder")}
						onChange={event => {
							handleContentChange(item.id, event.target.value)
						}}
						onKeyDown={event => {
							handleKeyDown(event, item.id)
						}}
						autoComplete="off"
						autoCorrect="off"
						spellCheck={false}
						className={cn(
							"min-w-0 flex-1 bg-transparent text-sm leading-6 outline-none placeholder:text-muted-foreground/60",
							item.checked && "text-muted-foreground line-through"
						)}
					/>
				</div>
			))}
		</div>
	)
}

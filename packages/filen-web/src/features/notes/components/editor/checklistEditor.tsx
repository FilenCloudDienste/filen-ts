import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { CheckIcon } from "lucide-react"
import { type Checklist } from "@filen/utils"
import { cn } from "@/lib/utils"
import type { NoteEditorController } from "@/features/notes/hooks/useNoteEditor"
import {
	parseChecklistSeed,
	serializeChecklist,
	addChecklistLine,
	removeChecklistItem,
	toggleChecklistItem,
	setChecklistItemContent
} from "@/features/notes/components/editor/checklistEditor.logic"

// Custom checklist editor (mirrors mobile's content/checklist screen): one text input per row with a
// leading toggle. Enter on a non-empty row appends a row and focuses it; Backspace on an empty row
// removes it and focuses the previous; the toggle checks/unchecks. Every mutation serializes through
// @filen/utils checklistParser to the canonical `<ul data-checked>` HTML and enqueues it on the
// fault-tolerant outbox (controller.onChange). The CALLER keys this on controller.remountKey so the
// seed freezes at mount and a real reseed remounts fresh (the EDITOR INVARIANT).
//
// No didType gate is needed here (unlike mobile): the row state is seeded synchronously in the useState
// initializer, never via a hydration effect that writes-then-propagates, so every onChange call
// originates from a genuine user event and none is spurious.
export function ChecklistEditor({ controller }: { controller: NoteEditorController }) {
	const { t } = useTranslation("notes")
	const [rows, setRows] = useState<Checklist>(() => parseChecklistSeed(controller.seed, () => crypto.randomUUID()))
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

		if (!item) {
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

			if (result.focusId !== null) {
				focusRow(result.focusId)
			}
		}
	}

	return (
		<div className="flex size-full flex-col gap-0.5 overflow-auto p-4">
			{rows.map(item => (
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

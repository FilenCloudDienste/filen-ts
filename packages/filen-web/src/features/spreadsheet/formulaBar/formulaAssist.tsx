import { useEffect, useId, useLayoutEffect, useRef, type RefObject } from "react"
import { createPortal } from "react-dom"
import { useTranslation } from "react-i18next"
import { argumentAt, sheetFunction, signatureParts, type FormulaCall, type SheetFunction } from "@filen/office/core/sheet"
import type { SheetGridHandle } from "@filen/office/react/sheet"
import { cn } from "@filen/shared"

function optionId(list: string, index: number): string {
	return `${list}-${String(index)}`
}

// What typing a formula offers under the editor: the function names the word typed could become (Tab takes the one
// chosen, a click any) and the syntax of the call the caret is in, its current argument in bold. Placed under the
// editor typed in (the cell's or the formula bar's), above it where the box would cover what is below the grid (the
// sheet tabs), and again whenever the grid draws a frame (a scroll moves the cell's editor). The editor is tied to the
// list (aria-controls, aria-activedescendant), so a screen reader announces the suggestion chosen.
export function FormulaAssist({
	editor,
	gridRef,
	suggestions,
	choice,
	call,
	separator,
	onChoose
}: {
	editor: HTMLInputElement | HTMLTextAreaElement
	gridRef: RefObject<SheetGridHandle | null>
	suggestions: readonly SheetFunction[]
	choice: number
	call: FormulaCall | null
	separator: string
	onChoose: (index: number) => void
}) {
	const { t } = useTranslation("preview")
	const boxRef = useRef<HTMLDivElement>(null)
	const entry = call === null ? undefined : sheetFunction(call.name)
	const current = entry === undefined || call === null ? -1 : argumentAt(entry, call.argument)
	const listId = useId()
	const listed = suggestions.length > 0

	function place(): void {
		const box = boxRef.current

		if (box === null) return

		const rect = editor.getBoundingClientRect()
		const limit = editor.closest(".fo-sheet")?.getBoundingClientRect().bottom ?? window.innerHeight
		const height = box.offsetHeight
		const below = rect.bottom + 2
		const above = rect.top - 2 - height
		const top = below + height > limit && above >= 0 ? above : below

		box.style.transform = `translate(${String(Math.round(rect.left))}px, ${String(Math.round(top))}px)`
	}

	useLayoutEffect(place)

	// The editor belongs to the grid or the formula bar: tied to the list while there is one.
	useLayoutEffect(() => {
		if (!listed) return

		editor.setAttribute("aria-autocomplete", "list")
		editor.setAttribute("aria-controls", listId)

		return () => {
			editor.removeAttribute("aria-autocomplete")
			editor.removeAttribute("aria-controls")
			editor.removeAttribute("aria-activedescendant")
		}
	}, [editor, listId, listed])

	useLayoutEffect(() => {
		if (listed && choice >= 0 && choice < suggestions.length) editor.setAttribute("aria-activedescendant", optionId(listId, choice))
		else editor.removeAttribute("aria-activedescendant")
	}, [editor, listId, listed, choice, suggestions.length])

	useEffect(() => {
		const unframe = gridRef.current?.onFrame(place)

		window.addEventListener("resize", place)

		return () => {
			unframe?.()
			window.removeEventListener("resize", place)
		}
	})

	if (suggestions.length === 0 && entry === undefined) return null

	return createPortal(
		<div
			ref={boxRef}
			className="fixed top-0 left-0 z-50 flex max-w-80 flex-col gap-1 text-xs"
		>
			{entry === undefined ? null : (
				<div
					role="status"
					aria-label={t("previewSheetFormulaSignature")}
					className="w-max max-w-80 rounded-md bg-popover px-2 py-1 font-mono text-popover-foreground shadow-md ring-1 ring-foreground/10"
				>
					{signatureParts(entry, separator).map((part, index) => (
						<span
							key={index}
							className={cn(
								part.argument !== undefined && part.argument === current && "font-semibold text-foreground underline"
							)}
						>
							{part.id === undefined
								? part.text
								: part.optional === true
									? `[${t(`previewSheetArg_${part.id}`)}]`
									: t(`previewSheetArg_${part.id}`)}
						</span>
					))}
				</div>
			)}
			{suggestions.length === 0 ? null : (
				<ul
					id={listId}
					role="listbox"
					aria-label={t("previewSheetFormulaSuggestions")}
					className="pointer-events-auto max-h-56 w-64 scrollbar-gutter-stable overflow-y-auto rounded-md bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10"
				>
					{suggestions.map((suggestion, index) => (
						<li
							key={suggestion.name}
							id={optionId(listId, index)}
							role="option"
							aria-selected={index === choice}
							className="cursor-default truncate rounded-sm px-2 py-1 font-mono aria-selected:bg-accent aria-selected:text-accent-foreground"
							onPointerDown={event => {
								// The editor keeps focus.
								event.preventDefault()
								onChoose(index)
							}}
						>
							{suggestion.name}
						</li>
					))}
				</ul>
			)}
		</div>,
		document.body
	)
}

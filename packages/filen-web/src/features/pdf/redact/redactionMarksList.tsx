import { useEffect, useId, useRef, useState, type RefObject } from "react"
import { useTranslation } from "react-i18next"
import { useVirtualizer } from "@tanstack/react-virtual"
import { XIcon } from "lucide-react"
import type { RedactionMark } from "@filen/office/core/pdfedit/redactVerify"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { markLabel } from "@/features/pdf/redact/redaction.logic"
import { observeElementOffsetFromAttach } from "@/lib/virtualScroll"

// "Marked for redaction (n)": every pending mark in document order, each removable with ✕ (nothing is redacted until
// Apply redactions…), and the button opening the Apply redactions dialog. A removed mark hands focus to the mark now
// in its place (or the one before it, or the list's heading when none is left).

export interface RedactionMarksListProps {
	marks: readonly RedactionMark[]
	onSelect?: ((mark: RedactionMark) => void) | undefined
	onRemove: (mark: RedactionMark) => void
	onApply: () => void
	disabled?: boolean | undefined
}

// The mark removed from its ✕ and where it was: focus moves on once the list no longer has it.
type RemovedMark = { readonly id: number; readonly index: number } | null

export function RedactionMarksList({ marks, onSelect, onRemove, onApply, disabled }: RedactionMarksListProps) {
	const { t } = useTranslation("preview")
	const id = useId()
	const headingRef = useRef<HTMLHeadingElement | null>(null)
	const removed = useRef<RemovedMark>(null)

	// The last mark gone: the list unmounts, so the heading takes focus. A removal with marks left is the list's own.
	useEffect(() => {
		if (removed.current !== null && marks.length === 0) {
			removed.current = null
			headingRef.current?.focus()
		}
	}, [marks])

	return (
		<section
			aria-labelledby={`${id}-title`}
			className="flex h-full min-h-0 flex-col gap-2 p-3"
		>
			<h2
				ref={headingRef}
				id={`${id}-title`}
				tabIndex={-1}
				className="text-sm font-semibold outline-none"
			>
				{t("previewPdfRedactMarked", { count: marks.length })}
			</h2>
			{marks.length === 0 ? (
				<p className="text-sm text-muted-foreground">{t("previewPdfRedactMarkedEmpty")}</p>
			) : (
				<MarkRows
					marks={marks}
					onSelect={onSelect}
					onRemove={onRemove}
					disabled={disabled}
					removed={removed}
				/>
			)}
			<Button
				disabled={marks.length === 0 || disabled === true}
				onClick={onApply}
			>
				{t("previewPdfRedactApply")}
			</Button>
		</section>
	)
}

// A row's two lines (20px and 16px) in its py-1.
const MARK_ROW_HEIGHT = 44
const OVERSCAN = 8

// Applying a search's findings marks each of them, thousands in a long document: the list is a window over fixed-height
// rows. Its own component, as useVirtualizer opts its host out of the React Compiler; a scroll step re-renders only this.
function MarkRows({
	marks,
	onSelect,
	onRemove,
	disabled,
	removed
}: {
	marks: readonly RedactionMark[]
	onSelect: ((mark: RedactionMark) => void) | undefined
	onRemove: (mark: RedactionMark) => void
	disabled: boolean | undefined
	removed: RefObject<RemovedMark>
}) {
	"use no memo"

	const { t } = useTranslation("preview")
	const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
	const virtualizer = useVirtualizer({
		count: marks.length,
		getScrollElement: () => scrollElement,
		observeElementOffset: observeElementOffsetFromAttach,
		estimateSize: () => MARK_ROW_HEIGHT,
		overscan: OVERSCAN,
		getItemKey: index => marks[index]?.id ?? index
	})

	// The ✕ of the mark now at `index`, once the virtualizer has its row mounted.
	function removeButton(index: number): HTMLElement | null {
		return scrollElement?.querySelector<HTMLElement>(`li[data-index="${String(index)}"] [data-mark-remove]`) ?? null
	}

	// A row scrolled in from outside the window mounts on a later frame; a few are plenty.
	function focusRemoveButton(index: number, framesLeft: number): void {
		const button = removeButton(index)

		if (button !== null) {
			button.focus()
		} else if (framesLeft > 0) {
			requestAnimationFrame(() => {
				focusRemoveButton(index, framesLeft - 1)
			})
		}
	}

	useEffect(() => {
		const gone = removed.current

		if (gone === null || marks.length === 0 || marks.some(mark => mark.id === gone.id)) {
			return
		}

		const index = Math.min(gone.index, marks.length - 1)

		removed.current = null

		if (removeButton(index) === null) {
			virtualizer.scrollToIndex(index)
		}

		focusRemoveButton(index, 3)
	})

	return (
		<div
			ref={setScrollElement}
			className="min-h-0 flex-1 scrollbar-gutter-stable overflow-y-auto"
		>
			<ul
				className="relative w-full"
				style={{ height: virtualizer.getTotalSize() }}
			>
				{virtualizer.getVirtualItems().map(row => {
					const mark = marks[row.index]

					if (mark === undefined) {
						return null
					}

					const index = row.index
					const label = markLabel(mark)
					const name = t(label.key, label.params)
					const removeLabel = t("previewPdfRedactRemoveMark", { index: index + 1, mark: name, page: mark.page + 1 })

					return (
						<li
							key={row.key}
							data-index={index}
							aria-posinset={index + 1}
							aria-setsize={marks.length}
							className="absolute top-0 left-0 flex w-full items-center gap-2 rounded-xl py-1 pr-1 pl-2 hover:bg-muted"
							style={{ height: MARK_ROW_HEIGHT, transform: `translateY(${String(row.start)}px)` }}
						>
							<button
								type="button"
								className="flex min-w-0 flex-1 flex-col items-start text-left text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
								disabled={onSelect === undefined}
								onClick={() => {
									onSelect?.(mark)
								}}
							>
								<span className="max-w-full truncate">{name}</span>
								<span className="text-xs text-muted-foreground">{t("previewPdfPageNumber", { page: mark.page + 1 })}</span>
							</button>
							<Tooltip>
								<TooltipTrigger
									render={
										<Button
											variant="ghost"
											size="icon-sm"
											data-mark-remove=""
											aria-label={removeLabel}
											disabled={disabled === true}
											onClick={() => {
												removed.current = { id: mark.id, index }
												onRemove(mark)
											}}
										>
											<XIcon aria-hidden />
										</Button>
									}
								/>
								<TooltipContent>{removeLabel}</TooltipContent>
							</Tooltip>
						</li>
					)
				})}
			</ul>
		</div>
	)
}

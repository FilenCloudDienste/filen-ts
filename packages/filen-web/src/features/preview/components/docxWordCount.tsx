import { useEffect, useId, useState, useSyncExternalStore } from "react"
import { useTranslation } from "react-i18next"
import { countRange, docxRangeLayout, docxWordCount, type PagedEditor } from "@filen/office/core/docx/paged"
import { WORD_COUNT_ROWS, type DocxWordCountStats, type DocxWordCountStore } from "@/features/preview/components/docxWordCount.logic"
import { keepFocus } from "@/features/preview/components/docxEditor.logic"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { log } from "@/lib/log"

// The status bar's word count, as Word's: "N words", "x of N words" with a selection; it opens the Word Count
// dialog (Review ▸ Word Count too): the document's statistics, or the selection's, and whether text boxes,
// footnotes and endnotes count.

export function DocxWordCountIndicator({ store, onOpen }: { store: DocxWordCountStore; onOpen: () => void }) {
	const { t } = useTranslation("preview")
	const { words, selected } = useSyncExternalStore(store.subscribe, store.get)

	if (words === undefined) {
		return null
	}

	const text =
		selected === undefined
			? t("previewDocxWordCountStatus", { count: words })
			: t("previewDocxWordCountSelected", { selected, count: words })

	return (
		<Button
			variant="ghost"
			size="xs"
			aria-label={t("previewDocxWordCountAction", { status: text })}
			className="shrink-0 px-1.5 text-muted-foreground tabular-nums"
			onMouseDown={keepFocus}
			onClick={onOpen}
		>
			{text}
		</Button>
	)
}

export interface DocxWordCountDialogProps {
	editor: PagedEditor | undefined
	store: DocxWordCountStore | undefined
	open: boolean
	onOpenChange: (open: boolean) => void
}

// The selection's statistics (no pages or lines while either end is not laid out), or the document's (with text
// boxes and notes when `notes`).
async function statistics(editor: PagedEditor, notes: boolean): Promise<DocxWordCountStats> {
	const body = editor.body.session
	const { from, to, empty } = body.state.selection

	if (!empty && editor.activeStory === body.story.story.index) {
		const text = countRange(body, from, to, editor.edits.view)
		const layout = docxRangeLayout(editor, from, to)

		return { ...text, pages: layout?.pages ?? 0, lines: layout?.lines ?? 0 }
	}

	return docxWordCount(editor, { notesAndTextBoxes: notes })
}

export function DocxWordCountDialog({ editor, store, open, onOpenChange }: DocxWordCountDialogProps) {
	const { t, i18n } = useTranslation("preview")
	const checkboxId = useId()
	// Word's default: they count.
	const [notes, setNotes] = useState(true)
	const [stats, setStats] = useState<DocxWordCountStats | null>(null)
	const number = new Intl.NumberFormat(i18n.language)
	const changeOpen = (next: boolean): void => {
		onOpenChange(next)

		if (!next) {
			setStats(null)
		}
	}

	// Counted as it opens, and again while open whenever the status bar's count changes (edits paused).
	useEffect(() => {
		if (!open || editor === undefined) {
			return
		}

		let live = true
		const read = (): void => {
			statistics(editor, notes).then(
				next => {
					if (live) {
						setStats(next)
					}
				},
				(error: unknown) => {
					log.warn("docx", "word count failed", { error })
				}
			)
		}

		read()

		const stop = store?.subscribe(read)

		return () => {
			live = false
			stop?.()
		}
	}, [open, editor, store, notes])

	return (
		<Dialog
			open={open}
			onOpenChange={changeOpen}
		>
			<DialogContent className="sm:max-w-sm">
				<DialogHeader>
					<DialogTitle>{t("previewDocxWordCountTitle")}</DialogTitle>
				</DialogHeader>
				<div className="flex flex-col gap-2">
					<p className="text-xs font-medium text-muted-foreground">{t("previewDocxWordCountStatistics")}</p>
					<dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-1.5">
						{WORD_COUNT_ROWS.map(row => (
							<div
								key={row.key}
								className="contents"
							>
								<dt>{t(row.label)}</dt>
								<dd className="text-right tabular-nums">{stats === null ? "–" : number.format(stats[row.key])}</dd>
							</div>
						))}
					</dl>
					<div className="mt-2 flex items-center gap-2">
						<input
							id={checkboxId}
							type="checkbox"
							className="size-4 accent-primary"
							checked={notes}
							onChange={event => {
								setNotes(event.target.checked)
							}}
						/>
						<Label htmlFor={checkboxId}>{t("previewDocxWordCountIncludeNotes")}</Label>
					</div>
				</div>
				<DialogFooter>
					<Button
						variant="outline"
						onClick={() => {
							changeOpen(false)
						}}
					>
						{t("previewDocxWordCountClose")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}

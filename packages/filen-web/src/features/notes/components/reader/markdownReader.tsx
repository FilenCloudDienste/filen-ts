import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react"
import { useTranslation } from "react-i18next"
import { CodeMirrorSource } from "@/features/preview/components/codeMirrorSource"
import { MarkdownRenderer } from "@/features/preview/components/markdownRenderer"
import { useMdSplitRatioQuery } from "@/features/notes/queries/preferences"
import { setMdSplitRatio, clampMdSplitRatio, DEFAULT_MD_SPLIT_RATIO } from "@/features/notes/lib/preferences"
import type { Note } from "@filen/sdk-rs"

// md note render — a resizable horizontal split (D4 / synthesis §3.4): source on the left (read-only
// CodeMirror in markdown mode), the SAME rendered-markdown surface file preview's own markdownViewer.tsx
// uses on the right. Ratio persisted per the preferences convention (features/notes/lib/preferences.ts),
// mirroring notesViewMode's own plain-fn-then-refetch shape.
export function MarkdownReader({ note, content }: { note: Note; content: string }) {
	const { t } = useTranslation("notes")
	const ratioQuery = useMdSplitRatioQuery()
	const persistedRatio = ratioQuery.data ?? DEFAULT_MD_SPLIT_RATIO
	// Local drag override — the persisted query value only ever refreshes at pointerup, so a live drag
	// never round-trips through the leader/OPFS write on every pointermove.
	const [dragRatio, setDragRatio] = useState<number | null>(null)
	const ratio = dragRatio ?? persistedRatio
	const containerRef = useRef<HTMLDivElement | null>(null)
	const draggingRef = useRef(false)

	function ratioFromPointer(clientX: number): number | null {
		const rect = containerRef.current?.getBoundingClientRect()

		if (rect === undefined || rect.width === 0) {
			return null
		}

		return clampMdSplitRatio((clientX - rect.left) / rect.width)
	}

	function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
		event.preventDefault()
		draggingRef.current = true
		event.currentTarget.setPointerCapture(event.pointerId)
	}

	function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
		if (!draggingRef.current) {
			return
		}

		const next = ratioFromPointer(event.clientX)

		if (next !== null) {
			setDragRatio(next)
		}
	}

	function handlePointerUp(event: ReactPointerEvent<HTMLDivElement>): void {
		if (!draggingRef.current) {
			return
		}

		draggingRef.current = false
		event.currentTarget.releasePointerCapture(event.pointerId)

		const finalRatio = dragRatio

		setDragRatio(null)

		if (finalRatio !== null) {
			void setMdSplitRatio(finalRatio).then(() => ratioQuery.refetch())
		}
	}

	return (
		<div
			ref={containerRef}
			className="flex min-h-0 flex-1"
		>
			<div
				className="min-h-0 min-w-0 overflow-hidden"
				style={{ width: `${String(ratio * 100)}%` }}
			>
				<CodeMirrorSource
					text={content}
					tag="markdown"
					alt={note.title ?? ""}
					editable={false}
				/>
			</div>
			<div
				role="separator"
				aria-orientation="vertical"
				aria-label={t("noteMdSplitResize")}
				tabIndex={0}
				onPointerDown={handlePointerDown}
				onPointerMove={handlePointerMove}
				onPointerUp={handlePointerUp}
				className="w-1 shrink-0 cursor-col-resize bg-border/50 transition-colors outline-none hover:bg-border focus-visible:bg-ring/50"
			/>
			<div
				className="min-h-0 min-w-0 flex-1 overflow-hidden"
				style={{ width: `${String((1 - ratio) * 100)}%` }}
			>
				<MarkdownRenderer
					text={content}
					alt={note.title ?? ""}
				/>
			</div>
		</div>
	)
}

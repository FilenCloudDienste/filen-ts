import { useRef, useState, type ReactNode, type PointerEvent as ReactPointerEvent } from "react"
import { useTranslation } from "react-i18next"
import { useMdSplitRatioQuery } from "@/features/notes/queries/preferences"
import { setMdSplitRatio, clampMdSplitRatio, DEFAULT_MD_SPLIT_RATIO } from "@/features/notes/lib/preferences"

// The resizable horizontal split shared by the md reader (read-only left) and the md editor
// (editable left) — extracted so the ratio-persistence + drag logic lives in exactly one place and the
// editor is literally "the reader's split with an editable left pane" (spec e2-editor-text §3). `left`
// and `right` are rendered as-is; this owns only the geometry.
export function MarkdownSplitPane({ left, right }: { left: ReactNode; right: ReactNode }) {
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
				{left}
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
				{right}
			</div>
		</div>
	)
}

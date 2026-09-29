import { useRef, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { useMdSplitRatioQuery } from "@/features/notes/queries/preferences"
import { useSeparatorValue } from "@/lib/useSeparatorValue"
import {
	setMdSplitRatio,
	clampMdSplitRatio,
	ratioFromKey,
	DEFAULT_MD_SPLIT_RATIO,
	MD_SPLIT_RATIO_MIN,
	MD_SPLIT_RATIO_MAX
} from "@/features/notes/lib/preferences"

// The resizable horizontal split shared by the md reader (read-only left) and the md editor
// (editable left) — extracted so the ratio-persistence + drag logic lives in exactly one place and the
// editor is literally "the reader's split with an editable left pane". `left`
// and `right` are rendered as-is; this owns only the geometry.
// `rightHidden` gives the left pane the whole width. The right pane and the separator leave the tree,
// but the left one keeps its place in it, so a live editor there is not remounted (and re-seeded).
export function MarkdownSplitPane({
	left,
	right,
	rightHidden: rightHiddenProp
}: {
	left: ReactNode
	right: ReactNode
	rightHidden?: boolean
}) {
	// Not a destructuring default, which the React Compiler cannot lower.
	const rightHidden = rightHiddenProp ?? false
	const { t } = useTranslation("notes")
	const ratioQuery = useMdSplitRatioQuery()
	const containerRef = useRef<HTMLDivElement | null>(null)

	function ratioFromPointer(_startRatio: number, _startClientX: number, clientX: number): number | null {
		const rect = containerRef.current?.getBoundingClientRect()

		if (rect === undefined || rect.width === 0) {
			return null
		}

		return clampMdSplitRatio((clientX - rect.left) / rect.width)
	}

	const separator = useSeparatorValue({
		persisted: ratioQuery.data ?? DEFAULT_MD_SPLIT_RATIO,
		fromPointer: ratioFromPointer,
		fromKey: ratioFromKey,
		commit: setMdSplitRatio,
		refetch: () => ratioQuery.refetch()
	})
	const ratio = separator.value

	return (
		<div
			ref={containerRef}
			className="flex min-h-0 flex-1"
		>
			<div
				className="min-h-0 min-w-0 overflow-hidden"
				style={{ width: rightHidden ? "100%" : `${String(ratio * 100)}%` }}
			>
				{left}
			</div>
			{rightHidden ? null : (
				<>
					<div
						role="separator"
						aria-orientation="vertical"
						aria-label={t("noteMdSplitResize")}
						// A percentage, not the raw 0–1 ratio: aria-valuenow shares its unit with min/max, and
						// "0.5" between "0.2" and "0.8" announces as a fraction nobody can act on.
						aria-valuenow={Math.round(ratio * 100)}
						aria-valuemin={Math.round(MD_SPLIT_RATIO_MIN * 100)}
						aria-valuemax={Math.round(MD_SPLIT_RATIO_MAX * 100)}
						tabIndex={0}
						onPointerDown={separator.onPointerDown}
						onPointerMove={separator.onPointerMove}
						onPointerUp={separator.onPointerUp}
						onPointerCancel={separator.onPointerCancel}
						onKeyDown={separator.onKeyDown}
						onKeyUp={separator.onKeyUp}
						onBlur={separator.onBlur}
						// touch-none keeps the browser from reclaiming a touch drag as a scroll in the first place.
						className="w-1 shrink-0 cursor-col-resize touch-none bg-border/50 transition-colors outline-none hover:bg-border focus-visible:bg-ring/50"
					/>
					<div
						className="min-h-0 min-w-0 flex-1 overflow-hidden"
						style={{ width: `${String((1 - ratio) * 100)}%` }}
					>
						{right}
					</div>
				</>
			)}
		</div>
	)
}

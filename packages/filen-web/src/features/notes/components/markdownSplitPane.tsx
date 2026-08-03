import { useRef, useState, type ReactNode, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react"
import { useTranslation } from "react-i18next"
import { useMdSplitRatioQuery } from "@/features/notes/queries/preferences"
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
export function MarkdownSplitPane({ left, right }: { left: ReactNode; right: ReactNode }) {
	const { t } = useTranslation("notes")
	const ratioQuery = useMdSplitRatioQuery()
	const persistedRatio = ratioQuery.data ?? DEFAULT_MD_SPLIT_RATIO
	// Local override backing both the drag and the keyboard adjustment — the persisted query value only
	// ever refreshes after a commit, so neither round-trips through the leader/OPFS write per event.
	const [pendingRatio, setPendingRatio] = useState<number | null>(null)
	const ratio = pendingRatio ?? persistedRatio
	const containerRef = useRef<HTMLDivElement | null>(null)
	const draggingRef = useRef(false)
	// "There is an uncommitted adjustment". pendingRatio cannot serve as this test: it is never cleared,
	// so it stays non-null forever after the first adjustment and every later blur would rewrite it.
	const pendingCommitRef = useRef(false)

	// Deliberately does NOT clear pendingRatio. useMdSplitRatioQuery is a plain useQuery with no
	// optimistic write, so dropping the local override here would snap the panes back to the stale
	// persisted value until the refetch lands, and the next arrow key would compute its step off that
	// stale base. The refetch converges the two onto the same number.
	function commitRatio(): void {
		if (!pendingCommitRef.current || pendingRatio === null) {
			return
		}

		pendingCommitRef.current = false

		void setMdSplitRatio(pendingRatio).then(() => ratioQuery.refetch())
	}

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
			setPendingRatio(next)
			pendingCommitRef.current = true
		}
	}

	function handlePointerUp(event: ReactPointerEvent<HTMLDivElement>): void {
		if (!draggingRef.current) {
			return
		}

		draggingRef.current = false
		event.currentTarget.releasePointerCapture(event.pointerId)

		commitRatio()
	}

	function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
		const next = ratioFromKey(event.key, ratio)

		if (next === null) {
			return
		}

		// Arrows/Home/End would otherwise scroll the pane behind the focused separator.
		event.preventDefault()
		setPendingRatio(next)
		pendingCommitRef.current = true
	}

	// Commit on release, not on keydown: OS autorepeat fires keydown ~30x/s and each commit is an OPFS
	// write plus a refetch, so a held key collapses into one write exactly like the pointer path. Also
	// wired to blur, so focus leaving mid-press never loses an adjustment.
	function handleRelease(): void {
		if (draggingRef.current) {
			return
		}

		commitRatio()
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
				// A percentage, not the raw 0–1 ratio: aria-valuenow shares its unit with min/max, and
				// "0.5" between "0.2" and "0.8" announces as a fraction nobody can act on.
				aria-valuenow={Math.round(ratio * 100)}
				aria-valuemin={Math.round(MD_SPLIT_RATIO_MIN * 100)}
				aria-valuemax={Math.round(MD_SPLIT_RATIO_MAX * 100)}
				tabIndex={0}
				onPointerDown={handlePointerDown}
				onPointerMove={handlePointerMove}
				onPointerUp={handlePointerUp}
				onKeyDown={handleKeyDown}
				onKeyUp={handleRelease}
				onBlur={handleRelease}
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

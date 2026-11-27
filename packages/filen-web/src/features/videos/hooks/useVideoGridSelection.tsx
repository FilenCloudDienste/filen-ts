import { useRef, useState, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { log } from "@/lib/log"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { OUTSIDE_OVERLAYS, useAction } from "@/lib/keymap/useAction"
import type { ClickModifiers } from "@/features/drive/lib/listbox"
import { useLatestRef } from "@/lib/useLatestRef"
import { useClickAwayDeselect } from "@/features/drive/hooks/useClickAwayDeselect"
import { useWindowBarSlot } from "@/features/shell/lib/windowBarSlot"
import { videoLibrary } from "@/features/videos/lib/index"
import { editLibraryConfig } from "@/features/videos/queries/library"
import { hideManyEdit, type CorrectionKind } from "@/features/videos/lib/corrections.logic"
import { setAsSources, setKindEdit, type SetAsSource } from "@/features/videos/lib/setAs.logic"
import {
	NO_SELECTION,
	cardClickIntent,
	rangeBounds,
	selectAll,
	toggleSelection,
	withRange,
	type GridSelection
} from "@/features/videos/lib/gridSelection.logic"
import { VideosBulkBar } from "@/features/videos/components/videosBulkBar"
import { SetAsShowDialog } from "@/features/videos/components/setAsShowDialog"
import type { GridQuery } from "@/workers/videoIndex/catalog.logic"
import type { VideoCorrectionTarget } from "@/workers/videoIndex/view.logic"

// A library grid's multi-select: Ctrl/Cmd-click toggles, Shift-click selects a range, Mod+A every title the grid
// lists, Escape (or a click on empty space) clears; while anything is selected a plain click toggles. The selection
// holds title ids; ranges and select-all read them from the grid's order in the worker, and Set as and Hide read the
// titles' correction keys from it once, on use.
export function useVideoGridSelection({ gridQuery, total }: { gridQuery: GridQuery; total: number }): {
	selection: GridSelection
	clear: () => void
	toggle: (id: string, index: number) => void
	// True when the click was a selection gesture (the card's link must not open).
	cardClick: (id: string, index: number, modifiers: ClickModifiers) => boolean
	overlay: ReactNode
} {
	const { t } = useTranslation("videos")
	const [selection, setSelection] = useState<GridSelection>(NO_SELECTION)
	const [showing, setShowing] = useState<SetAsSource[] | null>(null)
	const [busy, setBusy] = useState(false)
	// Bumped by every change, so a range or select-all answered after another change is dropped.
	const generation = useRef(0)
	const windowBarSlot = useWindowBarSlot()
	const selecting = selection.ids.size > 0
	// Read by the cards' click handlers, which stay the same across selection changes so only the cards whose own
	// state changed render again.
	const latest = useLatestRef({ selection, gridQuery })

	function clear(): void {
		generation.current++
		setSelection(NO_SELECTION)
	}

	function selectFromGrid(start: number, end: number, apply: (ids: string[]) => GridSelection): void {
		const at = ++generation.current

		videoLibrary.gridIds(latest.current.gridQuery, start, end).then(
			ids => {
				if (at === generation.current) {
					setSelection(apply(ids))
				}
			},
			(e: unknown) => {
				log.warn("videos.grid", "reading the grid's titles for a selection failed", e)
			}
		)
	}

	function toggle(id: string, index: number): void {
		generation.current++
		setSelection(previous => toggleSelection(previous, id, index))
	}

	function cardClick(id: string, index: number, modifiers: ClickModifiers): boolean {
		const current = latest.current.selection
		const intent = cardClickIntent(modifiers, current.ids.size > 0)

		if (intent === "toggle") {
			toggle(id, index)
		} else if (intent === "range") {
			const { start, end } = rangeBounds(current, index)

			selectFromGrid(start, end, ids => withRange(current, ids, index))
		}

		return intent !== null
	}

	useClickAwayDeselect(selecting, clear)

	useAction(
		"videos.selectAll",
		keyboardEvent => {
			keyboardEvent.preventDefault()

			if (total > 0) {
				selectFromGrid(0, total, selectAll)
			}
		},
		OUTSIDE_OVERLAYS
	)

	useAction("videos.clearSelection", clear, { ...OUTSIDE_OVERLAYS, enabled: selecting })

	function report(e: unknown): void {
		log.warn("videos.setAs", "changing the selected titles failed", e)
		toast.error(errorLabel(e))
	}

	// Promise handlers rather than try/finally, which the React Compiler can't compile yet.
	function onSelected(act: (targets: VideoCorrectionTarget[]) => Promise<unknown> | undefined): void {
		setBusy(true)
		videoLibrary
			.correctionTargets([...selection.ids])
			.then(act)
			.then(
				() => {
					setBusy(false)
				},
				(e: unknown) => {
					setBusy(false)
					report(e)
				}
			)
	}

	function setAs(kind: CorrectionKind): void {
		onSelected(targets => {
			const { sources, skipped } = setAsSources(targets)

			if (skipped > 0) {
				toast.info(t("setAsSeriesSkipped", { count: skipped }))
			}

			if (sources.length === 0) {
				return undefined
			}

			if (kind === "episode") {
				setShowing(sources)

				return undefined
			}

			return editLibraryConfig(
				setKindEdit(
					sources.map(source => source.subject),
					kind
				)
			).then(clear)
		})
	}

	function hide(): void {
		onSelected(targets =>
			targets.length === 0
				? undefined
				: editLibraryConfig(
						hideManyEdit(
							targets.map(target => target.overrideKey),
							true
						)
					).then(clear)
		)
	}

	const overlay = (
		<>
			{selecting && windowBarSlot !== null
				? createPortal(
						<div className="max-w-full app-region-no-drag">
							<VideosBulkBar
								count={selection.ids.size}
								busy={busy}
								onSetAs={setAs}
								onHide={hide}
								onClear={clear}
							/>
						</div>,
						windowBarSlot
					)
				: null}
			{showing === null ? null : (
				<SetAsShowDialog
					sources={showing}
					onClose={() => {
						setShowing(null)
					}}
					onSaved={clear}
				/>
			)}
		</>
	)

	return { selection, clear, toggle, cardClick, overlay }
}

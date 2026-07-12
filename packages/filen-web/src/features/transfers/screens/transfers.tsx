import { useState } from "react"
import { useTranslation } from "react-i18next"
import { useShallow } from "zustand/shallow"
import { ArrowDownUpIcon, PauseIcon, PlayIcon, Trash2Icon, XIcon } from "lucide-react"
import { formatBytes } from "@filen/utils"
import { isActiveTransfer, useTransfersAggregate, useTransfersStore } from "@/features/transfers/store/useTransfersStore"
import {
	buildTransfersDisplayList,
	cancellableTransferIds,
	confirmCancelAllTransfers,
	hasFinishedTransfers,
	pausableTransferIds,
	resumableTransferIds,
	shouldShowTransfersAggregate
} from "@/features/transfers/screens/transfers.logic"
import { cancelTransfer, pauseTransfer, resumeTransfer } from "@/features/transfers/lib/control"
import { TransferRow } from "@/features/transfers/components/transferRow"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from "@/components/ui/empty"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"

// Full-page transfers surface (header+actionbar+content shell mirrors ContactsList) — the rail entry
// (iconRail.tsx's TransfersEntry) navigates straight here now (P3 dropped its popover). TransferRow is
// the exact same component the rail entry's own tooltip/badge summary is built alongside, so a row
// looks and behaves identically wherever it appears; only the surrounding chrome (sections, bulk
// header actions) differs.
export function TransfersScreen() {
	const { t } = useTranslation(["transfers", "common"])
	const transfers = useTransfersStore(useShallow(state => state.transfers))
	const { active, finished } = buildTransfersDisplayList(transfers)
	const { activeCount, percent, speed } = useTransfersAggregate()
	const cancellable = cancellableTransferIds(transfers)
	const pausable = pausableTransferIds(transfers)
	const resumable = resumableTransferIds(transfers)
	const clearable = hasFinishedTransfers(transfers)
	const showAggregate = shouldShowTransfersAggregate(activeCount)
	// M5 — Cancel all fires immediately with no confirmation; gate it behind the shared AlertDialog
	// wrapper (ConfirmDialog), same primitive AccountMenu's sign-out already uses. cancelTransfer is
	// synchronous/fire-and-forget (control.ts), so there is nothing to await — `pending` stays a
	// constant false, unlike a real async confirm flow.
	const [cancelAllConfirmOpen, setCancelAllConfirmOpen] = useState(false)
	// M5 (single row) — a stable id, not a per-row boolean: this screen owns the confirm (rather than
	// each TransferRow owning its own), because buildTransfersDisplayList renders active/finished
	// transfers in two separate sections — a row settling mid-confirm unmounts in one section and
	// remounts in the other, which would silently drop any dialog-open state the ROW itself held. Kept
	// as an id (not the Transfer object) so it re-resolves the CURRENT transfer every render — see
	// cancelTarget below.
	const [cancelTargetId, setCancelTargetId] = useState<string | null>(null)
	const cancelTarget = transfers.find(candidate => candidate.id === cancelTargetId) ?? null
	// Only an id whose transfer is STILL ACTIVE keeps the dialog open — a transfer that settled
	// naturally (or was removed) while the confirm was pending has nothing left to cancel, so the
	// dialog closes itself gracefully on the next render instead of confirming a no-op or holding a
	// stale target.
	const cancelConfirmOpen = cancelTarget !== null && isActiveTransfer(cancelTarget.status)

	function handlePauseAll(): void {
		for (const id of pausable) {
			pauseTransfer(id)
		}
	}

	function handleResumeAll(): void {
		for (const id of resumable) {
			resumeTransfer(id)
		}
	}

	return (
		<>
			<header className="flex h-14 shrink-0 items-center justify-between gap-3 px-4">
				<h1 className="text-sm font-medium">{t("common:moduleTransfers")}</h1>
				{showAggregate ? (
					// M1 — the aggregate {percent, speed} computeTransfersAggregate already produces, finally
					// rendered: mirrors mobile's floating pill's own live rolling-window speed + progress bar,
					// condensed into this header row.
					<div className="flex min-w-0 flex-1 items-center justify-end gap-2">
						<span className="shrink-0 text-xs text-muted-foreground tabular-nums">
							{t("transfersAggregateSpeed", { speed: formatBytes(speed) })}
						</span>
						<Progress
							value={percent}
							aria-label={t("transfersAggregateProgressLabel")}
							className="h-1.5 w-32 shrink-0 gap-0"
						/>
					</div>
				) : null}
			</header>
			<div className="flex h-12 shrink-0 items-center justify-end gap-2 px-4">
				<Button
					variant="outline"
					size="sm"
					disabled={pausable.length === 0}
					onClick={handlePauseAll}
				>
					<PauseIcon aria-hidden="true" />
					{t("transfersScreenPauseAll")}
				</Button>
				<Button
					variant="outline"
					size="sm"
					disabled={resumable.length === 0}
					onClick={handleResumeAll}
				>
					<PlayIcon aria-hidden="true" />
					{t("transfersScreenResumeAll")}
				</Button>
				<Button
					variant="outline"
					size="sm"
					disabled={cancellable.length === 0}
					onClick={() => {
						setCancelAllConfirmOpen(true)
					}}
				>
					<XIcon aria-hidden="true" />
					{t("transfersScreenCancelAll")}
				</Button>
				<Button
					variant="outline"
					size="sm"
					disabled={!clearable}
					onClick={() => {
						// .getState() idiom — the exact store call, outside render (mirrors directoryListing.tsx's
						// own convention for every store mutation triggered from an event handler).
						useTransfersStore.getState().clearFinished()
					}}
				>
					<Trash2Icon aria-hidden="true" />
					{t("transfersClearFinished")}
				</Button>
			</div>
			<div className="flex min-h-0 flex-1 flex-col overflow-hidden">
				{active.length === 0 && finished.length === 0 ? (
					<div className="flex flex-1 overflow-y-auto">
						<Empty>
							<EmptyHeader>
								<EmptyMedia variant="icon">
									<ArrowDownUpIcon />
								</EmptyMedia>
								<EmptyTitle>{t("transfersEmptyTitle")}</EmptyTitle>
								<EmptyDescription>{t("transfersScreenEmptyBody")}</EmptyDescription>
							</EmptyHeader>
						</Empty>
					</div>
				) : (
					<div className="flex-1 overflow-y-auto p-2">
						{active.length > 0 ? (
							<section>
								<h2 className="px-2 pt-3 pb-1 text-xs font-medium text-muted-foreground">
									{t("transfersScreenSectionActive")}
								</h2>
								<div className="flex flex-col gap-1">
									{active.map(transfer => (
										<TransferRow
											key={transfer.id}
											transfer={transfer}
											onRequestCancel={() => {
												setCancelTargetId(transfer.id)
											}}
										/>
									))}
								</div>
							</section>
						) : null}
						{finished.length > 0 ? (
							<section>
								<h2 className="px-2 pt-3 pb-1 text-xs font-medium text-muted-foreground">
									{t("transfersScreenSectionFinished")}
								</h2>
								<div className="flex flex-col gap-1">
									{finished.map(transfer => (
										<TransferRow
											key={transfer.id}
											transfer={transfer}
											// A finished row never renders the Cancel button (only active rows do — see
											// TransferRow's own finished/active branch), so this is never actually
											// invoked here; still required for the prop's type.
											onRequestCancel={() => {
												setCancelTargetId(transfer.id)
											}}
										/>
									))}
								</div>
							</section>
						) : null}
					</div>
				)}
			</div>
			<ConfirmDialog
				open={cancelAllConfirmOpen}
				pending={false}
				title={t("transfersScreenCancelAllConfirmTitle")}
				body={t("transfersScreenCancelAllConfirmBody", { count: cancellable.length })}
				confirmLabel={t("transfersScreenCancelAll")}
				cancelLabel={t("transfersCancelDialogDismiss")}
				destructive
				onOpenChange={setCancelAllConfirmOpen}
				onConfirm={() => {
					confirmCancelAllTransfers(transfers, cancelTransfer)
					setCancelAllConfirmOpen(false)
				}}
			/>
			{/* M5 (single row) — one shared dialog for whichever row's Cancel button was last clicked
			(see cancelTargetId's own comment above for why this lives here, not inside TransferRow). Body
			text reads `cancelTarget?.name` defensively (exactOptionalPropertyTypes-safe fallback to "") —
			it's never actually shown with an empty name in practice, since `open` is only ever true while
			`cancelTarget` is a real, still-active transfer. */}
			<ConfirmDialog
				open={cancelConfirmOpen}
				pending={false}
				title={t("transfersRowCancelConfirmTitle")}
				body={t("transfersRowCancelConfirmBody", { name: cancelTarget?.name ?? "" })}
				confirmLabel={t("transfersRowCancel")}
				cancelLabel={t("transfersCancelDialogDismiss")}
				destructive
				onOpenChange={open => {
					if (!open) {
						setCancelTargetId(null)
					}
				}}
				onConfirm={() => {
					if (cancelTargetId !== null) {
						cancelTransfer(cancelTargetId)
					}

					setCancelTargetId(null)
				}}
			/>
		</>
	)
}

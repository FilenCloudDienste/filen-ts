import { useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { useShallow } from "zustand/shallow"
import { useNavigate } from "@tanstack/react-router"
import { ArrowDownUpIcon, BrushCleaningIcon, PauseIcon, PlayIcon, XIcon } from "lucide-react"
import { formatBytesFixed } from "@filen/shared"
import {
	isActiveTransfer,
	useSpeedSampleAging,
	useTransfersAggregate,
	useTransfersStore,
	type Transfer
} from "@/features/transfers/store/useTransfersStore"
import { useCopyJobsStore } from "@/features/transfers/store/useCopyJobsStore"
import { pruneSettledCopyJobs } from "@/features/drive/lib/copy"
import {
	buildTransfersDisplayList,
	cancellableTransferIds,
	confirmCancelAllTransfers,
	endedCopyIds,
	hasFinishedTransfers,
	pausableTransferIds,
	resumableTransferIds,
	shouldShowTransfersAggregate
} from "@/features/transfers/screens/transfers.logic"
import { cancelTransfer, pauseTransfer, resumeTransfer } from "@/features/transfers/lib/control"
import { TransferRow } from "@/features/transfers/components/transferRow"
import { percentFormat, runningPercentFraction } from "@/features/transfers/components/transferRow.logic"
import { defaultRevealDeps, runOpenContainingDirectory } from "@/features/drive/lib/reveal"
import type { DriveItem } from "@/features/drive/lib/item"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from "@/components/ui/empty"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"

// Full-page transfers surface, reached from the rail entry (iconRail.tsx's TransfersEntry). One header
// row carries the live summary and the bulk actions; below it, the active transfers, then the finished
// ones.
export function TransfersScreen() {
	const { t, i18n } = useTranslation(["transfers", "common"])
	const navigate = useNavigate()
	const transfers = useTransfersStore(useShallow(state => state.transfers))
	// Changes when a copy's job ends, which takes its row out of the bulk actions.
	const endedCopies = useCopyJobsStore(useShallow(state => endedCopyIds(state.jobs)))
	const { active, finished } = buildTransfersDisplayList(transfers)
	const { activeCount, percent, speed } = useTransfersAggregate()

	useSpeedSampleAging()

	const cancellable = cancellableTransferIds(transfers, endedCopies)
	const pausable = pausableTransferIds(transfers, endedCopies)
	const resumable = resumableTransferIds(transfers, endedCopies)
	const clearable = hasFinishedTransfers(transfers)
	const showAggregate = shouldShowTransfersAggregate(activeCount)
	// Cancel all fires immediately with no confirmation; gate it behind the shared AlertDialog
	// wrapper (ConfirmDialog), same primitive AccountMenu's sign-out already uses. cancelTransfer is
	// synchronous/fire-and-forget (control.ts), so there is nothing to await — `pending` stays a
	// constant false, unlike a real async confirm flow.
	const [cancelAllConfirmOpen, setCancelAllConfirmOpen] = useState(false)
	// Single-row cancel — a stable id, not a per-row boolean: this screen owns the confirm (rather than
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

	// A copy asks what to do with what it already copied, in its own prompt.
	function requestRowCancel(transfer: Transfer): void {
		if (transfer.direction === "copy") {
			useCopyJobsStore.getState().setCancelPromptId(transfer.id)
			return
		}

		setCancelTargetId(transfer.id)
	}

	function handleShowInDirectory(item: DriveItem): void {
		void runOpenContainingDirectory(defaultRevealDeps, item, target => {
			void navigate(target)
		})
	}

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
			{/* One row at every width: below sm the summary goes and the buttons shed their labels, each
			    keeping it as its accessible name. */}
			<header className="flex h-14 shrink-0 items-center gap-3 px-4">
				<h1 className="shrink-0 text-sm font-medium">{t("common:moduleTransfers")}</h1>
				{/* The same order as a row's line, for the same reason: the speed, the one figure that keeps
				    changing length, goes last. */}
				<p className="hidden min-w-0 flex-1 truncate text-xs text-muted-foreground tabular-nums sm:block">
					{showAggregate
						? [
								t("transfersScreenActiveCount", { count: activeCount }),
								percentFormat(i18n.language).format(runningPercentFraction(percent)),
								t("transfersAggregateSpeed", { speed: formatBytesFixed(speed) })
							].join(" · ")
						: null}
				</p>
				<div className="ml-auto flex shrink-0 items-center gap-1">
					<HeaderAction
						label={t("transfersScreenPauseAll")}
						disabled={pausable.length === 0}
						onClick={handlePauseAll}
					>
						<PauseIcon />
					</HeaderAction>
					<HeaderAction
						label={t("transfersScreenResumeAll")}
						disabled={resumable.length === 0}
						onClick={handleResumeAll}
					>
						<PlayIcon />
					</HeaderAction>
					<HeaderAction
						label={t("transfersScreenCancelAll")}
						disabled={cancellable.length === 0}
						onClick={() => {
							setCancelAllConfirmOpen(true)
						}}
					>
						<XIcon />
					</HeaderAction>
					<Button
						variant="outline"
						size="sm"
						className="ml-1"
						aria-label={t("transfersClearFinished")}
						disabled={!clearable}
						onClick={() => {
							// .getState() idiom — the exact store call, outside render (mirrors directoryListing.tsx's
							// own convention for every store mutation triggered from an event handler).
							useTransfersStore.getState().clearFinished()
							pruneSettledCopyJobs()
						}}
					>
						<BrushCleaningIcon aria-hidden="true" />
						<span className="hidden sm:inline">{t("transfersClearFinished")}</span>
					</Button>
				</div>
			</header>
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
					<div className="flex-1 overflow-y-auto px-2 pb-4">
						{active.length > 0 ? (
							<TransfersSection title={t("transfersScreenSectionActive")}>
								{active.map(transfer => (
									<TransferRow
										key={transfer.id}
										transfer={transfer}
										onRequestCancel={() => {
											requestRowCancel(transfer)
										}}
										onShowInDirectory={handleShowInDirectory}
									/>
								))}
							</TransfersSection>
						) : null}
						{finished.length > 0 ? (
							<TransfersSection title={t("transfersScreenSectionFinished")}>
								{finished.map(transfer => (
									<TransferRow
										key={transfer.id}
										transfer={transfer}
										// A finished row never renders the Cancel button (only active rows do — see
										// TransferRow's own finished/active branch), so this is never actually
										// invoked here; still required for the prop's type.
										onRequestCancel={() => {
											requestRowCancel(transfer)
										}}
										onShowInDirectory={handleShowInDirectory}
									/>
								))}
							</TransfersSection>
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
					confirmCancelAllTransfers(transfers, endedCopies, cancelTransfer)
					setCancelAllConfirmOpen(false)
				}}
			/>
			{/* Single-row cancel — one shared dialog for whichever row's Cancel button was last clicked
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

function TransfersSection({ title, children }: { title: string; children: ReactNode }) {
	return (
		<section>
			<h2 className="px-3 pt-4 pb-1 text-xs font-medium text-muted-foreground">{title}</h2>
			<ul className="flex flex-col gap-0.5">{children}</ul>
		</section>
	)
}

function HeaderAction({
	label,
	disabled,
	onClick,
	children
}: {
	label: string
	disabled: boolean
	onClick: () => void
	children: ReactNode
}) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label={label}
						disabled={disabled}
						onClick={onClick}
					>
						{children}
					</Button>
				}
			/>
			<TooltipContent>{label}</TooltipContent>
		</Tooltip>
	)
}

import { useTranslation } from "react-i18next"
import { useShallow } from "zustand/shallow"
import { ArrowDownUpIcon, PauseIcon, PlayIcon, Trash2Icon, XIcon } from "lucide-react"
import { useTransfersStore } from "@/features/transfers/store/useTransfersStore"
import { hasFinishedTransfers } from "@/features/transfers/components/transfersPanel.logic"
import {
	buildTransfersDisplayList,
	cancellableTransferIds,
	pausableTransferIds,
	resumableTransferIds
} from "@/features/transfers/screens/transfers.logic"
import { cancelTransfer, pauseTransfer, resumeTransfer } from "@/features/transfers/lib/control"
import { TransferRow } from "@/features/transfers/components/transferRow"
import { Button } from "@/components/ui/button"
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from "@/components/ui/empty"

// Full-page transfers surface (header+actionbar+content shell mirrors ContactsList) — the rail
// popover (transfers-panel.tsx) stays the quick glance and links here via "See all". TransferRow is
// reused verbatim from the popover (same component, no fork) so a row looks and behaves identically
// in both surfaces; only the surrounding chrome (sections, bulk header actions) differs.
export function TransfersScreen() {
	const { t } = useTranslation(["transfers", "common"])
	const transfers = useTransfersStore(useShallow(state => state.transfers))
	const { active, finished } = buildTransfersDisplayList(transfers)
	const cancellable = cancellableTransferIds(transfers)
	const pausable = pausableTransferIds(transfers)
	const resumable = resumableTransferIds(transfers)
	const clearable = hasFinishedTransfers(transfers)

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

	function handleCancelAll(): void {
		for (const id of cancellable) {
			cancelTransfer(id)
		}
	}

	return (
		<>
			<header className="flex h-14 shrink-0 items-center border-b border-border px-4">
				<h1 className="text-sm font-medium">{t("common:moduleTransfers")}</h1>
			</header>
			<div className="flex h-12 shrink-0 items-center justify-end gap-2 border-b border-border px-4">
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
					onClick={handleCancelAll}
				>
					<XIcon aria-hidden="true" />
					{t("transfersScreenCancelAll")}
				</Button>
				<Button
					variant="outline"
					size="sm"
					disabled={!clearable}
					onClick={() => {
						// Same .getState() idiom transfers-panel.tsx's own Clear finished button uses — the
						// exact store call, just reachable from this screen's persistent toolbar too.
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
										/>
									))}
								</div>
							</section>
						) : null}
					</div>
				)}
			</div>
		</>
	)
}

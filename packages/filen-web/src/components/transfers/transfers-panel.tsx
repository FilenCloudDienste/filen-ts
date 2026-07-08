import { useTranslation } from "react-i18next"
import { useShallow } from "zustand/shallow"
import { ArrowDownUpIcon } from "lucide-react"
import { useTransfersStore } from "@/stores/transfers"
import { sortTransfersByStartedAt, hasFinishedTransfers } from "@/components/transfers/transfers-panel.logic"
import { TransferRow } from "@/components/transfers/transfer-row"
import { Button } from "@/components/ui/button"
import { PopoverHeader, PopoverTitle } from "@/components/ui/popover"
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from "@/components/ui/empty"

// The rail Transfers popover's content (icon-rail.tsx owns the Popover root/trigger/positioning —
// this is purely the surface: header + rows + empty state). Direct children of PopoverContent, not a
// single wrapping div, so its own flex-col/gap/padding (ui/popover.tsx) spaces the header and list
// without this component duplicating that chrome — mirrors PopoverHeader/PopoverTitle's own
// content-only design.
export function TransfersPanel() {
	const { t } = useTranslation("transfers")
	// mirrors directory-listing.tsx's useDriveStore(useShallow(state => state.selectedItems)) — the
	// store's own array reference only changes when a transfer is actually added/updated/removed.
	const transfers = useTransfersStore(useShallow(state => state.transfers))
	const sorted = sortTransfersByStartedAt(transfers)
	const clearable = hasFinishedTransfers(transfers)

	return (
		<>
			<PopoverHeader className="flex-row items-center justify-between gap-2">
				<PopoverTitle>{t("transfersPanelTitle")}</PopoverTitle>
				{clearable ? (
					<Button
						variant="ghost"
						size="sm"
						onClick={() => {
							// Action call outside render — same .getState() idiom directory-listing.tsx/
							// bulk-action-bar.tsx use for every store mutation triggered from an event handler.
							useTransfersStore.getState().clearFinished()
						}}
					>
						{t("transfersClearFinished")}
					</Button>
				) : null}
			</PopoverHeader>
			{sorted.length === 0 ? (
				<Empty className="gap-3 p-6">
					<EmptyHeader className="gap-1">
						<EmptyMedia variant="icon">
							<ArrowDownUpIcon />
						</EmptyMedia>
						<EmptyTitle className="text-sm">{t("transfersEmptyTitle")}</EmptyTitle>
						<EmptyDescription>{t("transfersEmptyBody")}</EmptyDescription>
					</EmptyHeader>
				</Empty>
			) : (
				<div className="flex max-h-80 flex-col gap-1 overflow-y-auto">
					{sorted.map(transfer => (
						<TransferRow
							key={transfer.id}
							transfer={transfer}
						/>
					))}
				</div>
			)}
		</>
	)
}

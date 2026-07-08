import { type MouseEvent } from "react"
import { useTranslation } from "react-i18next"
import { useShallow } from "zustand/shallow"
import { Link } from "@tanstack/react-router"
import { ArrowDownUpIcon } from "lucide-react"
import { useTransfersStore } from "@/stores/transfers"
import { sortTransfersByStartedAt, hasFinishedTransfers } from "@/components/transfers/transfers-panel.logic"
import { TransferRow } from "@/components/transfers/transfer-row"
import { Button, buttonVariants } from "@/components/ui/button"
import { PopoverHeader, PopoverTitle } from "@/components/ui/popover"
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from "@/components/ui/empty"

export interface TransfersPanelProps {
	// icon-rail.tsx's TransfersEntry owns the Popover root; this fires once the "See all" link below
	// actually navigates away, so the caller can close the popover instead of it lingering open over
	// the destination page (a plain uncontrolled Popover has no "close on internal link click"
	// behavior of its own — verified against the installed Base UI: a click landing on a descendant of
	// the Popup is never treated as an outside click).
	onClose: () => void
}

// The rail Transfers popover's content (icon-rail.tsx owns the Popover root/trigger/positioning —
// this is purely the surface: header + rows + empty state + a "See all" footer). Direct children of
// PopoverContent, not a single wrapping div, so its own flex-col/gap/padding (ui/popover.tsx) spaces
// them without this component duplicating that chrome — mirrors PopoverHeader/PopoverTitle's own
// content-only design.
export function TransfersPanel({ onClose }: TransfersPanelProps) {
	const { t } = useTranslation("transfers")
	// mirrors directory-listing.tsx's useDriveStore(useShallow(state => state.selectedItems)) — the
	// store's own array reference only changes when a transfer is actually added/updated/removed.
	const transfers = useTransfersStore(useShallow(state => state.transfers))
	const sorted = sortTransfersByStartedAt(transfers)
	const clearable = hasFinishedTransfers(transfers)

	// Same primary-button/no-modifier gate TanStack Router's own Link uses internally (isCtrlEvent) to
	// decide whether THIS tab is about to navigate: a ctrl/cmd/alt/shift-click opens /transfers in a
	// new tab and leaves this tab's popover untouched, so only a plain left-click closes it here too.
	function handleSeeAllClick(event: MouseEvent<HTMLAnchorElement>): void {
		if (event.button === 0 && !event.metaKey && !event.altKey && !event.ctrlKey && !event.shiftKey) {
			onClose()
		}
	}

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
			<Link
				to="/transfers"
				onClick={handleSeeAllClick}
				className={buttonVariants({ variant: "link", size: "sm", className: "self-end" })}
			>
				{t("transfersPanelSeeAll")}
			</Link>
		</>
	)
}

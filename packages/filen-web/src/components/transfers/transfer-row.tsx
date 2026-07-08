import { useTranslation } from "react-i18next"
import { CircleAlertIcon, CircleCheckIcon, XIcon } from "lucide-react"
import { formatBytes } from "@filen/utils"
import { useTransfersStore, type Transfer } from "@/stores/transfers"
import { transferProgress } from "@/components/transfers/transfer-row.logic"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Spinner } from "@/components/ui/spinner"

export interface TransferRowProps {
	transfer: Transfer
}

// Leading status icon — aria-hidden in the "done"/"error" branches since the row's own trailing text
// (TransferRow below) already spells out "Done"/"Failed" as real accessible text; only "uploading"
// gets a companion sr-only label, because its trailing text is a bare percentage with no other
// accessible mention of "uploading" anywhere in the row. Mirrors DriveRow's StarIcon (aria-hidden +
// a separate sr-only announcement) rather than relying on an aria-label on the icon itself.
function TransferStatusIcon({ status }: { status: Transfer["status"] }) {
	const { t } = useTranslation("transfers")

	if (status === "done") {
		return (
			<CircleCheckIcon
				aria-hidden="true"
				className="size-4 shrink-0 text-muted-foreground"
			/>
		)
	}

	if (status === "error") {
		return (
			<CircleAlertIcon
				aria-hidden="true"
				className="size-4 shrink-0 text-destructive"
			/>
		)
	}

	return (
		<>
			<Spinner
				aria-hidden="true"
				className="size-4 text-muted-foreground"
			/>
			<span className="sr-only">{t("transfersStatusUploading")}</span>
		</>
	)
}

// One row: name + live progress bar, mirroring DriveRow's icon+truncate+trailing idiom (drive/
// drive-row.tsx) scaled down for the panel's narrower surface. Uploading rows carry NO cancel/remove
// control — streaming-upload abort isn't wired up yet (see stores/transfers.ts's header comment), and
// a "Cancel" that silently kept uploading in the background would mislead the user more than having
// no control at all. Only a finished (done/error) row gets the dismiss button, wired straight to the
// store — a finished transfer is already done, so dismissing just clears its row, no confirm needed.
export function TransferRow({ transfer }: TransferRowProps) {
	const { t, i18n } = useTranslation("transfers")
	const progress = transferProgress(transfer)
	const finished = transfer.status !== "uploading"

	// Never renders bytesTransferred for a "done" row (only its final size) — settle()/setProgress()
	// are separate store writes, so a just-finished row's bytesTransferred can still briefly trail
	// size; showing it here would contradict the "Done" label next to it. errorLabel needs a real
	// ErrorDTO, which the type allows to be absent even on an "error" row (exactOptionalPropertyTypes
	// — see stores/transfers.ts's `error?` comment), hence the fallback to the plain status word.
	let secondary: string
	if (transfer.status === "error") {
		secondary = transfer.error !== undefined ? errorLabel(transfer.error) : t("transfersStatusError")
	} else if (transfer.status === "done") {
		secondary = formatBytes(transfer.size)
	} else {
		secondary = `${formatBytes(transfer.bytesTransferred)} / ${formatBytes(transfer.size)}`
	}

	// Uploading shows a live percentage (the one number that actually changes tick to tick); once
	// finished, the word carries more information than a stale/redundant "100%" would. Intl.NumberFormat
	// (not a hand-rolled `${n}%` template) so the symbol/rounding follow the active locale — some
	// locales space or place "%" differently, and percent's default maximumFractionDigits is 0, which
	// is also what rounds the value for display.
	const trailingLabel =
		transfer.status === "uploading"
			? new Intl.NumberFormat(i18n.language, { style: "percent" }).format(progress / 100)
			: t(transfer.status === "done" ? "transfersStatusDone" : "transfersStatusError")

	return (
		<div className="flex flex-col gap-1.5 rounded-xl px-1 py-1.5">
			<div className="flex items-center gap-2">
				<TransferStatusIcon status={transfer.status} />
				<span className="min-w-0 flex-1 truncate text-sm">{transfer.name}</span>
				<span className="shrink-0 text-xs text-muted-foreground tabular-nums">{trailingLabel}</span>
				{finished ? (
					<Button
						variant="ghost"
						size="icon-xs"
						aria-label={t("transfersRowRemove")}
						onClick={() => {
							useTransfersStore.getState().remove(transfer.id)
						}}
					>
						<XIcon />
					</Button>
				) : null}
			</div>
			<Progress
				value={progress}
				aria-label={transfer.name}
			/>
			<p className={cn("truncate text-xs", transfer.status === "error" ? "text-destructive" : "text-muted-foreground")}>
				{secondary}
			</p>
		</div>
	)
}

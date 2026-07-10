import { useTranslation } from "react-i18next"
import { CircleAlertIcon, CircleCheckIcon, DownloadIcon, PauseIcon, PlayIcon, UploadIcon, XIcon } from "lucide-react"
import { formatBytes } from "@filen/utils"
import { isActiveTransfer, useTransfersStore, type Transfer } from "@/features/transfers/store/useTransfersStore"
import { transferProgress, activeStatusLabelKey } from "@/features/transfers/components/transferRow.logic"
import { cancelTransfer, pauseTransfer, resumeTransfer } from "@/features/transfers/lib/control"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Spinner } from "@/components/ui/spinner"

export interface TransferRowProps {
	transfer: Transfer
}

// Leading status icon — aria-hidden in the "done"/"error" branches since the row's own trailing text
// (TransferRow below) already spells out "Done"/"Failed" as real accessible text; only the active
// (uploading/downloading) branch gets a companion sr-only label, resolved direction-aware via
// activeStatusLabelKey, because its trailing text is a bare percentage with no other accessible
// mention of the transfer's direction anywhere in the row. Mirrors DriveRow's StarIcon (aria-hidden +
// a separate sr-only announcement) rather than relying on an aria-label on the icon itself.
function TransferStatusIcon({ status, direction }: { status: Transfer["status"]; direction: Transfer["direction"] }) {
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
			<span className="sr-only">{t(activeStatusLabelKey(direction))}</span>
		</>
	)
}

// Small decorative direction glyph (upload vs download), aria-hidden — purely an at-a-glance visual
// cue; the accessible direction distinction lives in TransferStatusIcon's own sr-only label above.
// Reuses the same icons the rest of the app already associates with each direction (uploadMenu.tsx/
// uploadDropzone.tsx's UploadIcon, bulkActionBar.logic.ts's DownloadIcon) rather than a generic
// arrow pair.
function TransferDirectionIcon({ direction }: { direction: Transfer["direction"] }) {
	const Icon = direction === "upload" ? UploadIcon : DownloadIcon

	return (
		<Icon
			aria-hidden="true"
			className="size-3.5 shrink-0 text-muted-foreground"
		/>
	)
}

// One row: name + live progress bar, mirroring DriveRow's icon+truncate+trailing idiom (drive/
// driveRow.tsx) scaled down for the panel's narrower surface. Active (uploading/downloading) rows get
// a pause/resume toggle plus a Cancel button, wired to features/transfers/lib/control.ts's
// pauseTransfer/resumeTransfer/cancelTransfer — the in-flight runUpload/runDownload catch does the
// actual store settle+remove once a cancelled worker call rejects with "Cancelled"; pause/resume never
// reject, so the toggle flips the store's `paused` flag itself (see pauseTransfer/resumeTransfer). A
// finished row (isActiveTransfer false — done/error/completedWithErrors) gets a dismiss button instead,
// wired straight to the store — a finished transfer is already done, so dismissing just clears its row,
// no confirm needed.
export function TransferRow({ transfer }: TransferRowProps) {
	const { t, i18n } = useTranslation("transfers")
	const progress = transferProgress(transfer)
	const finished = !isActiveTransfer(transfer.status)

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

	// Active (uploading OR downloading) shows a live percentage (the one number that actually changes
	// tick to tick); once finished, the word carries more information than a stale/redundant "100%"
	// would. Intl.NumberFormat (not a hand-rolled `${n}%` template) so the symbol/rounding follow the
	// active locale — some locales space or place "%" differently, and percent's default
	// maximumFractionDigits is 0, which is also what rounds the value for display.
	const trailingLabel = isActiveTransfer(transfer.status)
		? new Intl.NumberFormat(i18n.language, { style: "percent" }).format(progress / 100)
		: t(transfer.status === "done" ? "transfersStatusDone" : "transfersStatusError")

	return (
		<div className="flex flex-col gap-1.5 rounded-xl px-1 py-1.5 hover:bg-accent/50">
			<div className="flex items-center gap-2">
				<TransferStatusIcon
					status={transfer.status}
					direction={transfer.direction}
				/>
				<TransferDirectionIcon direction={transfer.direction} />
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
				) : (
					<>
						<Button
							variant="ghost"
							size="icon-xs"
							aria-label={t(transfer.paused ? "transfersRowResume" : "transfersRowPause")}
							onClick={() => {
								if (transfer.paused) {
									resumeTransfer(transfer.id)
								} else {
									pauseTransfer(transfer.id)
								}
							}}
						>
							{transfer.paused ? <PlayIcon /> : <PauseIcon />}
						</Button>
						<Button
							variant="ghost"
							size="icon-xs"
							aria-label={t("transfersRowCancel")}
							onClick={() => {
								cancelTransfer(transfer.id)
							}}
						>
							<XIcon />
						</Button>
					</>
				)}
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

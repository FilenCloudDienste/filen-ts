import { useTranslation } from "react-i18next"
import {
	CircleAlertIcon,
	CircleCheckIcon,
	DownloadIcon,
	PauseCircleIcon,
	PauseIcon,
	PlayIcon,
	Trash2Icon,
	UploadIcon,
	XIcon
} from "lucide-react"
import { formatBytes } from "@filen/utils"
import { isActiveTransfer, useTransfersStore, type Transfer } from "@/features/transfers/store/useTransfersStore"
import { transferProgress, activeStatusLabelKey, transferIconKey } from "@/features/transfers/components/transferRow.logic"
import { pauseTransfer, resumeTransfer } from "@/features/transfers/lib/control"
import { FileTypeIcon } from "@/features/drive/components/itemIcon"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Spinner } from "@/components/ui/spinner"

export interface TransferRowProps {
	transfer: Transfer
	// Cancel's own confirm dialog is owned by the SCREEN (screens/transfers.tsx), not this row:
	// buildTransfersDisplayList renders active/finished transfers in two SEPARATE sections, so a row
	// moving from active to finished (settling mid-confirm) unmounts this component and remounts a new
	// one in the other section — a dialog-open flag kept in local row state would silently vanish right
	// under the user's cursor the instant that happens. The screen instead tracks a stable id (immune
	// to this component ever remounting) and re-resolves the target transfer by id on every render, so
	// a transfer that settles naturally while its confirm is open closes the dialog gracefully instead
	// of losing it. This callback is only ever wired to the active-row branch below.
	onRequestCancel: () => void
}

// Leading status icon — aria-hidden in the "done"/"error" branches since the row's own trailing text
// (TransferRow below) already spells out "Done"/"Failed" as real accessible text; only the active
// (uploading/downloading) branch gets a companion sr-only label, resolved direction-and-pause-aware
// via activeStatusLabelKey, because its trailing text is a bare percentage (or, while paused, the word
// "Paused") with no other accessible mention of the transfer's direction anywhere in the row. A paused
// row swaps the spinner for a static pause glyph — a spinner reads as "still moving", which a
// suspended-in-place transfer is not (mirrors mobile's own icon swap while paused). Mirrors DriveRow's
// StarIcon (aria-hidden + a separate sr-only announcement) rather than relying on an aria-label on the
// icon itself.
function TransferStatusIcon({
	status,
	direction,
	paused
}: {
	status: Transfer["status"]
	direction: Transfer["direction"]
	paused: boolean
}) {
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
			{paused ? (
				<PauseCircleIcon
					aria-hidden="true"
					className="size-4 shrink-0 text-muted-foreground"
				/>
			) : (
				<Spinner
					aria-hidden="true"
					className="size-4 text-muted-foreground"
				/>
			)}
			<span className="sr-only">{t(activeStatusLabelKey(direction, paused))}</span>
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

// One row: type icon + name + live progress bar, mirroring DriveRow's icon+truncate+trailing idiom
// (drive/driveRow.tsx) scaled down for this narrower surface. Active (uploading/downloading) rows get
// a pause/resume toggle wired straight to features/transfers/lib/control.ts's pauseTransfer/
// resumeTransfer (pause/resume never reject, so the toggle flips the store's `paused` flag itself)
// plus a Cancel button (X glyph) that only REQUESTS a cancel via onRequestCancel — the screen owns the
// actual confirm dialog and the cancelTransfer call (see onRequestCancel's own doc comment for
// why). A finished row (isActiveTransfer false — done/error/completedWithErrors) gets a Remove button
// instead (trash glyph, deliberately distinct from Cancel's X — a finished transfer can't be
// "cancelled", only dismissed from the list), wired straight to the store with no confirm — a finished
// transfer is already done, so removing just clears its row.
export function TransferRow({ transfer, onRequestCancel }: TransferRowProps) {
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

	// Active-and-running shows a live percentage (the one number that actually changes tick to tick);
	// paused shows the word instead — the percentage is frozen while suspended, so re-displaying it
	// would misleadingly suggest progress is still happening. Once finished, the word carries more
	// information than a stale/redundant "100%" would. Intl.NumberFormat (not a hand-rolled `${n}%`
	// template) so the symbol/rounding follow the active locale — some locales space or place "%"
	// differently, and percent's default maximumFractionDigits is 0, which is also what rounds the
	// value for display.
	const trailingLabel =
		isActiveTransfer(transfer.status) && !transfer.paused
			? new Intl.NumberFormat(i18n.language, { style: "percent" }).format(progress / 100)
			: t(
					isActiveTransfer(transfer.status)
						? "transfersStatusPaused"
						: transfer.status === "done"
							? "transfersStatusDone"
							: "transfersStatusError"
				)

	return (
		<div className="flex flex-col gap-1.5 rounded-xl px-1 py-1.5 hover:bg-accent/50">
			<div className="flex items-center gap-2">
				{/* The row used to show only the generic direction arrow below; this is the item's
				actual type glyph (itemIcon.tsx's own FileTypeIcon/fileIconKey, reused verbatim so a
				transfer row's icon matches the one the same file shows once it lands in the listing). A
				transfer row carries no DriveItem to derive a directory glyph or a real download thumbnail
				from (see transferIconKey's own comment) — every row here is file-shaped, including a zip
				download, whose name already routes to the "archive" glyph. */}
				<FileTypeIcon
					iconKey={transferIconKey(transfer)}
					className="size-4 shrink-0"
				/>
				<TransferStatusIcon
					status={transfer.status}
					direction={transfer.direction}
					paused={transfer.paused}
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
						<Trash2Icon />
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
							onClick={onRequestCancel}
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

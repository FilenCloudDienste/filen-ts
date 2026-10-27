import { useTranslation } from "react-i18next"
import { Link } from "@tanstack/react-router"
import { ClockIcon, DownloadIcon, FolderSyncIcon, HardDriveIcon, UploadIcon } from "lucide-react"
import { clampedRatio } from "@filen/shared"
import type { ExternalTransferRow, ExternalTransferSource } from "@/features/transfers/lib/externalTransfers.logic"
import { ProgressGlyph, TRANSFER_ROW_CLASS } from "@/features/transfers/components/transferRow"
import { activeStatusLabelKey, steadyEtaSeconds } from "@/features/transfers/components/transferRow.logic"
import { useRunningDetails } from "@/features/transfers/hooks/useTransferFigures"
import { FileTypeIcon } from "@/features/drive/components/itemIcon"
import { fileIconKey } from "@/features/drive/lib/icon.logic"
import { pathBasename } from "@/features/sync/lib/syncStatus.logic"
import { PROTOCOL_LABEL_KEY } from "@/features/mounts/lib/mountsRoles"
import { ROLE_ICON } from "@/features/mounts/lib/mountsIcons"

const SOURCE_CLASS =
	"inline-flex max-w-[40%] shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground [&_svg]:size-3.5 [&_svg]:shrink-0"

// Where a row comes from, opening that sync pair or mount: the pair's name, the role, or the drive and its servers
// together when rclone's stats cannot tell them apart.
function SourceTag({ source }: { source: ExternalTransferSource }) {
	const { t } = useTranslation("transfers")
	const { t: tMounts } = useTranslation("mounts")

	if (source.kind === "sync") {
		return (
			<Link
				to="/sync/$pairId"
				params={{ pairId: source.pairId }}
				title={source.name}
				className={SOURCE_CLASS}
			>
				<FolderSyncIcon aria-hidden="true" />
				<span className="truncate">{source.name}</span>
			</Link>
		)
	}

	const { role } = source

	if (role === null) {
		return (
			<Link
				to="/mounts"
				className={SOURCE_CLASS}
			>
				<HardDriveIcon aria-hidden="true" />
				<span className="truncate">{t("transfersSourceMountsShared")}</span>
			</Link>
		)
	}

	const Icon = ROLE_ICON[role]
	const label = role === "drive" ? tMounts("mountsNetworkDrive") : tMounts("serveTitle", { protocol: tMounts(PROTOCOL_LABEL_KEY[role]) })

	return (
		<Link
			to="/mounts/$role"
			params={{ role }}
			className={SOURCE_CLASS}
		>
			<Icon aria-hidden="true" />
			<span className="truncate">{label}</span>
		</Link>
	)
}

// A transfer the desktop app's sync or mounts run: read-only, as neither offers a per-file control, and listed only
// while it moves. It reads like the screen's own rows, with its source in place of their controls.
export function ExternalTransferRowView({ row }: { row: ExternalTransferRow }) {
	const { t } = useTranslation("transfers")
	const runningDetails = useRunningDetails()

	if (row.kind === "queued") {
		const title = t("transfersExternalQueued", { count: row.count })

		return (
			<li
				aria-label={title}
				className={TRANSFER_ROW_CLASS}
			>
				<ProgressGlyph
					label={title}
					progress={null}
					valueText=""
					stalled
					icon={
						<UploadIcon
							aria-hidden="true"
							className="size-5 text-muted-foreground"
						/>
					}
					badge={<ClockIcon />}
					badgeClassName="bg-muted-foreground text-background"
				/>
				<div className="min-w-0 flex-1">
					<p className="truncate text-sm font-medium">{title}</p>
					<p className="truncate text-xs text-muted-foreground">{t("transfersExternalQueuedDetail")}</p>
				</div>
				<SourceTag source={row.source} />
			</li>
		)
	}

	const name = pathBasename(row.path)
	const percent = clampedRatio(row.bytes, row.total, 100)
	const speed = row.speed !== null && row.speed > 0 ? row.speed : null
	const DirectionIcon = row.direction === "upload" ? UploadIcon : DownloadIcon

	return (
		<li
			aria-label={name}
			className={TRANSFER_ROW_CLASS}
		>
			<ProgressGlyph
				label={name}
				progress={percent}
				valueText={t(activeStatusLabelKey(row.direction))}
				stalled={false}
				icon={
					<FileTypeIcon
						iconKey={fileIconKey(name)}
						className="size-5"
					/>
				}
				badge={<DirectionIcon />}
				badgeClassName="bg-primary text-primary-foreground"
			/>
			<div className="min-w-0 flex-1">
				<p
					title={row.path}
					className="truncate text-sm font-medium"
				>
					{name}
				</p>
				<p className="truncate text-xs text-muted-foreground tabular-nums">
					{
						runningDetails({
							transferred: row.bytes,
							size: row.total,
							percent,
							etaSeconds:
								speed !== null && row.total > 0 ? steadyEtaSeconds(Math.max(0, row.total - row.bytes) / speed) : null,
							bytesPerSecond: speed
						}).full
					}
				</p>
			</div>
			<SourceTag source={row.source} />
		</li>
	)
}

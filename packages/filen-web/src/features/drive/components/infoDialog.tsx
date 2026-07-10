import { createElement, useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { Link } from "@tanstack/react-router"
import { formatBytes } from "@filen/utils"
import { StarIcon } from "lucide-react"
import type { AnyDirWithContext } from "@filen/sdk-rs"
import { asDirectoryOrFile, toAnyDirWithContext, type DriveItem } from "@/features/drive/lib/item"
import { fileIconFor } from "@/features/drive/lib/icon"
import { formatCreatedDate, formatItemSize, formatModifiedDate, formatUploadedDate } from "@/features/drive/lib/format"
import { previewType } from "@/features/drive/lib/preview.logic"
import { dirColorHex } from "@/features/drive/lib/dirColor"
import { invalidateThumbnail } from "@/features/drive/lib/thumbnails"
import { parentNavigationTarget } from "@/features/drive/lib/navigate"
import { previewKindLabelKey } from "@/features/drive/components/infoDialog.logic"
import { useThumbnail } from "@/features/drive/hooks/useThumbnail"
import { useItemInfoQuery } from "@/features/drive/queries/drive"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { asErrorDTO } from "@/lib/sdk/errors"
import { cn } from "@/lib/utils"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"

export interface InfoDialogProps {
	item: DriveItem
	remoteInfoEnabled: boolean
	onClose: () => void
}

// A nested sharedDirectory's role is normally spread on by its fetcher (queries/drive.ts) — the catch
// here is a last-resort backstop for the one contract violation toAnyDirWithContext refuses to guess
// through (no role to dispatch with), so a stale/unspread row degrades to no size shown, same as any
// other getDirSize failure, instead of crashing the panel.
function safeDirContext(item: DriveItem): AnyDirWithContext | undefined {
	if (item.type !== "sharedDirectory" && item.type !== "sharedRootDirectory") {
		return undefined
	}

	try {
		return toAnyDirWithContext(item)
	} catch {
		return undefined
	}
}

// One row of the grouped detail card: a muted label, a right-aligned value. The value column opts into
// text selection (the global user-select policy leaves it off everywhere else) — see the app-shell
// spec's text-selection rule.
function InfoRow({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="flex items-center justify-between gap-4 px-3.5 py-2.5 text-sm">
			<span className="shrink-0 text-muted-foreground">{label}</span>
			<span className="min-w-0 truncate text-right font-medium select-text">{children}</span>
		</div>
	)
}

// Read-only item-info dialog — mounted-when-active by the listing's dialog host. Works for a directory
// or a file, including any of the four shared arms (routed through asDirectoryOrFile), and for an item
// in any variant including trash. Two tiers of data: item.data-derived rows (name, kind, mime,
// size for a file, created/uploaded/modified) are synchronous and always render; the Location path and
// a directory's recursive size/counts come from the remote getItemInfo call, gated by remoteInfoEnabled
// (false for trash — a trashed item's ancestry has nothing navigable to walk, and the worker's calls
// stall rather than reject on it). A large hero (thumbnail when the service has one, else the item icon
// on a soft tonal tile tinted by the directory's own color) carries the name and a type label; the
// grouped rows follow in filen-mobile's order. The Location row is a deliberate desktop addition — its
// value is a link that navigates to the item's parent directory and closes the dialog.
export function InfoDialog({ item, remoteInfoEnabled, onClose }: InfoDialogProps) {
	const { t } = useTranslation("drive")
	const dirContext = safeDirContext(item)
	// Rules-of-hooks: called unconditionally regardless of variant — remoteInfoEnabled controls
	// fetching through `enabled`, never whether the hook itself runs. dirContext is spread in only
	// when built (exactOptionalPropertyTypes rejects an explicit `dirContext: undefined`).
	const infoQuery = useItemInfoQuery(item.data, { enabled: remoteInfoEnabled, ...(dirContext !== undefined ? { dirContext } : {}) })
	const thumbUrl = useThumbnail(item)
	// Downgrades a torn/corrupt cache entry back to the icon without waiting for a remount — see the
	// img's own onError below. Never reset back to false: this mount already gave up on this uuid.
	const [thumbFailed, setThumbFailed] = useState(false)

	const name = item.data.decryptedMeta?.name ?? item.data.uuid
	// A shared file reads as a file, a shared directory as a directory (asDirectoryOrFile) — the raw
	// six-arm `item.type` would miss every shared arm in the branches below (see item.ts).
	const base = asDirectoryOrFile(item)
	const isDirectory = base.type === "directory"
	// Only an owned directory tints by its own color; a shared directory's arm carries the owner's color
	// but reads as the neutral default here, mirroring filen-mobile's hero.
	const dirHex = dirColorHex(item.type === "directory" ? item.data.color : "default")
	const showThumb = base.type === "file" && thumbUrl !== null && !thumbFailed

	const mime = base.type === "file" ? base.data.decryptedMeta?.mime : undefined
	const kindKey = base.type === "file" ? previewKindLabelKey(previewType(item)) : null

	// Remote-query projections — every remote row degrades independently to omitted (a directory that
	// never resolves a size shows no size row; an item whose path can't resolve shows no Location row).
	const remoteLoading = remoteInfoEnabled && infoQuery.isLoading
	const remoteError = remoteInfoEnabled && infoQuery.status === "error"
	const dirSize = isDirectory && infoQuery.status === "success" ? infoQuery.data.size : null
	const path = infoQuery.status === "success" ? infoQuery.data.path : null
	const ancestors = infoQuery.status === "success" ? infoQuery.data.ancestors : []
	// An item at the drive root resolves an empty path string (empty ancestor chain) — show the root
	// label rather than a blank value; a trailing slash (get_item_path ends every directory segment
	// with one) is trimmed for display only, never from the uuid-based navigation target.
	const pathLabel = path === "" ? t("driveMyDrive") : (path?.replace(/\/$/, "") ?? "")

	return (
		<Dialog
			open
			onOpenChange={next => {
				if (!next) {
					onClose()
				}
			}}
		>
			<DialogContent>
				<div className="flex min-w-0 flex-col items-center gap-3 pt-2 text-center">
					<div
						className={cn(
							"relative flex size-28 shrink-0 items-center justify-center overflow-hidden rounded-2xl ring-1 ring-foreground/5",
							!isDirectory && "bg-muted"
						)}
						style={isDirectory ? { backgroundColor: `color-mix(in srgb, ${dirHex} 16%, transparent)` } : undefined}
					>
						{showThumb ? (
							<img
								src={thumbUrl}
								alt=""
								draggable={false}
								decoding="async"
								className="size-full object-cover"
								onError={() => {
									invalidateThumbnail(item.data.uuid)
									setThumbFailed(true)
								}}
							/>
						) : (
							createElement(fileIconFor(item), {
								"aria-hidden": true,
								className: cn("size-12", !isDirectory && "text-muted-foreground"),
								...(isDirectory ? { style: { color: dirHex } } : {})
							})
						)}
					</div>
					<div className="flex flex-col items-center gap-1">
						<div className="flex w-full min-w-0 items-center justify-center gap-1.5">
							<DialogTitle className="line-clamp-2 min-w-0 text-base leading-snug font-medium break-words select-text">
								{name}
							</DialogTitle>
							{item.data.favorited ? (
								<>
									<StarIcon
										aria-hidden="true"
										className="size-4 shrink-0 fill-amber-500 text-amber-500"
									/>
									<span className="sr-only">{t("driveFavorited")}</span>
								</>
							) : null}
						</div>
						<span className="text-sm text-muted-foreground">
							{t(isDirectory ? "driveItemTypeDirectory" : "driveItemTypeFile")}
						</span>
					</div>
				</div>

				<div className="flex min-w-0 flex-col divide-y divide-border/50 rounded-xl ring-1 ring-border/60">
					{base.type === "file" ? (
						<InfoRow label={t("driveInfoSize")}>{formatItemSize(item)}</InfoRow>
					) : remoteInfoEnabled && (dirSize !== null || remoteLoading) ? (
						<InfoRow label={t("driveInfoSize")}>
							{dirSize !== null ? (
								formatBytes(Number(dirSize.size))
							) : (
								<Spinner className="ml-auto size-4 text-muted-foreground" />
							)}
						</InfoRow>
					) : null}

					{dirSize !== null ? (
						<>
							<InfoRow label={t("driveInfoFileCount")}>{dirSize.files.toString()}</InfoRow>
							<InfoRow label={t("driveInfoDirectoryCount")}>{dirSize.dirs.toString()}</InfoRow>
						</>
					) : null}

					{kindKey !== null ? <InfoRow label={t("driveInfoKind")}>{t(kindKey)}</InfoRow> : null}

					{mime !== undefined ? <InfoRow label={t("driveInfoMimeType")}>{mime}</InfoRow> : null}

					<InfoRow label={t("driveInfoCreated")}>{formatCreatedDate(item)}</InfoRow>
					<InfoRow label={t("driveInfoUploaded")}>{formatUploadedDate(item)}</InfoRow>
					<InfoRow label={t("driveInfoModified")}>{formatModifiedDate(item)}</InfoRow>

					{remoteInfoEnabled && (remoteLoading || remoteError || path !== null) ? (
						<InfoRow label={t("driveInfoPath")}>
							{remoteError ? (
								<span className="text-destructive">{errorLabel(asErrorDTO(infoQuery.error))}</span>
							) : path !== null ? (
								<Link
									to="/drive/$"
									params={parentNavigationTarget(ancestors).params}
									className="text-foreground hover:underline"
									onClick={onClose}
								>
									{pathLabel}
								</Link>
							) : (
								<Spinner className="ml-auto size-4 text-muted-foreground" />
							)}
						</InfoRow>
					) : null}
				</div>
			</DialogContent>
		</Dialog>
	)
}

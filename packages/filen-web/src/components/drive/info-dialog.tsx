import { createElement, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { formatBytes } from "@filen/utils"
import { StarIcon } from "lucide-react"
import type { DriveItem } from "@/lib/drive/item"
import { fileIconFor } from "@/lib/drive/icon"
import { formatCreatedDate, formatItemSize, formatModifiedDate } from "@/lib/drive/format"
import { useItemInfoQuery } from "@/queries/drive"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { asErrorDTO } from "@/lib/sdk/errors"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"

export interface InfoDialogProps {
	item: DriveItem
	remoteInfoEnabled: boolean
	onClose: () => void
}

function InfoRow({ label, value }: { label: string; value: ReactNode }) {
	return (
		<div className="flex items-center justify-between gap-4 border-b border-border py-2 text-sm last:border-b-0">
			<span className="shrink-0 text-muted-foreground">{label}</span>
			<span className="min-w-0 truncate text-right font-medium">{value}</span>
		</div>
	)
}

// Read-only item-info panel — mounted-when-active by the listing's dialog host. Works for a directory
// or a file, and for an item in any variant including trash (info is offered there too — see
// item-menu.logic.ts). Two tiers of data: item.data-derived rows (name, created, modified, and a
// file's size/mime) are synchronous and need no network, so they always render regardless of variant
// or query state. Path and a directory's size/file/dir counts come from the remote getItemInfo call
// instead, gated by remoteInfoEnabled (passed down by the host, false for trash) — a trashed item's
// ancestry has nothing navigable to walk, and the worker's getItemPath/getDirSize calls stall rather
// than reject on it, so trash skips the query outright instead of risking the whole panel on a stall a
// `.catch` can't rescue. Every other variant still runs the query, and the worker's own per-field
// catch (see sdk.worker.ts's getItemInfo) means a stale/deleted ancestor there can leave just the Path
// row absent without failing the read. Type and favorited status are conveyed visually (the row's own
// icon, a star next to the name) rather than as separate text rows — the same language DriveRow
// already uses, so this panel needs no dedicated "Type"/"Favorited" copy of its own.
export function InfoDialog({ item, remoteInfoEnabled, onClose }: InfoDialogProps) {
	const { t } = useTranslation("drive")
	// Rules-of-hooks: called unconditionally regardless of variant — remoteInfoEnabled controls
	// fetching through `enabled`, never whether the hook itself runs.
	const infoQuery = useItemInfoQuery(item.data, { enabled: remoteInfoEnabled })
	const name = item.data.decryptedMeta?.name ?? item.data.uuid

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
				<DialogHeader>
					<DialogTitle className="flex min-w-0 items-center gap-2">
						{createElement(fileIconFor(item), { "aria-hidden": true, className: "size-4 shrink-0 text-muted-foreground" })}
						<span className="min-w-0 truncate">{name}</span>
						{item.data.favorited ? (
							<>
								<StarIcon
									aria-hidden="true"
									className="size-3.5 shrink-0 fill-amber-500 text-amber-500"
								/>
								<span className="sr-only">{t("driveFavorited")}</span>
							</>
						) : null}
					</DialogTitle>
				</DialogHeader>
				<div className="flex flex-col">
					{/* Remote section: a disabled query (trash) sits at status "pending" with fetchStatus
					"idle" forever, so isLoading (isFetching && isPending) is reliably false for it — gating
					on remoteInfoEnabled first, then isLoading, means trash renders none of this rather than
					stalling on a spinner. */}
					{remoteInfoEnabled ? (
						infoQuery.isLoading ? (
							<div className="flex justify-center py-4">
								<Spinner />
							</div>
						) : infoQuery.status === "error" ? (
							<p className="py-2 text-sm text-destructive">{errorLabel(asErrorDTO(infoQuery.error))}</p>
						) : infoQuery.status === "success" ? (
							<>
								{infoQuery.data.path !== null ? (
									<InfoRow
										label={t("driveInfoPath")}
										value={infoQuery.data.path}
									/>
								) : null}
								{item.type === "directory" && infoQuery.data.size ? (
									<>
										<InfoRow
											label={t("driveInfoSize")}
											value={formatBytes(Number(infoQuery.data.size.size))}
										/>
										<InfoRow
											label={t("driveInfoFileCount")}
											value={infoQuery.data.size.files.toString()}
										/>
										<InfoRow
											label={t("driveInfoDirectoryCount")}
											value={infoQuery.data.size.dirs.toString()}
										/>
									</>
								) : null}
							</>
						) : null
					) : null}
					{item.type === "file" ? (
						<>
							<InfoRow
								label={t("driveInfoSize")}
								value={formatItemSize(item)}
							/>
							{item.data.decryptedMeta ? (
								<InfoRow
									label={t("driveInfoMimeType")}
									value={item.data.decryptedMeta.mime}
								/>
							) : null}
						</>
					) : null}
					<InfoRow
						label={t("driveInfoCreated")}
						value={formatCreatedDate(item)}
					/>
					<InfoRow
						label={t("driveInfoModified")}
						value={formatModifiedDate(item)}
					/>
				</div>
			</DialogContent>
		</Dialog>
	)
}

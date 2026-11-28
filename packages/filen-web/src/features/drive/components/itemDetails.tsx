import { useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { Link } from "@tanstack/react-router"
import { useQueries, useQuery } from "@tanstack/react-query"
import { cn, driveItemName, formatBytes } from "@filen/shared"
import { CopyIcon, LinkIcon, StarIcon, UserPlusIcon, XIcon } from "lucide-react"
import {
	asDirectoryOrFile,
	driveItemMime,
	getSharerIdentity,
	isDirectoryItem,
	type DriveItem,
	type SharedRootDriveItem
} from "@/features/drive/lib/item"
import { type DriveVariant } from "@/features/drive/lib/preferences"
import { type FileItem } from "@/features/drive/lib/actions"
import { unshareItems } from "@/features/drive/lib/share/actions"
import { DRIVE_UNSHARE, driveActivity } from "@/features/drive/lib/activity"
import { copyItemLink } from "@/features/drive/lib/copyLink"
import {
	formatCreatedDateTime,
	formatItemSize,
	formatModifiedDateTime,
	formatUploadedDateTime,
	sharedIdentityLabel
} from "@/features/drive/lib/format"
import { previewType } from "@/features/drive/lib/preview.logic"
import { parentNavigationTarget } from "@/features/drive/lib/navigate"
import { driveSelectionActions } from "@/features/drive/lib/selectionActions"
import { readImageDetails } from "@/features/drive/lib/imageDetails"
import { imageDetailsQueryKey } from "@/features/drive/lib/imageDetails.logic"
import { useFileKindVerdict } from "@/features/drive/hooks/useFileKindVerdict"
import {
	directorySizeQueryOptions,
	driveItemLinkStatusQueryOptions,
	driveListingQueryOptions,
	useDirectorySizeQuery,
	useFileVersionsQuery,
	useItemInfoQuery,
	type DirectorySizeItem
} from "@/features/drive/queries/drive"
import { isOwnedLiveItem, recipientsOf, selectionTotals } from "@/features/drive/components/itemDetails.logic"
import { previewKindLabelKey } from "@/features/drive/components/infoDialog.logic"
import { nonCurrentVersions } from "@/features/drive/components/versionsDialog.logic"
import { ItemHeroTile } from "@/features/drive/components/itemThumbnail"
import {
	cameraLabel,
	formatCoordinates,
	formatExposure,
	formatFNumber,
	formatFocalLength
} from "@/features/preview/imageEdit/lib/exifSummary"
import { runBulkActivity } from "@/lib/activity/activity"
import { copyText } from "@/lib/copyText"
import { formatDateTime } from "@/lib/formatDate"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { useIsOnline } from "@/lib/useIsOnline"
import { CannotDecryptState } from "@/components/cannotDecryptState"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { TooltipIconButton } from "@/components/ui/tooltipIconButton"

// An item's details, one source for both places that show them: the listing's details panel and the Info dialog of
// every surface without one (the preview, photos). Synchronous rows come from the item; every remote read (location,
// a directory's size, the photo header, the public link, the recipients, the versions on request) waits for
// `remoteReady` and reuses the cache entries the rest of the app fills.

// The dialogs the details open from their sections.
export type ItemDetailsDialog = "link" | "share" | "versions"

// A link's status changes only through this account's writes (which patch the entry) or another device: a few
// minutes of reuse spares a read per item looked at.
const LINK_STATUS_STALE_MS = 5 * 60 * 1000

// The newest previous versions listed; the versions dialog has them all.
const VERSIONS_SHOWN = 5

// One row of a grouped detail card: a muted label, a right-aligned value. The value column opts into
// text selection (the global user-select policy leaves it off everywhere else) — see the app-shell
// spec's text-selection rule. Short values (sizes, dates, counts) stay on one line; `wrap` is for values
// that can run long (path, MIME type, sharer, an error message), which wrap in full instead of being cut.
export function InfoRow({ label, wrap = false, children }: { label: string; wrap?: boolean; children: ReactNode }) {
	return (
		<div className={cn("flex justify-between gap-4 px-3.5 py-2.5 text-sm", wrap ? "items-start" : "items-center")}>
			<span className="shrink-0 text-muted-foreground">{label}</span>
			<span className={cn("min-w-0 text-right font-medium select-text", wrap ? "break-words" : "truncate")}>{children}</span>
		</div>
	)
}

// A row whose value carries a trailing copy button (an ID, coordinates).
function CopyRow({ label, value, copyLabel, copiedMessage }: { label: string; value: string; copyLabel: string; copiedMessage: string }) {
	return (
		<div className="flex items-center justify-between gap-2 py-1 pr-1.5 pl-3.5 text-sm">
			<span className="shrink-0 text-muted-foreground">{label}</span>
			<span className="min-w-0 flex-1 truncate text-right font-medium select-text">{value}</span>
			<TooltipIconButton
				label={copyLabel}
				onClick={() => {
					void copyText(value, copiedMessage)
				}}
			>
				<CopyIcon />
			</TooltipIconButton>
		</div>
	)
}

function Card({ children }: { children: ReactNode }) {
	return <div className="flex min-w-0 flex-col divide-y divide-border/50 rounded-xl ring-1 ring-border/60">{children}</div>
}

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
	return (
		<section className="flex min-w-0 flex-col gap-2">
			<div className="flex h-7 items-center justify-between gap-2">
				<h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
				{action}
			</div>
			{children}
		</section>
	)
}

function LoadingRow() {
	return (
		<div className="flex h-10 items-center justify-center">
			<Spinner className="size-4 text-muted-foreground" />
		</div>
	)
}

function ManageButton({ onClick }: { onClick: () => void }) {
	const { t } = useTranslation("drive")

	return (
		<Button
			variant="ghost"
			size="xs"
			onClick={onClick}
		>
			{t("driveDetailsManage")}
		</Button>
	)
}

// A directory's recursive size and counts, read from the listing's own dirSize entry so a size its row
// already resolved shows without a second getDirSize. A failed read (including a shared directory
// whose role never got spread on — toAnyDirWithContext throws) omits the rows, same as any absent data.
// `enabled` false holds the read back: a cached size still shows.
function DirectorySizeRows({ item, enabled }: { item: DirectorySizeItem; enabled: boolean }) {
	const { t } = useTranslation("drive")
	const sizeQuery = useDirectorySizeQuery(item, { enabled })

	if (sizeQuery.status === "success") {
		return (
			<>
				<InfoRow label={t("driveInfoSize")}>{formatBytes(Number(sizeQuery.data.size))}</InfoRow>
				<InfoRow label={t("driveInfoFileCount")}>{sizeQuery.data.files.toString()}</InfoRow>
				<InfoRow label={t("driveInfoDirectoryCount")}>{sizeQuery.data.dirs.toString()}</InfoRow>
			</>
		)
	}

	return sizeQuery.status === "pending" ? (
		<InfoRow label={t("driveInfoSize")}>
			<Spinner className="ml-auto size-4 text-muted-foreground" />
		</InfoRow>
	) : null
}

// The item's hero: a large tile (thumbnail when the service has one, else the item icon on a soft tonal tile tinted
// by the directory's own color), its name with the favorite star, and a type label. `renderName` renders the name
// (the dialog's DialogTitle, a plain line in the panel).
function ItemHero({
	item,
	large,
	remoteReady,
	renderName
}: {
	item: DriveItem
	large: boolean
	// False holds a thumbnail that would have to be generated (a read) back; a cached one still shows.
	remoteReady: boolean
	renderName: (name: string, className: string) => ReactNode
}) {
	const { t } = useTranslation("drive")
	const isDirectory = asDirectoryOrFile(item).type === "directory"

	return (
		<div className="flex min-w-0 flex-col items-center gap-3 pt-2 text-center">
			<ItemHeroTile
				item={item}
				generate={remoteReady}
				className={large ? "size-28 rounded-2xl" : "size-20 rounded-2xl"}
				iconClassName={large ? "size-12" : "size-9"}
			/>
			<div className="flex w-full min-w-0 flex-col items-center gap-1">
				<div className="flex w-full min-w-0 items-center justify-center gap-1.5">
					{renderName(driveItemName(item), "line-clamp-2 min-w-0 text-base leading-snug font-medium break-words select-text")}
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
				<span className="text-sm text-muted-foreground">{t(isDirectory ? "driveItemTypeDirectory" : "driveItemTypeFile")}</span>
			</div>
		</div>
	)
}

// The general card in filen-mobile's order. The Location path (getItemInfo) and a directory's recursive size are
// remote and off for trash (`remoteInfoEnabled`: a trashed item's ancestry has nothing navigable to walk, and the
// worker's calls stall rather than reject on it).
function GeneralRows({
	item,
	variant,
	remoteInfoEnabled,
	remoteReady,
	onNavigate
}: {
	item: DriveItem
	variant: DriveVariant
	remoteInfoEnabled: boolean
	remoteReady: boolean
	onNavigate: (() => void) | undefined
}) {
	const { t } = useTranslation("drive")
	const infoQuery = useItemInfoQuery(item.data, { enabled: remoteInfoEnabled && remoteReady })
	// A shared file reads as a file, a shared directory as a directory (asDirectoryOrFile) — the raw
	// six-arm `item.type` would miss every shared arm in the branches below (see item.ts).
	const base = asDirectoryOrFile(item)
	const mime = driveItemMime(item)
	const verdict = useFileKindVerdict(base.type === "file" ? base.data.uuid : undefined)
	const kindKey = base.type === "file" ? previewKindLabelKey(previewType(item, verdict)) : null
	// The sharing counterparty on the two shared variants' root rows; the only place it survives once the listing
	// row sheds its own label on a narrow card (see driveRow.tsx).
	const shared = sharedIdentityLabel(item, variant)
	const remoteLoading = remoteInfoEnabled && infoQuery.status === "pending"
	const remoteError = remoteInfoEnabled && infoQuery.status === "error"
	const path = infoQuery.status === "success" ? infoQuery.data.path : null
	const ancestors = infoQuery.status === "success" ? infoQuery.data.ancestors : []
	// An item at the drive root resolves an empty path string — the root label instead; a trailing slash (get_item_path
	// ends every directory segment with one) is trimmed for display only, never from the uuid-based navigation target.
	const pathLabel = path === "" ? t("driveMyDrive") : (path?.replace(/\/$/, "") ?? "")

	return (
		<Card>
			{base.type === "file" ? (
				<InfoRow label={t("driveInfoSize")}>{formatItemSize(item)}</InfoRow>
			) : remoteInfoEnabled && isDirectoryItem(item) ? (
				<DirectorySizeRows
					item={item}
					enabled={remoteReady}
				/>
			) : null}

			{kindKey !== null ? <InfoRow label={t("driveInfoKind")}>{t(kindKey)}</InfoRow> : null}

			{mime !== undefined ? (
				<InfoRow
					label={t("driveInfoMimeType")}
					wrap
				>
					{mime}
				</InfoRow>
			) : null}

			<InfoRow label={t("driveInfoCreated")}>{formatCreatedDateTime(item)}</InfoRow>
			<InfoRow label={t("driveInfoUploaded")}>{formatUploadedDateTime(item)}</InfoRow>
			<InfoRow label={t("driveInfoModified")}>{formatModifiedDateTime(item)}</InfoRow>

			{shared ? (
				<InfoRow
					label={t(variant === "sharedIn" ? "driveInfoSharedBy" : "driveInfoSharedWith")}
					wrap
				>
					{shared.name}
				</InfoRow>
			) : null}

			{remoteInfoEnabled && (remoteLoading || remoteError || path !== null) ? (
				<InfoRow
					label={t("driveInfoPath")}
					wrap
				>
					{remoteError ? (
						<span className="text-destructive">{errorLabel(infoQuery.error)}</span>
					) : path !== null ? (
						<Link
							to="/drive/$"
							params={parentNavigationTarget(ancestors).params}
							className="text-foreground hover:underline"
							onClick={onNavigate}
						>
							{pathLabel}
						</Link>
					) : (
						<Spinner className="ml-auto size-4 text-muted-foreground" />
					)}
				</InfoRow>
			) : null}

			<CopyRow
				label={t("driveDetailsId")}
				value={item.data.uuid}
				copyLabel={t("driveDetailsCopyId")}
				copiedMessage={t("driveCopyIdToast")}
			/>
		</Card>
	)
}

// What the picture's own header says (imageDetails.ts): one bounded read, cancelled through the query's signal when
// the details move on. A content change rotates the uuid, so an answer never goes stale. Nothing renders until there
// is something to show.
function PhotoSection({ item, remoteReady }: { item: DriveItem; remoteReady: boolean }) {
	const { t } = useTranslation("drive")
	const query = useQuery({
		queryKey: imageDetailsQueryKey(item.data.uuid),
		queryFn: ({ signal }) => readImageDetails(item, signal),
		enabled: remoteReady,
		staleTime: Infinity
	})
	const details = query.data

	if (details === undefined || details === null) {
		return null
	}

	const exif = details.exif
	const camera = exif === null ? null : cameraLabel(exif.make, exif.model)
	const rows: ReactNode[] = []

	if (details.width > 0 && details.height > 0) {
		rows.push(
			<InfoRow
				key="dimensions"
				label={t("driveDetailsDimensions")}
			>
				{t("driveDetailsDimensionsValue", { width: details.width, height: details.height })}
			</InfoRow>
		)
	}

	if (exif !== null) {
		const text: [key: string, label: string, value: string | null][] = [
			["taken", t("driveDetailsTaken"), exif.takenMs === null ? null : formatDateTime(exif.takenMs)],
			["camera", t("driveDetailsCamera"), camera],
			["lens", t("driveDetailsLens"), exif.lens],
			["aperture", t("driveDetailsAperture"), exif.fNumber === null ? null : formatFNumber(exif.fNumber)],
			["exposure", t("driveDetailsExposure"), exif.exposureSeconds === null ? null : formatExposure(exif.exposureSeconds)],
			["iso", t("driveDetailsIso"), exif.iso === null ? null : String(exif.iso)],
			[
				"focal",
				t("driveDetailsFocalLength"),
				exif.focalLength === null ? null : formatFocalLength(exif.focalLength, exif.focalLength35mm)
			],
			[
				"flash",
				t("driveDetailsFlash"),
				exif.flashFired === null ? null : t(exif.flashFired ? "driveDetailsFlashFired" : "driveDetailsFlashOff")
			]
		]

		for (const [key, label, value] of text) {
			if (value !== null) {
				rows.push(
					<InfoRow
						key={key}
						label={label}
						wrap
					>
						{value}
					</InfoRow>
				)
			}
		}

		if (exif.latitude !== null && exif.longitude !== null) {
			rows.push(
				<CopyRow
					key="location"
					label={t("driveDetailsGps")}
					value={formatCoordinates(exif.latitude, exif.longitude)}
					copyLabel={t("driveDetailsCopyGps")}
					copiedMessage={t("driveDetailsGpsCopied")}
				/>
			)
		}
	}

	return rows.length === 0 ? null : (
		<Section title={t("driveDetailsPhoto")}>
			<Card>{rows}</Card>
		</Section>
	)
}

// The public link's status (the link dialog's own entry), with copy and the dialog to manage it.
function LinkSection({ item, remoteReady, onOpenDialog }: { item: DriveItem; remoteReady: boolean; onOpenDialog: OpenDialog }) {
	const { t } = useTranslation("drive")
	const query = useQuery({ ...driveItemLinkStatusQueryOptions(item), enabled: remoteReady, staleTime: LINK_STATUS_STALE_MS })

	function openDialog(): void {
		onOpenDialog("link")
	}

	return (
		<Section
			title={t("driveDetailsPublicLink")}
			action={<ManageButton onClick={openDialog} />}
		>
			{query.status === "pending" ? (
				<LoadingRow />
			) : query.status === "error" ? (
				<p className="text-sm text-destructive">{errorLabel(query.error)}</p>
			) : query.data === null ? (
				<p className="text-sm text-muted-foreground">{t("driveDetailsLinkOff")}</p>
			) : (
				<div className="flex items-center gap-2">
					<LinkIcon
						aria-hidden="true"
						className="size-4 shrink-0 text-muted-foreground"
					/>
					<p className="min-w-0 flex-1 text-sm">{t("driveDetailsLinkOn")}</p>
					<TooltipIconButton
						label={t("driveActionCopyLink")}
						onClick={() => {
							void copyItemLink(item, t("driveLinkUrlCopiedToast"), openDialog)
						}}
					>
						<CopyIcon />
					</TooltipIconButton>
				</div>
			)}
		</Section>
	)
}

// Who the item is shared with, from the Shared by me root listing (one read serves every item, and the socket keeps
// it current for the session), each recipient removable. The share picker adds more.
function SharedWithSection({ item, remoteReady, onOpenDialog }: { item: DriveItem; remoteReady: boolean; onOpenDialog: OpenDialog }) {
	const { t } = useTranslation(["drive", "common"])
	const isOnline = useIsOnline()
	const query = useQuery({ ...driveListingQueryOptions("sharedOut", null), enabled: remoteReady })
	const [removing, setRemoving] = useState<SharedRootDriveItem | null>(null)
	const [pending, setPending] = useState(false)
	const recipients = query.data === undefined ? [] : recipientsOf(query.data, item.data.uuid)
	const offlineTitle = isOnline ? undefined : t("common:offlineActionDisabled")
	const removingEmail = removing === null ? "" : (getSharerIdentity(removing)?.email ?? "")

	async function handleRemove(row: SharedRootDriveItem): Promise<void> {
		setPending(true)
		// Only that recipient's row goes; the item itself (same uuid) stays selected.
		await runBulkActivity(
			driveActivity<DriveItem>([row], DRIVE_UNSHARE, (targets, onSettled) => unshareItems(targets, "sharedOut", onSettled), {
				prune: () => undefined
			})
		)
		setPending(false)
		setRemoving(null)
	}

	return (
		<Section
			title={t("driveDetailsSharedWith")}
			action={
				<TooltipIconButton
					label={t("driveActionShare")}
					disabled={!isOnline}
					title={offlineTitle}
					onClick={() => {
						onOpenDialog("share")
					}}
				>
					<UserPlusIcon />
				</TooltipIconButton>
			}
		>
			{query.status === "pending" ? (
				<LoadingRow />
			) : query.status === "error" ? (
				<p className="text-sm text-destructive">{errorLabel(query.error)}</p>
			) : recipients.length === 0 ? (
				<p className="text-sm text-muted-foreground">{t("driveDetailsNotShared")}</p>
			) : (
				<ul className="flex flex-col">
					{recipients.map(row => {
						const email = getSharerIdentity(row)?.email ?? ""

						return (
							<li
								key={email}
								className="flex h-9 items-center gap-2 text-sm"
							>
								<span className="min-w-0 flex-1 truncate select-text">{email}</span>
								<TooltipIconButton
									label={t("driveDetailsRemoveRecipient", { email })}
									disabled={pending || !isOnline}
									title={offlineTitle}
									onClick={() => {
										setRemoving(row)
									}}
								>
									<XIcon />
								</TooltipIconButton>
							</li>
						)
					})}
				</ul>
			)}
			<ConfirmDialog
				open={removing !== null}
				pending={pending}
				title={t("driveUnshareConfirmTitle")}
				body={t("driveDetailsRemoveRecipientBody", { email: removingEmail })}
				confirmLabel={t("driveActionUnshare")}
				cancelLabel={t("common:cancel")}
				destructive
				onOpenChange={open => {
					if (!open && !pending) {
						setRemoving(null)
					}
				}}
				onConfirm={() => {
					if (removing !== null) {
						void handleRemove(removing)
					}
				}}
			/>
		</Section>
	)
}

function VersionsList({ file }: { file: FileItem }) {
	const { t } = useTranslation("drive")
	const query = useFileVersionsQuery(file.data)

	if (query.status === "pending") {
		return <LoadingRow />
	}

	if (query.status === "error") {
		return <p className="text-sm text-destructive">{errorLabel(query.error)}</p>
	}

	const previous = nonCurrentVersions(query.data, file)

	if (previous.length === 0) {
		return <p className="text-sm text-muted-foreground">{t("driveVersionsEmpty")}</p>
	}

	return (
		<Card>
			{previous.slice(0, VERSIONS_SHOWN).map(version => (
				<InfoRow
					key={version.uuid}
					label={formatDateTime(version.timestamp)}
				>
					{formatBytes(Number(version.size))}
				</InfoRow>
			))}
		</Card>
	)
}

// A file's history, read only on request: most looks at an item never need it.
function VersionsSection({ file, onOpenDialog }: { file: FileItem; onOpenDialog: OpenDialog }) {
	const { t } = useTranslation("drive")
	const [shown, setShown] = useState(false)

	return (
		<Section
			title={t("driveDetailsVersions")}
			action={
				<ManageButton
					onClick={() => {
						onOpenDialog("versions")
					}}
				/>
			}
		>
			{shown ? (
				<VersionsList file={file} />
			) : (
				<Button
					variant="outline"
					size="sm"
					onClick={() => {
						setShown(true)
					}}
				>
					{t("driveDetailsShowVersions")}
				</Button>
			)}
		</Section>
	)
}

type OpenDialog = (kind: ItemDetailsDialog) => void

// One item's details. `remoteReady` false holds every remote read back (the panel, until the selection settles);
// `large` is the dialog's hero size; `onNavigate` runs on the Location link's click.
export function ItemDetails({
	item,
	variant,
	remoteReady,
	large = false,
	renderName,
	onOpenDialog,
	onNavigate
}: {
	item: DriveItem
	variant: DriveVariant
	remoteReady: boolean
	large?: boolean
	renderName: (name: string, className: string) => ReactNode
	onOpenDialog: OpenDialog
	onNavigate?: (() => void) | undefined
}) {
	const base = asDirectoryOrFile(item)
	const verdict = useFileKindVerdict(base.type === "file" ? base.data.uuid : undefined)

	// No readable name or metadata to show: the shared explainer (mobile parity).
	if (item.data.undecryptable) {
		return <CannotDecryptState />
	}

	const category = base.type === "file" ? previewType(item, verdict) : null
	const owned = isOwnedLiveItem(item, variant)

	return (
		<>
			<ItemHero
				item={item}
				large={large}
				remoteReady={remoteReady}
				renderName={renderName}
			/>
			<GeneralRows
				item={item}
				variant={variant}
				remoteInfoEnabled={variant !== "trash"}
				remoteReady={remoteReady}
				onNavigate={onNavigate}
			/>
			{category === "image" || category === "rawImage" ? (
				<PhotoSection
					item={item}
					remoteReady={remoteReady}
				/>
			) : null}
			{owned ? (
				<>
					<LinkSection
						item={item}
						remoteReady={remoteReady}
						onOpenDialog={onOpenDialog}
					/>
					<SharedWithSection
						item={item}
						remoteReady={remoteReady}
						onOpenDialog={onOpenDialog}
					/>
				</>
			) : null}
			{owned && item.type === "file" ? (
				<VersionsSection
					file={item}
					onOpenDialog={onOpenDialog}
				/>
			) : null}
		</>
	)
}

// Several items: counts and the total size. Files' sizes are on the items; a directory's comes from the dirSize
// cache the listing's size column fills, and only the user's Calculate reads the ones missing. Then the actions the
// whole selection offers, as its menu lists them.
export function SelectionDetails({ items, variant, remoteReady }: { items: DriveItem[]; variant: DriveVariant; remoteReady: boolean }) {
	const { t } = useTranslation("drive")
	const isOnline = useIsOnline()
	const [calculate, setCalculate] = useState(false)
	const directories = items.filter(isDirectoryItem)
	const sizeQueries = useQueries({
		queries: directories.map(directory => ({ ...directorySizeQueryOptions(directory), enabled: calculate && remoteReady }))
	})
	const sizes = new Map<string, bigint>()

	sizeQueries.forEach((query, index) => {
		const directory = directories[index]

		if (directory !== undefined && query.data !== undefined) {
			sizes.set(directory.data.uuid, query.data.size)
		}
	})

	const totals = selectionTotals(items, uuid => sizes.get(uuid))
	const known = formatBytes(totals.knownBytes)
	const fetching = sizeQueries.some(query => query.fetchStatus === "fetching")
	const actions = driveSelectionActions(items, variant, { isOnline }).filter(action => action.enabled !== false)

	return (
		<>
			<Card>
				<InfoRow label={t("driveDetailsFiles")}>{totals.files.toString()}</InfoRow>
				<InfoRow label={t("driveDetailsDirectories")}>{totals.directories.toString()}</InfoRow>
				<InfoRow label={t("driveDetailsTotalSize")}>
					{totals.unknownDirectories === 0 ? known : t("driveDetailsAtLeast", { size: known })}
				</InfoRow>
			</Card>
			{totals.unknownDirectories > 0 && variant !== "trash" ? (
				<Button
					variant="outline"
					size="sm"
					disabled={calculate || !isOnline}
					onClick={() => {
						setCalculate(true)
					}}
				>
					{fetching ? <Spinner data-icon="inline-start" /> : null}
					{t("driveDetailsCalculate")}
				</Button>
			) : null}
			{actions.length > 0 ? (
				<Section title={t("driveDetailsActions")}>
					<p className="text-sm">{actions.map(action => t(action.labelKey)).join(", ")}</p>
				</Section>
			) : null}
		</>
	)
}

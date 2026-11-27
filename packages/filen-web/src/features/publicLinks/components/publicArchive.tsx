import { useState } from "react"
import { useTranslation } from "react-i18next"
import { ListTreeIcon, type LucideIcon } from "lucide-react"
import type { AnyItemWithContext } from "@filen/sdk-rs"
import { ACTION_DEFS } from "@/features/drive/lib/actionDefs"
import { extractArchiveTo } from "@/features/drive/lib/archiveActions"
import { MoveTargetDialog } from "@/features/drive/components/moveTargetDialog"
import { CompressDialog } from "@/features/drive/components/compressDialog"
import type { ArchiveSource } from "@/features/archive/lib/archiveSource"
import { ArchiveSourceBrowser } from "@/features/archive/components/archiveBrowser"
import { PreviewAccessModeProvider, PreviewDownloadableProvider } from "@/features/preview/lib/accessMode"
import { ComicSourceViewer } from "@/features/comics/components/comicViewer"
import type { DriveItem } from "@/features/drive/lib/item"
import { usePublicVisitorSignedIn } from "@/features/publicLinks/queries/publicLink"
import { useIsOnline } from "@/lib/useIsOnline"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

// A public link's archive actions, for signed-in visitors only: the SDK lists, extracts and compresses
// through the authed client alone, with the anon-resolved file or `{dir, link}` as copy's "Save to Cloud
// Drive" does. Unlike that copy, none asks whose link it is: signed in and downloads allowed is enough.
// Nothing here renders under the anon preview access mode, and nothing reads before a click.

// The linked archive's contents. Its listings live in the page's ArchiveListingScope (publicLinkView.tsx),
// so hiding the contents or stepping between a directory link's files reopens a finished listing at once.
// `downloadable` is the link's own flag: browsing stays, extracting goes with it.
export function PublicArchiveBrowser({ source, downloadable }: { source: ArchiveSource; downloadable: boolean }) {
	return (
		<PreviewDownloadableProvider downloadable={downloadable}>
			<ArchiveSourceBrowser
				key={source.uuid}
				source={source}
			/>
		</PreviewDownloadableProvider>
	)
}

// A linked comic book, read page by page by any visitor through the public-link client's archive reader (its pages
// under the anon access mode, like any other inline preview). Extract to read, and Browse as archive for one with no
// page to show, are a signed-in visitor's, as the archive actions are.
export function PublicComic({
	item,
	source,
	linkScope,
	downloadable,
	onBrowse
}: {
	item: DriveItem
	source: ArchiveSource
	linkScope: string
	downloadable: boolean
	onBrowse: () => void
}) {
	const signedIn = usePublicVisitorSignedIn().data === true

	return (
		<PreviewAccessModeProvider
			mode="anon"
			linkScope={linkScope}
		>
			<PreviewDownloadableProvider downloadable={downloadable}>
				<ComicSourceViewer
					key={source.uuid}
					item={item}
					source={source}
					extractable={signedIn && downloadable}
					onBrowse={signedIn ? onBrowse : undefined}
				/>
			</PreviewDownloadableProvider>
		</PreviewAccessModeProvider>
	)
}

export interface PublicArchiveActionsProps {
	source: ArchiveSource
	// The link's own flag; without it the archive is browsed, never extracted.
	downloadable: boolean
	onBrowse: () => void
}

// The hero card's archive actions. Rendered by FileHero for an archive only, so no other file asks
// whether the visitor is signed in; until the cached answer says so there are none (Download only).
export function PublicArchiveActions({ source, downloadable, onBrowse }: PublicArchiveActionsProps) {
	const { t } = useTranslation("publicLinks")
	const signedIn = usePublicVisitorSignedIn()

	if (signedIn.data !== true) {
		return null
	}

	return (
		<>
			{downloadable ? <ExtractToDriveButton source={source} /> : null}
			<LinkActionButton
				icon={ListTreeIcon}
				label={t("archiveBrowse")}
				compact={false}
				onClick={onBrowse}
			/>
		</>
	)
}

export interface ExtractToDriveButtonProps {
	source: ArchiveSource
	// The slim bars' compact form: small, with the label only from sm up.
	compact?: boolean
}

// The whole archive into a new directory of the visitor's own drive, picked first; the extract then runs
// on with its own card and asks for a password only if the archive needs one.
export function ExtractToDriveButton({ source, compact }: ExtractToDriveButtonProps) {
	const { t } = useTranslation(["publicLinks", "archive"])
	const [open, setOpen] = useState(false)

	return (
		<>
			<LinkActionButton
				icon={ACTION_DEFS.extract.icon}
				label={t("extractToDrive")}
				compact={compact ?? false}
				onClick={() => {
					setOpen(true)
				}}
			/>
			{open ? (
				<MoveTargetDialog
					mode="pick"
					// An archive's contents may land anywhere.
					items={[]}
					pickLabels={{ title: t("archive:archiveExtractPickTitle"), confirm: t("archive:archiveExtractPickConfirm") }}
					// The pick starts the extract.
					startsWork
					onPick={destination => {
						void extractArchiveTo(source, destination)
					}}
					onClose={() => {
						setOpen(false)
					}}
				/>
			) : null}
		</>
	)
}

export interface SaveAsArchiveButtonProps {
	// A linked directory with its link (password state included), as the SDK compresses it.
	item: AnyItemWithContext
	name: string
	// The slim bars' compact form: small, with the label only from sm up.
	compact?: boolean
}

// The directory on screen compressed into an archive in the visitor's own drive, through the compress
// dialog (My Drive by default, never anything done to the link's items afterwards).
export function SaveAsArchiveButton({ item, name, compact }: SaveAsArchiveButtonProps) {
	const { t } = useTranslation("publicLinks")
	const [open, setOpen] = useState(false)

	return (
		<>
			<LinkActionButton
				icon={ACTION_DEFS.compress.icon}
				label={t("saveAsArchive")}
				compact={compact ?? false}
				onClick={() => {
					setOpen(true)
				}}
			/>
			{open ? (
				<CompressDialog
					subject={{ kind: "linked", items: [item], naming: [{ name, directory: true }] }}
					onClose={() => {
						setOpen(false)
					}}
				/>
			) : null}
		</>
	)
}

// Offline gated like "Save to Cloud Drive": each reads the link or starts a job in the visitor's drive.
function LinkActionButton({
	icon: Icon,
	label,
	compact,
	onClick
}: {
	icon: LucideIcon
	label: string
	compact: boolean
	onClick: () => void
}) {
	const { t } = useTranslation("common")
	const isOnline = useIsOnline()

	return (
		<Tooltip disabled={!compact}>
			<TooltipTrigger
				render={
					<Button
						variant="outline"
						size={compact ? "sm" : "default"}
						disabled={!isOnline}
						title={isOnline ? undefined : t("offlineActionDisabled")}
						aria-label={compact ? label : undefined}
						onClick={onClick}
					>
						<Icon data-icon="inline-start" />
						{compact ? <span className="hidden sm:inline">{label}</span> : label}
					</Button>
				}
			/>
			{/* Only while the label is shed. */}
			<TooltipContent className="sm:hidden">{label}</TooltipContent>
		</Tooltip>
	)
}

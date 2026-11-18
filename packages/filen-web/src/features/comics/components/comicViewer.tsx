import { useState } from "react"
import { useTranslation } from "react-i18next"
import { BookOpenIcon } from "lucide-react"
import { formatBytes } from "@filen/shared"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { useIsOnline } from "@/lib/useIsOnline"
import type { DriveItem } from "@/features/drive/lib/item"
import type { DriveVariant } from "@/features/drive/lib/preferences"
import { extractArchiveTo } from "@/features/drive/lib/archiveActions"
import { MoveTargetDialog } from "@/features/drive/components/moveTargetDialog"
import { archiveSourceOf, type ArchiveSource } from "@/features/archive/lib/archiveSource"
import { useArchiveListing } from "@/features/archive/components/useArchiveListing"
import { readsWholeArchive } from "@/features/archive/lib/archiveBrowser.logic"
import { ArchiveReading, ArchiveWaiting } from "@/features/archive/components/archiveStatus"
import { ArchivePasswordGate } from "@/features/archive/components/archivePasswordPrompt"
import { PreviewErrorState, PreviewLoading, PreviewUnsupportedState } from "@/features/preview/components/previewErrorState"
import { COMIC_SOLID_BLOCK_MAX_BYTES, comicPages, largestSolidBlock } from "@/features/comics/lib/pages.logic"
import { ComicPager } from "@/features/comics/components/comicPager"
import { Button } from "@/components/ui/button"

// A comic book (.cbz, .cbr, .cb7, .cbt) in the preview overlay: listed as the archive browser lists it (its gate, its
// password, the host's listing cache, the reader its pages are read through), then read page by page.
export function ComicViewer({ item, variant }: { item: DriveItem; variant: DriveVariant }) {
	const source = archiveSourceOf(item, variant)

	return (
		<ComicSourceViewer
			key={source.uuid}
			item={item}
			source={source}
		/>
	)
}

function ComicSourceViewer({ item, source }: { item: DriveItem; source: ArchiveSource }) {
	const { t } = useTranslation(["preview", "common"])
	const isOnline = useIsOnline()
	const listing = useArchiveListing(source)
	const { phase, store, info } = listing.snapshot
	const stop = (): void => {
		listing.session()?.stop()
	}

	switch (phase.type) {
		case "resolving":
		case "starting":
			return <PreviewLoading />
		case "waiting":
			return <ArchiveWaiting onCancel={stop} />
		case "reading":
			return (
				<ArchiveReading
					phase={phase}
					wholeArchive={readsWholeArchive(info?.format ?? null)}
					onStop={stop}
				/>
			)
		case "gate":
			return (
				<div className="flex size-full flex-col items-center justify-center gap-4 px-6 text-center">
					<BookOpenIcon
						aria-hidden="true"
						className="size-10 text-muted-foreground"
					/>
					<p className="max-w-sm text-sm text-muted-foreground">
						{t("previewArchiveGateBody", { size: formatBytes(source.size) })}
					</p>
					<Button
						disabled={!isOnline}
						title={isOnline ? undefined : t("common:offlineActionDisabled")}
						onClick={() => {
							listing.session()?.start()
						}}
					>
						{t("previewComicRead")}
					</Button>
				</div>
			)
		case "needsPassword":
			return (
				<ArchivePasswordGate
					name={source.name}
					wrong={phase.wrong}
					onSubmit={password => {
						listing.session()?.submitPassword(password)
					}}
				/>
			)
		case "failed":
			return (
				<PreviewErrorState
					message={errorLabel(phase.error)}
					onRetry={() => {
						listing.session()?.retry()
					}}
				/>
			)
		case "stopped":
			return (
				<PreviewErrorState
					message={t("previewArchiveNotListed")}
					onRetry={() => {
						listing.session()?.retry()
					}}
				/>
			)
		case "done":
			break
	}

	const pages = comicPages(store)

	if (pages.length === 0) {
		return (
			<PreviewUnsupportedState
				item={item}
				message={t("previewComicNoPages")}
			/>
		)
	}

	if (largestSolidBlock(store, pages) > COMIC_SOLID_BLOCK_MAX_BYTES) {
		return (
			<PreviewUnsupportedState
				item={item}
				message={t("previewComicTooLarge")}
				secondary={<ExtractToRead source={source} />}
			/>
		)
	}

	return (
		<ComicPager
			source={source}
			store={store}
			pages={pages}
			session={listing.session}
		/>
	)
}

// The comic into a directory of the user's drive, picked first; the extract then runs on with its own card.
function ExtractToRead({ source }: { source: ArchiveSource }) {
	const { t } = useTranslation(["preview", "archive", "common"])
	const isOnline = useIsOnline()
	const [open, setOpen] = useState(false)

	return (
		<>
			<Button
				variant="outline"
				disabled={!isOnline}
				title={isOnline ? undefined : t("common:offlineActionDisabled")}
				onClick={() => {
					setOpen(true)
				}}
			>
				{t("previewComicExtractToRead")}
			</Button>
			{open ? (
				<MoveTargetDialog
					mode="pick"
					items={[]}
					pickLabels={{ title: t("archive:archiveExtractPickTitle"), confirm: t("archive:archiveExtractPickConfirm") }}
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

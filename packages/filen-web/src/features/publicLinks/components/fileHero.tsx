import { useState } from "react"
import { useTranslation } from "react-i18next"
import { formatBytes, driveItemName } from "@filen/shared"
import { ArrowLeftIcon, ChevronLeftIcon, ChevronRightIcon, DownloadIcon, EyeIcon, EyeOffIcon, PlayIcon } from "lucide-react"
import type { AnyFile, AnyItemWithContext } from "@filen/sdk-rs"
import { asDirectoryOrFile, type DriveItem } from "@/features/drive/lib/item"
import { narrowToAnyFile } from "@/features/drive/lib/download"
import { ItemIcon } from "@/features/drive/components/itemIcon"
import { MiddleEllipsis } from "@/components/middleEllipsis"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Spinner } from "@/components/ui/spinner"
import type { ErrorDTO } from "@/lib/sdk/errors"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { anonPreviewability } from "@/features/publicLinks/lib/download.logic"
import { useDeviceProfile } from "@/lib/useDeviceProfile"
import { useFileKindVerdict } from "@/features/drive/hooks/useFileKindVerdict"
import { startAnonFileDownload } from "@/features/publicLinks/lib/download"
import { linkedArchiveSource } from "@/features/archive/lib/archiveSource"
import { PublicPreview } from "@/features/publicLinks/components/publicPreview"
import type { ReferenceSourceFactory } from "@/features/preview/lib/referenceResolver"
import { SaveToDriveButton } from "@/features/publicLinks/components/saveToDrive"
import { PublicArchiveActions, PublicArchiveBrowser, PublicComic } from "@/features/publicLinks/components/publicArchive"
import { DownloadTooLargeNote } from "@/features/publicLinks/components/publicLinkStates"
import { OUTSIDE_OVERLAYS, useAction } from "@/lib/keymap/useAction"
import { Kbd } from "@/lib/keymap/kbd"
import { TooltipIconButton } from "@/components/ui/tooltipIconButton"
import type { Slideshow } from "@/features/preview/hooks/useSlideshow"
import { SlideshowBar } from "@/features/preview/components/slideshowBar"
import { slideKindOf } from "@/features/preview/lib/slideshow.logic"

type DownloadUiState =
	| { status: "idle" }
	| { status: "running"; loaded: number; total: number | null }
	| { status: "too-large" }
	| { status: "error"; dto: ErrorDTO }

const IDLE: DownloadUiState = { status: "idle" }

// The steps through a directory link's files (‹ ›) and its slideshow (▶), from the page that holds its listing.
export interface HeroPager {
	canPrevious: boolean
	canNext: boolean
	step: (delta: -1 | 1) => void
	slideshow: Slideshow
	// Over at least two slides.
	slideshowOffered: boolean
	// Inside the click (full screen is entered there).
	startSlideshow: () => void
	subfolders: { available: boolean; loading: boolean }
	onSubfoldersChange: (on: boolean) => void
}

// The file surface, shared by the /f/ route and the in-directory child file view. Given a resolved
// DriveItem (fabricated from a LinkedFile or narrowed from a listing File) it shows a hero card —
// icon, name, size/type — with a flag-gated Download and, when the file is previewable within the
// memory cap, an inline preview (auto-invoked). An archive never opens on its own: a signed-in visitor
// gets "Browse contents" and, downloads allowed, "Extract to my Cloud Drive" (publicArchive.tsx); a
// signed-out one only Download. `onBack` is present only for the in-dir child view (returns to the
// listing); the /f/ route omits it. `downloadEnabled` is the link's own flag (a file link's downloadable,
// a directory link's enableDownload); without it the preview stays and nothing offers to save the file.
// `linkScope` fingerprints the link's key and password, scoping the bytes the preview loads so Download
// can reuse them. `pager` (a directory link's files only, never a single file's link) steps to the next file in place,
// the state of a download or an archive's contents staying with the file it was started on.
export function FileHero({
	item,
	downloadEnabled,
	linkScope,
	onBack,
	saveItem,
	archiveFile,
	siblings,
	references,
	pager
}: {
	item: DriveItem
	downloadEnabled: boolean
	linkScope: string
	onBack?: () => void
	// Offers "Save to Cloud Drive" when present (a signed-in visitor on a saveable link).
	saveItem?: AnyItemWithContext | undefined
	// The file as the SDK resolved it (the LinkedFile, or the directory listing's File), which an archive's
	// browser and extract read through.
	archiveFile?: AnyFile | undefined
	// The other files of its directory (a video's subtitles are among them).
	siblings?: readonly DriveItem[] | undefined
	// Where a model's referenced files are found (a directory link's listings).
	references?: ReferenceSourceFactory | undefined
	pager?: HeroPager | undefined
}) {
	const { t } = useTranslation(["publicLinks", "preview"])
	const base = asDirectoryOrFile(item)
	const uuid = base.data.uuid
	const name = base.type === "file" ? driveItemName(base) : base.data.uuid
	const size = base.data.size
	// A probe that resolves later (a HEIC this browser shows by itself) may make the file previewable, and the preview's
	// read of its content may find nothing it shows (an Illustrator file without a PDF inside): the card then.
	const verdict = useFileKindVerdict(base.type === "file" ? base.data.uuid : undefined)
	const previewability = anonPreviewability(item, useDeviceProfile(), verdict ?? null)
	const [previewHidden, setPreviewHidden] = useState(false)
	// Both kept with the file they are for, so a step shows the next file's own.
	const [contentsOf, setContentsOf] = useState<string | null>(null)
	const [downloadOf, setDownloadOf] = useState<{ uuid: string; ui: DownloadUiState } | null>(null)
	const showContents = contentsOf === uuid
	const download = downloadOf?.uuid === uuid ? downloadOf.ui : IDLE
	const running = pager?.slideshow.running === true
	const archiveSource =
		(previewability === "archive" || previewability === "comic") && archiveFile !== undefined
			? linkedArchiveSource(item, archiveFile)
			: null
	// A comic is read inline, as a preview, through the archive's own reader.
	const previewable = previewability === "previewable" || (previewability === "comic" && archiveSource !== null)
	// Contents only ever open from "Browse contents" (or a comic's "Browse as archive"), which a signed-in visitor alone is
	// offered.
	// A running slideshow shows each slide it may preview, whatever the preview was left at; one too large shows its card
	// (the slideshow moves on from it in time).
	const pane =
		running && previewable && slideKindOf(item) !== null
			? "preview"
			: showContents && archiveSource !== null
				? "contents"
				: !previewHidden && previewable
					? "preview"
					: null

	function setShowContents(show: boolean): void {
		setContentsOf(show ? uuid : null)
	}

	// No bar until the download reports a share: a buffered one reports none before it is done, and an
	// empty bar standing there the whole time reads as stuck.
	function handleDownload(): void {
		const forUuid = uuid

		setDownloadOf({ uuid: forUuid, ui: { status: "running", loaded: 0, total: null } })

		void startAnonFileDownload({
			file: narrowToAnyFile(item),
			name,
			size,
			linkScope,
			onProgress: (loaded, total) => {
				settle(forUuid, prev => (prev.status === "running" ? { status: "running", loaded, total } : prev))
			}
		}).then(outcome => {
			if (outcome.status === "too-large") {
				settle(forUuid, () => ({ status: "too-large" }))
			} else if (outcome.status === "error") {
				const { dto } = outcome

				settle(forUuid, () => ({ status: "error", dto }))
			} else {
				// success OR a picker cancel — both return to the resting state (a cancel is a clean no-op).
				settle(forUuid, () => IDLE)
			}
		})
	}

	// A download's progress and outcome, only while it is still the one on record (another file's did not replace it).
	function settle(forUuid: string, update: (prev: DownloadUiState) => DownloadUiState): void {
		setDownloadOf(prev => (prev?.uuid === forUuid ? { uuid: forUuid, ui: update(prev.ui) } : prev))
	}

	// Def in features/publicLinks/lib/keymap.ts: Download, under the buttons' gate, in place of the browser's Save Page.
	useAction(
		"links.download",
		event => {
			event.preventDefault()

			if (download.status !== "running") {
				handleDownload()
			}
		},
		{ ...OUTSIDE_OVERLAYS, enabled: downloadEnabled },
		[download.status, item, name, size, linkScope]
	)

	const downloadButton = downloadEnabled ? (
		<Button
			onClick={handleDownload}
			disabled={download.status === "running"}
		>
			{download.status === "running" ? <Spinner data-icon="inline-start" /> : <DownloadIcon data-icon="inline-start" />}
			{download.status === "running" ? t("downloading") : t("download")}
		</Button>
	) : null

	// Preview or contents mode: a slim top bar (back / name / actions) over the inline viewer or the
	// archive's browser filling the rest of the shell's pinned content area, which the viewers size to.
	// A running slideshow covers the page (and fills the full screen it entered) with the slide alone and its bar.
	const bar =
		pager !== undefined && running ? (
			<SlideshowBar
				slideshow={pager.slideshow}
				subfolders={pager.subfolders}
				onSubfoldersChange={pager.onSubfoldersChange}
			/>
		) : null
	const steps =
		pager === undefined ? null : (
			<>
				<TooltipIconButton
					label={t("preview:previewPreviousAction")}
					disabled={!pager.canPrevious}
					shortcut={<Kbd action="preview.prev" />}
					onClick={() => {
						pager.step(-1)
					}}
				>
					<ChevronLeftIcon />
				</TooltipIconButton>
				<TooltipIconButton
					label={t("preview:previewNextAction")}
					disabled={!pager.canNext}
					shortcut={<Kbd action="preview.next" />}
					onClick={() => {
						pager.step(1)
					}}
				>
					<ChevronRightIcon />
				</TooltipIconButton>
			</>
		)

	if (pane !== null) {
		return (
			<div className={running ? "fixed inset-0 z-50 flex flex-col bg-background" : "flex min-h-0 flex-1 flex-col"}>
				{running ? null : (
					<div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3 sm:px-4">
						{onBack !== undefined && (
							<Button
								variant="ghost"
								size="icon-sm"
								onClick={onBack}
								aria-label={t("backToDirectory")}
							>
								<ArrowLeftIcon />
							</Button>
						)}
						<div className="flex min-w-0 flex-1 flex-col">
							<MiddleEllipsis
								value={name}
								start={28}
								end={12}
								className="truncate text-sm font-medium"
							/>
							{download.status === "error" || download.status === "too-large" ? (
								<DownloadOutcome
									download={download}
									compact
								/>
							) : (
								<span className="text-xs text-muted-foreground">{formatBytes(Number(size))}</span>
							)}
						</div>
						{steps}
						{pager?.slideshowOffered === true ? (
							<TooltipIconButton
								label={t("preview:previewSlideshowStart")}
								shortcut={<Kbd action="preview.slideshow" />}
								onClick={pager.startSlideshow}
							>
								<PlayIcon />
							</TooltipIconButton>
						) : null}
						<Button
							variant="ghost"
							size="sm"
							aria-label={pane === "contents" ? t("archiveHideContents") : t("hidePreview")}
							onClick={() => {
								setPreviewHidden(true)
								setShowContents(false)
							}}
						>
							<EyeOffIcon data-icon="inline-start" />
							<span className="hidden sm:inline">{pane === "contents" ? t("archiveHideContents") : t("hidePreview")}</span>
						</Button>
						{saveItem !== undefined && (
							<SaveToDriveButton
								item={saveItem}
								name={name}
								glyph="file"
								compact
							/>
						)}
						{downloadEnabled && (
							<Button
								variant="outline"
								size="sm"
								aria-label={download.status === "running" ? t("downloading") : t("download")}
								onClick={handleDownload}
								disabled={download.status === "running"}
							>
								{download.status === "running" ? (
									<Spinner data-icon="inline-start" />
								) : (
									<DownloadIcon data-icon="inline-start" />
								)}
								<span className="hidden sm:inline">{download.status === "running" ? t("downloading") : t("download")}</span>
							</Button>
						)}
					</div>
				)}
				<DownloadProgress
					download={download}
					className="shrink-0"
				/>
				{/* Each file's viewer mounts afresh; the stage stays, and the bar on it. */}
				<div className="relative min-h-0 flex-1">
					{pane === "contents" && archiveSource !== null ? (
						<PublicArchiveBrowser
							key={uuid}
							source={archiveSource}
							downloadable={downloadEnabled}
						/>
					) : previewability === "comic" && archiveSource !== null ? (
						<PublicComic
							key={uuid}
							item={item}
							source={archiveSource}
							linkScope={linkScope}
							downloadable={downloadEnabled}
							onBrowse={() => {
								setShowContents(true)
							}}
						/>
					) : (
						<PublicPreview
							key={uuid}
							item={item}
							linkScope={linkScope}
							downloadable={downloadEnabled}
							siblings={siblings}
							references={references}
							slot={running ? pager.slideshow.slot : undefined}
						/>
					)}
					{bar}
				</div>
			</div>
		)
	}

	// Hero card: icon, name, size/type, and the actions.
	// A slideshow paged by hand onto a file it does not show keeps its bar here.
	return (
		<div
			className={
				running
					? "fixed inset-0 z-50 flex items-center justify-center bg-background p-6"
					: "flex flex-1 items-center justify-center p-6"
			}
		>
			<div className="flex w-full max-w-md flex-col items-center gap-5 text-center">
				<ItemIcon
					item={item}
					className="size-20"
				/>
				<div className="flex w-full flex-col items-center gap-1">
					<MiddleEllipsis
						value={name}
						start={32}
						end={12}
						className="max-w-full text-lg font-semibold break-all"
					/>
					<p className="text-sm text-muted-foreground">
						{formatBytes(Number(size))} · {t("fileLabel")}
					</p>
				</div>

				<div className="flex flex-wrap items-center justify-center gap-2">
					{steps}
					{downloadButton}
					{saveItem !== undefined && (
						<SaveToDriveButton
							item={saveItem}
							name={name}
							glyph="file"
						/>
					)}
					{archiveSource !== null && (
						<PublicArchiveActions
							source={archiveSource}
							downloadable={downloadEnabled}
							onBrowse={() => {
								setShowContents(true)
							}}
						/>
					)}
					{previewable && (
						<Button
							variant="outline"
							onClick={() => {
								setPreviewHidden(false)
							}}
						>
							<EyeIcon data-icon="inline-start" />
							{t("preview")}
						</Button>
					)}
					{onBack !== undefined && (
						<Button
							variant="ghost"
							onClick={onBack}
						>
							<ArrowLeftIcon data-icon="inline-start" />
							{t("backToDirectory")}
						</Button>
					)}
				</div>

				{previewability === "too-large" && (
					<div className="flex flex-col gap-1">
						<p className="text-sm font-medium">{t("previewTooLargeTitle")}</p>
						<p className="text-sm text-muted-foreground">{t("previewTooLargeBody")}</p>
					</div>
				)}
				{!downloadEnabled && <p className="text-sm text-muted-foreground">{t("downloadDisabled")}</p>}
				<DownloadOutcome
					download={download}
					compact={false}
				/>
				<DownloadProgress
					download={download}
					className="w-full max-w-xs"
				/>
			</div>
			{bar}
		</div>
	)
}

// A finished download's outcome, the same in both layouts: a full note on the card, one truncating line (its whole
// text in the title) in the preview's bar. Mounted with its text, so an alert, which is announced on mount.
function DownloadOutcome({ download, compact }: { download: DownloadUiState; compact: boolean }) {
	const { t } = useTranslation("publicLinks")

	if (download.status === "too-large") {
		return (
			<DownloadTooLargeNote
				message={t("downloadTooLarge")}
				compact={compact}
			/>
		)
	}

	if (download.status !== "error") {
		return null
	}

	const text = `${t("downloadFailed")} ${errorLabel(download.dto)}`

	return compact ? (
		<span
			role="alert"
			className="truncate text-xs text-destructive"
			title={text}
		>
			{text}
		</span>
	) : (
		<p
			role="alert"
			className="text-sm text-destructive"
		>
			{text}
		</p>
	)
}

// A running download's share, once it reports one (see handleDownload).
function DownloadProgress({ download, className }: { download: DownloadUiState; className: string }) {
	const { t } = useTranslation("publicLinks")

	if (download.status !== "running" || download.total === null || download.total <= 0) {
		return null
	}

	return (
		<Progress
			aria-label={t("downloading")}
			className={className}
			value={Math.round((download.loaded / download.total) * 100)}
		/>
	)
}

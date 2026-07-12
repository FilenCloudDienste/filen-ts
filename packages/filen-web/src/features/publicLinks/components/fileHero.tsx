import { useState } from "react"
import { useTranslation } from "react-i18next"
import { formatBytes } from "@filen/utils"
import { ArrowLeftIcon, DownloadIcon, EyeIcon, EyeOffIcon } from "lucide-react"
import { asDirectoryOrFile, type DriveItem } from "@/features/drive/lib/item"
import { narrowToAnyFile } from "@/features/drive/lib/download"
import { ItemIcon } from "@/features/drive/components/itemIcon"
import { MiddleEllipsis } from "@/components/middleEllipsis"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Spinner } from "@/components/ui/spinner"
import { anonPreviewability } from "@/features/publicLinks/lib/download.logic"
import { startAnonFileDownload } from "@/features/publicLinks/lib/download"
import { PublicPreview } from "@/features/publicLinks/components/publicPreview"

type DownloadUiState =
	{ status: "idle" } | { status: "running"; loaded: number; total: number | null } | { status: "too-large" } | { status: "error" }

// The file surface, shared by the /f/ route and the in-directory child file view. Given a resolved
// DriveItem (fabricated from a LinkedFile or narrowed from a listing File) it shows a hero card —
// icon, name, size/type — with a flag-gated Download and, when the file is previewable within the
// memory cap, an inline preview (auto-invoked). `onBack` is present only for the in-dir child view
// (returns to the listing); the /f/ route omits it. `downloadEnabled` is the link's own flag (a file
// link always allows download; a dir link carries enableDownload).
export function FileHero({ item, downloadEnabled, onBack }: { item: DriveItem; downloadEnabled: boolean; onBack?: () => void }) {
	const { t } = useTranslation("publicLinks")
	const base = asDirectoryOrFile(item)
	const name = base.type === "file" ? (base.data.decryptedMeta?.name ?? base.data.uuid) : base.data.uuid
	const size = base.data.size
	const previewability = anonPreviewability(item)
	const [showPreview, setShowPreview] = useState(previewability === "previewable")
	const [download, setDownload] = useState<DownloadUiState>({ status: "idle" })

	function handleDownload(): void {
		setDownload({ status: "running", loaded: 0, total: Number(size) })

		void startAnonFileDownload({
			file: narrowToAnyFile(item),
			name,
			size,
			onProgress: (loaded, total) => {
				setDownload(prev => (prev.status === "running" ? { status: "running", loaded, total } : prev))
			}
		}).then(outcome => {
			if (outcome.status === "too-large") {
				setDownload({ status: "too-large" })
			} else if (outcome.status === "error") {
				setDownload({ status: "error" })
			} else {
				// success OR a picker cancel — both return to the resting state (a cancel is a clean no-op).
				setDownload({ status: "idle" })
			}
		})
	}

	const downloadButton = downloadEnabled ? (
		<Button
			onClick={handleDownload}
			disabled={download.status === "running"}
		>
			{download.status === "running" ? <Spinner data-icon="inline-start" /> : <DownloadIcon data-icon="inline-start" />}
			{download.status === "running" ? t("downloading") : t("download")}
		</Button>
	) : null

	// Preview mode: a slim top bar (back / name / actions) over the inline viewer filling the rest.
	if (showPreview && previewability === "previewable") {
		return (
			<div className="flex flex-1 flex-col">
				<div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3 sm:px-4">
					{onBack !== undefined && (
						<Button
							variant="ghost"
							size="icon-sm"
							onClick={onBack}
							aria-label={t("back")}
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
						<span className="text-xs text-muted-foreground">{formatBytes(Number(size))}</span>
					</div>
					<Button
						variant="ghost"
						size="sm"
						onClick={() => {
							setShowPreview(false)
						}}
					>
						<EyeOffIcon data-icon="inline-start" />
						<span className="hidden sm:inline">{t("hidePreview")}</span>
					</Button>
					{downloadEnabled && (
						<Button
							variant="outline"
							size="sm"
							onClick={handleDownload}
							disabled={download.status === "running"}
						>
							<DownloadIcon data-icon="inline-start" />
							<span className="hidden sm:inline">{t("download")}</span>
						</Button>
					)}
				</div>
				<div className="min-h-0 flex-1">
					<PublicPreview item={item} />
				</div>
			</div>
		)
	}

	// Hero card: icon, name, size/type, and the actions.
	return (
		<div className="flex flex-1 items-center justify-center p-6">
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
					{downloadButton}
					{previewability === "previewable" && (
						<Button
							variant="outline"
							onClick={() => {
								setShowPreview(true)
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
							{t("back")}
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
				{download.status === "too-large" && <p className="text-sm text-destructive">{t("downloadTooLarge")}</p>}

				{download.status === "running" && (
					<div className="flex w-full max-w-xs flex-col gap-1">
						<Progress
							value={
								download.total !== null && download.total > 0 ? Math.round((download.loaded / download.total) * 100) : null
							}
						/>
					</div>
				)}
			</div>
		</div>
	)
}

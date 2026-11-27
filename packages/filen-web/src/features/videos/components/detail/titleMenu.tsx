import { useTranslation } from "react-i18next"
import { useNavigate } from "@tanstack/react-router"
import { toast } from "sonner"
import { DownloadIcon, EyeIcon, EyeOffIcon, FolderSearchIcon, LayersIcon, MoreHorizontalIcon, PencilIcon, TagIcon } from "lucide-react"
import { log } from "@/lib/log"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { downloadVideoFile, revealVideoFile } from "@/features/videos/lib/titleActions"
import { hideEdit, type CorrectionKind } from "@/features/videos/lib/corrections.logic"
import { SetAsEntries } from "@/features/videos/components/setAsMenu"
import { editLibraryConfig } from "@/features/videos/queries/library"
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"
import type { VideoTitleView } from "@/workers/videoIndex/view.logic"

// A detail page's More menu: Versions (only with two or more), Reveal in Drive and Download for the chosen file,
// then the manual corrections: Edit details, Set as (a movie or another video; not a series) and Hide / Unhide.
export function TitleMenu({
	title,
	overrideKey,
	fileStableUuid,
	versions,
	version,
	onVersion,
	onEdit,
	onSetAs
}: {
	title: VideoTitleView
	overrideKey: string
	fileStableUuid: string | null
	versions: readonly { value: string; label: string }[] | null
	version: string
	onVersion: (value: string) => void
	onEdit: () => void
	onSetAs?: ((kind: CorrectionKind) => void) | undefined
}) {
	const { t } = useTranslation("videos")
	const navigate = useNavigate()
	const hidden = title.hidden === true

	function missing(): void {
		toast.error(t("detailFileGone"))
	}

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<Button
						variant="ghost"
						size="icon"
						aria-label={t("detailMenu", { title: title.title })}
					>
						<MoreHorizontalIcon />
					</Button>
				}
			/>
			<DropdownMenuContent align="end">
				{versions === null ? null : (
					<DropdownMenuSub>
						<DropdownMenuSubTrigger>
							<LayersIcon />
							{t("detailVersions")}
						</DropdownMenuSubTrigger>
						<DropdownMenuSubContent>
							<DropdownMenuRadioGroup
								value={version}
								onValueChange={(value: string) => {
									onVersion(value)
								}}
							>
								{versions.map(option => (
									<DropdownMenuRadioItem
										key={option.value}
										value={option.value}
									>
										{option.label}
									</DropdownMenuRadioItem>
								))}
							</DropdownMenuRadioGroup>
						</DropdownMenuSubContent>
					</DropdownMenuSub>
				)}
				{fileStableUuid === null ? null : (
					<>
						<DropdownMenuItem
							onClick={() => {
								revealVideoFile(fileStableUuid, target => {
									void navigate(target)
								})
									.then(found => {
										if (!found) {
											missing()
										}
									})
									.catch((e: unknown) => {
										toast.error(errorLabel(e))
									})
							}}
						>
							<FolderSearchIcon />
							{t("detailRevealInDrive")}
						</DropdownMenuItem>
						<DropdownMenuItem
							onClick={() => {
								downloadVideoFile(fileStableUuid)
									.then(found => {
										if (!found) {
											missing()
										}
									})
									.catch((e: unknown) => {
										toast.error(errorLabel(e))
									})
							}}
						>
							<DownloadIcon />
							{t("detailDownload")}
						</DropdownMenuItem>
						<DropdownMenuSeparator />
					</>
				)}
				<DropdownMenuItem onClick={onEdit}>
					<PencilIcon />
					{t("detailEdit")}
				</DropdownMenuItem>
				{onSetAs === undefined || title.kind === "series" ? null : (
					<DropdownMenuSub>
						<DropdownMenuSubTrigger>
							<TagIcon />
							{t("setAsMenu")}
						</DropdownMenuSubTrigger>
						<DropdownMenuSubContent>
							<SetAsEntries
								current={title.kind}
								onSetAs={onSetAs}
							/>
						</DropdownMenuSubContent>
					</DropdownMenuSub>
				)}
				<DropdownMenuItem
					onClick={() => {
						editLibraryConfig(hideEdit(overrideKey, !hidden)).catch((e: unknown) => {
							log.warn("videos.detail", "hiding failed", e)
							toast.error(errorLabel(e))
						})
					}}
				>
					{hidden ? <EyeIcon /> : <EyeOffIcon />}
					{hidden ? t("detailUnhide") : t("detailHide")}
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

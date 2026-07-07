import { useTranslation } from "react-i18next"
import { FolderClosedIcon } from "lucide-react"
import { type DriveVariant } from "@/lib/drive/preferences"
import { useDirectoryListingQuery } from "@/queries/drive"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { asErrorDTO } from "@/lib/sdk/errors"
import { Breadcrumb } from "@/components/drive/breadcrumb"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"

export interface DirectoryListingProps {
	variant: DriveVariant
	uuid: string | null
}

// Every drive route (drive.tsx, drive_.$uuid.tsx, recents/favorites/trash.tsx) renders this one
// container with its own {variant,uuid} — the single place the placeholder body is swapped for the
// real virtualized list, so no route needs to change again when it does.
export function DirectoryListing({ variant, uuid }: DirectoryListingProps) {
	const { t } = useTranslation(["drive", "common"])
	const listingQuery = useDirectoryListingQuery(variant, uuid)

	return (
		<>
			<header className="flex h-14 shrink-0 items-center border-b border-border px-4">
				<Breadcrumb
					variant={variant}
					uuid={uuid}
				/>
			</header>
			<div className="flex flex-1 flex-col overflow-y-auto p-6">
				{listingQuery.status === "pending" ? (
					<div className="flex flex-col gap-2">
						<Skeleton className="h-10 w-full rounded-xl" />
						<Skeleton className="h-10 w-full rounded-xl" />
						<Skeleton className="h-10 w-full rounded-xl" />
					</div>
				) : listingQuery.status === "error" ? (
					<Empty>
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<FolderClosedIcon />
							</EmptyMedia>
							<EmptyTitle>{t("driveLoadError")}</EmptyTitle>
							<EmptyDescription>{errorLabel(asErrorDTO(listingQuery.error))}</EmptyDescription>
						</EmptyHeader>
						<EmptyContent>
							<Button
								variant="outline"
								onClick={() => {
									void listingQuery.refetch()
								}}
							>
								{t("common:tryAgain")}
							</Button>
						</EmptyContent>
					</Empty>
				) : listingQuery.data.length === 0 ? (
					<Empty>
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<FolderClosedIcon />
							</EmptyMedia>
							<EmptyTitle>{t("driveEmptyTitle")}</EmptyTitle>
							<EmptyDescription>{t("driveEmptyBody")}</EmptyDescription>
						</EmptyHeader>
					</Empty>
				) : (
					<p className="text-sm text-muted-foreground">{t("driveItemCount", { count: listingQuery.data.length })}</p>
				)}
			</div>
		</>
	)
}

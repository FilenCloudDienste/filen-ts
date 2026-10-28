import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { ImagesIcon } from "lucide-react"
import { asErrorDTO } from "@/lib/sdk/errors"
import { log } from "@/lib/log"
import { useIsOnline } from "@/lib/useIsOnline"
import { useDirectoryNamesQuery } from "@/features/drive/queries/drive"
import { useAccountQuery } from "@/queries/account"
import { usePhotosTimeline } from "@/features/photos/queries/photos"
import { loadPhotosLibrary, removePhotosRoot, usePhotosLibrary } from "@/features/photos/lib/library"
import { shouldResetRootOnError } from "@/features/photos/lib/root"
import { PHOTOS_CHOOSE_ACTION_ID } from "@/features/photos/lib/focusTargets"
import { usePhotosRootViews } from "@/features/photos/hooks/usePhotosRootViews"
import { DirectoryChooserDialog } from "@/features/photos/components/directoryChooserDialog"
import { PhotosDirectoriesDialog } from "@/features/photos/components/directoriesDialog"
import { PhotoGrid } from "@/features/photos/components/photoGrid"
import { PhotosDensityControls } from "@/features/photos/components/densityControls"
import { EmptyState } from "@/features/drive/components/emptyState"
import { LoadingState } from "@/components/loadingState"
import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"

const NO_ROOTS: readonly string[] = []

// Root selection + persistence + unset/ready/gone states, reachable from the icon rail's own
// /photos entry (iconRail.tsx). READY renders the grid (search, filters and timeline live there) over every
// photos directory at once.
export function PhotosScreen() {
	const { t } = useTranslation(["photos", "common", "drive"])
	const isOnline = useIsOnline()
	const library = usePhotosLibrary()
	const roots = library.roots ?? NO_ROOTS
	const [dialog, setDialog] = useState<"directories" | "chooser" | null>(null)
	// Roots whose removal after going gone is under way, so one errored settle (and the re-renders while its
	// removal runs) removes each once. A ref, not state: it is never read during render, only inside the effect.
	const resettingRef = useRef(new Set<string>())

	useEffect(() => {
		void loadPhotosLibrary()
	}, [])

	// The whole drive is a valid photos root; it has no name to resolve, only the drive's own label.
	const driveRootUuid = useAccountQuery().data?.rootDirUuid
	const [singleRoot] = roots.length === 1 ? roots : []
	const isWholeDrive = singleRoot !== undefined && singleRoot === driveRootUuid
	const namesQuery = useDirectoryNamesQuery(singleRoot !== undefined && !isWholeDrive ? [singleRoot] : [])
	const { timeline, listedRoots, failures, retry } = usePhotosTimeline(roots)
	const rootViews = usePhotosRootViews(roots, dialog !== null)

	// Root-gone detection, per root: an error whose message matches DIRECTORY_NOT_FOUND_PREFIX (isRootGoneError,
	// features/photos/lib/root.ts) AND the tab believes it's online (shouldResetRootOnError's defense-in-depth
	// second gate) drops that root from the library — a transient network failure, or the same error while offline,
	// leaves it untouched so a flaky fetch can never remove it.
	useEffect(() => {
		for (const { rootUuid, error } of failures) {
			if (resettingRef.current.has(rootUuid) || !shouldResetRootOnError(asErrorDTO(error), isOnline)) {
				continue
			}

			resettingRef.current.add(rootUuid)

			void removePhotosRoot(rootUuid).then(
				() => {
					resettingRef.current.delete(rootUuid)
					toast.error(t("photosRootGoneToast"))
				},
				(e: unknown) => {
					resettingRef.current.delete(rootUuid)
					log.warn("photos.library", "gone root not removed", e)
				}
			)
		}
	}, [failures, isOnline, t])

	function closeDialog(): void {
		setDialog(null)
	}

	const dialogs =
		dialog === "directories" ? (
			<PhotosDirectoriesDialog
				roots={rootViews}
				readOnly={library.readOnly}
				onClose={closeDialog}
			/>
		) : dialog === "chooser" ? (
			<DirectoryChooserDialog
				roots={rootViews}
				readOnly={library.readOnly}
				onClose={closeDialog}
			/>
		) : null

	if (library.roots === null) {
		return <LoadingState size="lg" />
	}

	if (roots.length === 0) {
		return (
			<>
				<div className="flex flex-1 overflow-y-auto">
					<Empty>
						<EmptyHeader>
							<EmptyMedia>
								<ImagesIcon />
							</EmptyMedia>
							<EmptyTitle>{t("photosUnsetTitle")}</EmptyTitle>
							<EmptyDescription>{t("photosUnsetBody")}</EmptyDescription>
						</EmptyHeader>
						<EmptyContent>
							<Button
								id={PHOTOS_CHOOSE_ACTION_ID}
								onClick={() => {
									setDialog("chooser")
								}}
							>
								{t("photosChooseDirectory")}
							</Button>
						</EmptyContent>
					</Empty>
				</div>
				{dialogs}
			</>
		)
	}

	// One root keeps its name (unknown until the name lookup settles: the header then shows the module name
	// alone); several are counted.
	const rootsLabel =
		singleRoot === undefined
			? t("photosHeaderDirectories", { count: roots.length })
			: isWholeDrive
				? t("drive:driveMyDrive")
				: namesQuery.data?.[singleRoot]

	return (
		<>
			<header className="flex h-14 shrink-0 items-center justify-between gap-3 px-4 app-region-chrome">
				<h1 className="flex min-w-0 items-baseline gap-1.5 text-sm font-medium">
					<span className="shrink-0">{t("common:modulePhotos")}</span>
					{rootsLabel === undefined ? null : (
						<>
							<span
								aria-hidden="true"
								className="text-muted-foreground"
							>
								·
							</span>
							<span className="truncate font-normal text-muted-foreground">{rootsLabel}</span>
						</>
					)}
				</h1>
				<div className="flex shrink-0 items-center gap-2">
					{timeline.status === "success" && timeline.listing.photos.length > 0 ? <PhotosDensityControls /> : null}
					<Button
						variant="outline"
						size="sm"
						onClick={() => {
							setDialog("directories")
						}}
					>
						{t("photosDirectoriesButton")}
					</Button>
				</div>
			</header>
			<div className="flex min-h-0 flex-1 flex-col overflow-hidden">
				{timeline.status === "pending" ? (
					<LoadingState size="lg" />
				) : timeline.status === "error" ? (
					<EmptyState
						variant="error"
						error={asErrorDTO(timeline.error)}
						onRetry={retry}
					/>
				) : timeline.listing.photos.length === 0 ? (
					<div className="flex flex-1 overflow-y-auto">
						<Empty>
							<EmptyHeader>
								<EmptyMedia>
									<ImagesIcon />
								</EmptyMedia>
								<EmptyTitle>{t("photosEmptyTitle")}</EmptyTitle>
								<EmptyDescription>{t("photosEmptyBody", { count: roots.length })}</EmptyDescription>
							</EmptyHeader>
						</Empty>
					</div>
				) : (
					<PhotoGrid
						// A new set of roots starts with an empty search and a fresh scroll position.
						key={roots.join(",")}
						rootUuids={listedRoots}
						listing={timeline.listing}
					/>
				)}
			</div>
			{dialogs}
		</>
	)
}

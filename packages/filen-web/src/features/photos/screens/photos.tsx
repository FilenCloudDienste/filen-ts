import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { ImagesIcon } from "lucide-react"
import { asErrorDTO } from "@/lib/sdk/errors"
import { useIsOnline } from "@/lib/useIsOnline"
import { useDirectoryNamesQuery } from "@/features/drive/queries/drive"
import { useAccountQuery } from "@/queries/account"
import { usePhotosRootQuery, invalidatePhotosRoot } from "@/features/photos/queries/root"
import { usePhotosListingQuery } from "@/features/photos/queries/photos"
import { clearPhotosRoot, setPhotosRoot, shouldResetRootOnError } from "@/features/photos/lib/root"
import { DirectoryChooserDialog } from "@/features/photos/components/directoryChooserDialog"
import { PhotoGrid } from "@/features/photos/components/photoGrid"
import { PhotosDensityControls } from "@/features/photos/components/densityControls"
import { EmptyState } from "@/features/drive/components/emptyState"
import { LoadingState } from "@/components/loadingState"
import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"

// Root selection + persistence + unset/ready/gone states, reachable from the icon rail's own
// /photos entry (iconRail.tsx). READY renders the grid (search, filters and timeline live there).
export function PhotosScreen() {
	const { t } = useTranslation(["photos", "common", "drive"])
	const isOnline = useIsOnline()
	const rootQuery = usePhotosRootQuery()
	const rootUuid = rootQuery.data ?? null
	const [chooserOpen, setChooserOpen] = useState(false)
	const [choosePending, setChoosePending] = useState(false)
	// Guards the reset side-effect below against firing twice for the same errored query settle (e.g.
	// a re-render triggered by isOnline flipping while the reset's own await is still in flight). A
	// ref, not state: this guard is never read during render, only inside the effect itself, so it's
	// "instance state" the React Compiler rules want kept out of useState (setting state synchronously
	// inside an effect body also trips react-hooks/set-state-in-effect).
	const resettingRef = useRef(false)

	// The whole drive is a valid photos root; it has no name to resolve, only the drive's own label.
	const driveRootUuid = useAccountQuery().data?.rootDirUuid
	const isWholeDrive = rootUuid !== null && rootUuid === driveRootUuid
	const namesQuery = useDirectoryNamesQuery(rootUuid !== null && !isWholeDrive ? [rootUuid] : [])
	const listingQuery = usePhotosListingQuery(rootUuid)

	// Root-gone detection: an error whose message matches DIRECTORY_NOT_FOUND_PREFIX (isRootGoneError,
	// features/photos/lib/root.ts) AND the tab believes it's online (shouldResetRootOnError's
	// defense-in-depth second gate) resets the saved root — a transient network failure, or the same
	// error while offline, leaves the saved root untouched so a flaky fetch can never wipe it.
	useEffect(() => {
		if (listingQuery.status !== "error" || rootUuid === null || resettingRef.current) {
			return
		}

		const dto = asErrorDTO(listingQuery.error)

		if (!shouldResetRootOnError(dto, isOnline)) {
			return
		}

		resettingRef.current = true

		void (async () => {
			await clearPhotosRoot()
			invalidatePhotosRoot()
			toast.error(t("photosRootGoneToast"))
			resettingRef.current = false
		})()
	}, [listingQuery.status, listingQuery.error, isOnline, rootUuid, t])

	async function handleChoose(nextRootUuid: string): Promise<void> {
		setChoosePending(true)
		await setPhotosRoot(nextRootUuid)
		invalidatePhotosRoot()
		setChoosePending(false)
		setChooserOpen(false)
	}

	const chooser = chooserOpen ? (
		<DirectoryChooserDialog
			pending={choosePending}
			onChoose={choice => {
				void handleChoose(choice)
			}}
			onClose={() => {
				setChooserOpen(false)
			}}
		/>
	) : null

	if (rootQuery.status === "pending") {
		return <LoadingState size="lg" />
	}

	if (rootUuid === null) {
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
								onClick={() => {
									setChooserOpen(true)
								}}
							>
								{t("photosChooseDirectory")}
							</Button>
						</EmptyContent>
					</Empty>
				</div>
				{chooser}
			</>
		)
	}

	// Unknown until the name lookup settles; the header then shows the module name alone.
	const rootName = isWholeDrive ? t("drive:driveMyDrive") : namesQuery.data?.[rootUuid]

	return (
		<>
			<header className="flex h-14 shrink-0 items-center justify-between gap-3 px-4">
				<h1 className="flex min-w-0 items-baseline gap-1.5 text-sm font-medium">
					<span className="shrink-0">{t("common:modulePhotos")}</span>
					{rootName === undefined ? null : (
						<>
							<span
								aria-hidden="true"
								className="text-muted-foreground"
							>
								·
							</span>
							<span className="truncate font-normal text-muted-foreground">{rootName}</span>
						</>
					)}
				</h1>
				<div className="flex shrink-0 items-center gap-2">
					{listingQuery.status === "success" && listingQuery.data.photos.length > 0 ? <PhotosDensityControls /> : null}
					<Button
						variant="outline"
						size="sm"
						onClick={() => {
							setChooserOpen(true)
						}}
					>
						{t("photosChangeDirectory")}
					</Button>
				</div>
			</header>
			<div className="flex min-h-0 flex-1 flex-col overflow-hidden">
				{listingQuery.status === "pending" ? (
					<LoadingState size="lg" />
				) : listingQuery.status === "error" ? (
					<EmptyState
						variant="error"
						error={asErrorDTO(listingQuery.error)}
						onRetry={() => {
							void listingQuery.refetch()
						}}
					/>
				) : listingQuery.data.photos.length === 0 ? (
					<div className="flex flex-1 overflow-y-auto">
						<Empty>
							<EmptyHeader>
								<EmptyMedia>
									<ImagesIcon />
								</EmptyMedia>
								<EmptyTitle>{t("photosEmptyTitle")}</EmptyTitle>
								<EmptyDescription>{t("photosEmptyBody")}</EmptyDescription>
							</EmptyHeader>
						</Empty>
					</div>
				) : (
					<PhotoGrid
						// A new root starts with an empty search and a fresh scroll position.
						key={rootUuid}
						rootUuid={rootUuid}
						listing={listingQuery.data}
					/>
				)}
			</div>
			{chooser}
		</>
	)
}

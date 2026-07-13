import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { ImagesIcon } from "lucide-react"
import { asErrorDTO } from "@/lib/sdk/errors"
import { useIsOnline } from "@/lib/useIsOnline"
import { useDirectoryNamesQuery } from "@/features/drive/queries/drive"
import { usePhotosRootQuery, invalidatePhotosRoot } from "@/features/photos/queries/root"
import { usePhotosListingQuery } from "@/features/photos/queries/photos"
import { clearPhotosRoot, setPhotosRoot, shouldResetRootOnError } from "@/features/photos/lib/root"
import { DirectoryChooserDialog } from "@/features/photos/components/directoryChooserDialog"
import { EmptyState } from "@/features/drive/components/emptyState"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"

// Root selection + persistence + unset/ready/gone states, reachable from the icon rail's own
// /photos entry (iconRail.tsx). The media grid itself is a later addition — READY renders a
// listing-agnostic placeholder body wired to usePhotosListingQuery's own key/status, so that
// addition only ever needs to swap this file's placeholder body for the real grid, never the
// root/query plumbing around it.
export function PhotosScreen() {
	const { t } = useTranslation(["photos", "common"])
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

	const namesQuery = useDirectoryNamesQuery(rootUuid !== null ? [rootUuid] : [])
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

	if (rootQuery.status === "pending") {
		return (
			<div className="flex flex-1 items-center justify-center">
				<Spinner className="size-5 text-muted-foreground" />
			</div>
		)
	}

	if (rootUuid === null) {
		return (
			<>
				<div className="flex flex-1 overflow-y-auto">
					<Empty>
						<EmptyHeader>
							<EmptyMedia variant="icon">
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
				{chooserOpen ? (
					<DirectoryChooserDialog
						pending={choosePending}
						onChoose={choice => {
							void handleChoose(choice)
						}}
						onClose={() => {
							setChooserOpen(false)
						}}
					/>
				) : null}
			</>
		)
	}

	const rootName = namesQuery.data?.[rootUuid] ?? rootUuid

	return (
		<>
			<header className="flex h-14 shrink-0 items-center justify-between gap-3 px-4">
				<h1 className="min-w-0 truncate text-sm font-medium">{rootName}</h1>
				<Button
					variant="outline"
					size="sm"
					onClick={() => {
						setChooserOpen(true)
					}}
				>
					{t("photosChangeDirectory")}
				</Button>
			</header>
			<div className="flex min-h-0 flex-1 flex-col overflow-hidden">
				{listingQuery.status === "pending" ? (
					<div className="flex flex-1 items-center justify-center">
						<Spinner className="size-5 text-muted-foreground" />
					</div>
				) : listingQuery.status === "error" ? (
					<EmptyState
						variant="error"
						error={asErrorDTO(listingQuery.error)}
						onRetry={() => {
							void listingQuery.refetch()
						}}
					/>
				) : (
					<div className="flex flex-1 overflow-y-auto">
						<Empty>
							<EmptyHeader>
								<EmptyMedia variant="icon">
									<ImagesIcon />
								</EmptyMedia>
								<EmptyTitle>{t("photosGridPlaceholderTitle")}</EmptyTitle>
							</EmptyHeader>
						</Empty>
					</div>
				)}
			</div>
			{chooserOpen ? (
				<DirectoryChooserDialog
					pending={choosePending}
					onChoose={choice => {
						void handleChoose(choice)
					}}
					onClose={() => {
						setChooserOpen(false)
					}}
				/>
			) : null}
		</>
	)
}

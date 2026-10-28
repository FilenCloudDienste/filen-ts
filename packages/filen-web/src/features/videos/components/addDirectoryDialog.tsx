import { useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { TriangleAlertIcon } from "lucide-react"
import type { DirSizeResponse, UuidStr } from "@filen/sdk-rs"
import { driveItemName } from "@filen/shared"
import { useAccountQuery } from "@/queries/account"
import { queryClient } from "@/queries/client"
import { log } from "@/lib/log"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { DOT_FILEN_DIR_NAME } from "@/lib/dotFilen"
import { pendingGuardedOpenChange } from "@/components/dialogs/dismissal.logic"
import { filterDriveItemsByLocalSearch } from "@/features/drive/components/directoryListing.logic"
import { PickerBreadcrumb, PickerDirectoryRow, PickerListShell } from "@/features/drive/components/directoryPicker"
import { useDirectoryPicker, useDirectoryPickerFilter } from "@/features/drive/hooks/useDirectoryPicker"
import { DIRECTORY_SIZE_STALE_TIME, directorySizeQueryKey, directorySizeQueryOptions } from "@/features/drive/queries/drive"
import type { DriveItem } from "@/features/drive/lib/item"
import { sdkApi } from "@/lib/sdk/client"
import { checkLibraryRoot } from "@/features/videos/lib/library"
import { editLibraryConfig } from "@/features/videos/queries/library"
import { useVideoLibraryView, useVideoRootNames } from "@/features/videos/hooks/useVideoLibraryView"
import { addRootEdit, stepAfterSize, stepAfterValidation, type AddDirectoryStep } from "@/features/videos/lib/addDirectory.logic"
import { chooserPickHint, isHiddenChooserRow, isRootRow, type ChooserRoot } from "@/lib/rootChooser.logic"
import { closeVideosChooser } from "@/features/videos/store/useVideosDialogStore"
import { ListFilterInput } from "@/components/listFilterInput"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { LIST_DIALOG_CLASS } from "@/components/dialogs/listDialog"

type DirectoryItem = Extract<DriveItem, { type: "directory" }>

const BROWSE: AddDirectoryStep = { kind: "browse" }

// Files and directories below `uuid`: one size request, none when a listing already read it. The drive root
// is sized by its uuid, any other directory by the item it was opened from; null when unknown.
async function readEntries({
	uuid,
	item,
	driveRoot
}: {
	uuid: string
	item: DirectoryItem | undefined
	driveRoot: UuidStr | undefined
}): Promise<number | null> {
	try {
		let size: DirSizeResponse

		if (item !== undefined) {
			size = await queryClient.query(directorySizeQueryOptions(item))
		} else if (driveRoot !== undefined && uuid === driveRoot) {
			size = await queryClient.query({
				queryKey: directorySizeQueryKey(driveRoot),
				queryFn: () => sdkApi.getDirSize({ uuid: driveRoot }),
				staleTime: DIRECTORY_SIZE_STALE_TIME
			})
		} else {
			return null
		}

		return Number(size.files + size.dirs)
	} catch (e) {
		log.warn("videos.chooser", "directory size unavailable", e)

		return null
	}
}

// The Videos directory chooser: the drive picker with Filen's own directory hidden and library directories
// marked, then the checks a pick goes through (overlap, size) before it is saved. Shared-in and public-link
// directories never show here: the picker browses the own drive only.
export function AddDirectoryDialog({ replacing }: { replacing: string[] }) {
	const { t } = useTranslation(["videos", "drive", "common"])
	const { pathStack, targetUuid, listingQuery, items, namesQuery, descend, goRoot, goTo } = useDirectoryPicker()
	const [filter, setFilter] = useDirectoryPickerFilter(pathStack)
	const driveRoot = useAccountQuery().data?.rootDirUuid
	const { roots } = useVideoLibraryView()
	const names = useVideoRootNames(roots)
	const [step, setStep] = useState<AddDirectoryStep>(BROWSE)
	// The directories opened on the way here, by uuid: what the size read takes.
	const [opened, setOpened] = useState<Record<string, DirectoryItem>>({})
	const chooserRoots: ChooserRoot[] = roots.map(root => ({
		uuid: root.uuid,
		name: names.get(root.uuid) ?? ""
	}))
	const atDriveRoot = pathStack.length === 0
	const directories = items.filter(
		(item): item is DirectoryItem =>
			item.type === "directory" && !isHiddenChooserRow({ name: driveItemName(item), atDriveRoot, systemName: DOT_FILEN_DIR_NAME })
	)
	const filteredDirectories = filterDriveItemsByLocalSearch(directories, filter)
	const pick = targetUuid ?? driveRoot ?? null
	const hint = chooserPickHint({
		pathStack: driveRoot === undefined ? pathStack : [driveRoot, ...pathStack],
		roots: chooserRoots
	})
	const busy = step.kind === "checking" || step.kind === "sizing" || step.kind === "saving"
	const openedItem = targetUuid === null ? undefined : opened[targetUuid]
	const pickName =
		targetUuid === null
			? t("drive:driveMyDrive")
			: (namesQuery.data?.[targetUuid] ?? (openedItem === undefined ? "" : driveItemName(openedItem)))

	const handleOpenChange = pendingGuardedOpenChange(busy, next => {
		if (!next) {
			closeVideosChooser()
		}
	})

	async function save(uuid: string, replace: string[]): Promise<void> {
		setStep({ kind: "saving" })

		try {
			const { scanned } = await editLibraryConfig(addRootEdit({ uuid, replace, now: Date.now() }))

			scanned.catch((e: unknown) => {
				log.warn("videos.chooser", "first scan failed", e)
			})
			closeVideosChooser()
		} catch (e) {
			toast.error(errorLabel(e))
			setStep(BROWSE)
		}
	}

	async function size(uuid: string, replace: string[]): Promise<void> {
		setStep({ kind: "sizing", uuid, replace })

		const entries = await readEntries({ uuid, item: opened[uuid], driveRoot })
		const next = stepAfterSize({ uuid, replace, entries })

		if (next.kind === "saving") {
			await save(uuid, replace)
		} else {
			setStep(next)
		}
	}

	async function confirm(uuid: string): Promise<void> {
		setStep({ kind: "checking" })

		let next: AddDirectoryStep

		try {
			next = stepAfterValidation({
				uuid,
				validation: await checkLibraryRoot({ uuid, ownDrive: true }),
				replacing
			})
		} catch (e) {
			toast.error(errorLabel(e))
			setStep(BROWSE)

			return
		}

		if (next.kind === "sizing") {
			await size(next.uuid, next.replace)
		} else {
			setStep(next)
		}
	}

	function blockedMessage(reason: Extract<AddDirectoryStep, { kind: "blocked" }>["reason"]): string {
		switch (reason) {
			case "alreadyRoot":
				return t("videosChooserAlreadyRoot")
			case "systemDirectory":
				return t("videosChooserSystemDirectory")
			case "notFound":
			case "notOwnDrive":
				return t("videosChooserNotFound")
		}
	}

	const warning =
		step.kind === "replace"
			? t("videosChooserReplaceBody", {
					name: pickName,
					names: step.replace.map(uuid => names.get(uuid) ?? "").join(", ")
				})
			: step.kind === "large"
				? t("videosChooserLargeBody", { name: pickName, files: step.entries })
				: step.kind === "blocked"
					? blockedMessage(step.reason)
					: null

	return (
		<Dialog
			open
			onOpenChange={handleOpenChange}
		>
			<DialogContent
				closeButtonDisabled={busy}
				className={LIST_DIALOG_CLASS}
			>
				<DialogHeader>
					<DialogTitle>{t("videosChooserTitle")}</DialogTitle>
				</DialogHeader>
				<PickerBreadcrumb
					pathStack={pathStack}
					names={namesQuery.data}
					onRoot={() => {
						setStep(BROWSE)
						goRoot()
					}}
					onJump={index => {
						setStep(BROWSE)
						goTo(index)
					}}
				/>
				{directories.length > 0 ? (
					<ListFilterInput
						value={filter}
						onChange={setFilter}
						placeholder={t("videosChooserFilterPlaceholder")}
						ariaLabel={t("videosChooserFilterPlaceholder")}
					/>
				) : null}
				<PickerListShell
					listingQuery={listingQuery}
					isEmpty={filteredDirectories.length === 0}
					noResults={filter.trim().length > 0}
				>
					{filteredDirectories.map(directory => {
						const root = isRootRow(directory.data.uuid, chooserRoots)

						return (
							<PickerDirectoryRow
								key={directory.data.uuid}
								directory={directory}
								disabled={directory.data.undecryptable || busy}
								hint={root ? t("videosChooserAlreadyRoot") : undefined}
								onDescend={uuid => {
									setOpened(previous => ({ ...previous, [uuid]: directory }))
									setStep(BROWSE)
									descend(uuid)
								}}
							/>
						)
					})}
				</PickerListShell>
				{warning === null ? null : (
					<div
						role="alert"
						className="flex items-start gap-2.5 rounded-xl bg-warning/15 px-3 py-2.5 text-sm text-warning-foreground"
					>
						<TriangleAlertIcon
							aria-hidden="true"
							className="mt-0.5 size-4 shrink-0"
						/>
						<p className="min-w-0 flex-1">{warning}</p>
					</div>
				)}
				<DialogFooter className="items-center">
					{step.kind === "browse" && hint.kind !== "none" ? (
						<p className="mr-auto text-xs text-muted-foreground">
							{hint.kind === "alreadyRoot"
								? t("videosChooserAlreadyRoot")
								: t("videosChooserInsideRoot", { name: hint.root.name })}
						</p>
					) : null}
					{step.kind === "replace" || step.kind === "large" || step.kind === "blocked" ? (
						<>
							<Button
								variant="outline"
								onClick={() => {
									setStep(BROWSE)
								}}
							>
								{t("videosChooserBack")}
							</Button>
							{step.kind === "blocked" ? null : (
								<Button
									onClick={() => {
										if (step.kind === "replace") {
											void size(step.uuid, step.replace)
										} else {
											void save(step.uuid, step.replace)
										}
									}}
								>
									{step.kind === "replace" ? t("videosChooserReplaceAction") : t("videosChooserLargeAction")}
								</Button>
							)}
						</>
					) : (
						<Button
							disabled={busy || pick === null || hint.kind === "alreadyRoot"}
							className="max-w-full min-w-0"
							onClick={() => {
								if (pick !== null) {
									void confirm(pick)
								}
							}}
						>
							{busy ? <Spinner data-icon="inline-start" /> : null}
							<span className="truncate">{t("videosChooserConfirm", { name: pickName })}</span>
						</Button>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}

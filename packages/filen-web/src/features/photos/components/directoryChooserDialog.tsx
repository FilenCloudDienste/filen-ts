import { useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { TriangleAlertIcon } from "lucide-react"
import { driveItemName } from "@filen/shared"
import { useAccountQuery } from "@/queries/account"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { DOT_FILEN_DIR_NAME } from "@/lib/dotFilen"
import { checkDirectoryRoot } from "@/lib/directoryRoots"
import { chooserPickHint, isHiddenChooserRow, isRootRow, type ChooserRoot, type RootPickVerdict } from "@/lib/rootChooser.logic"
import { pendingGuardedOpenChange } from "@/components/dialogs/dismissal.logic"
import { photosChooserChoice, photosPickVerdict } from "@/features/photos/components/directoryChooserDialog.logic"
import { filterDriveItemsByLocalSearch } from "@/features/drive/components/directoryListing.logic"
import { PickerBreadcrumb, PickerDirectoryRow, PickerListShell } from "@/features/drive/components/directoryPicker"
import { useDirectoryPicker, useDirectoryPickerFilter } from "@/features/drive/hooks/useDirectoryPicker"
import type { DriveItem } from "@/features/drive/lib/item"
import { addPhotosRoot } from "@/features/photos/lib/library"
import { ListFilterInput } from "@/components/listFilterInput"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { LIST_DIALOG_CLASS } from "@/components/dialogs/listDialog"

export interface DirectoryChooserDialogProps {
	// The current photos directories, with the names the caller shows them by.
	roots: readonly ChooserRoot[]
	// The library was saved by a newer version: nothing can be added.
	readOnly: boolean
	onClose: () => void
}

type ChooserStep =
	| { kind: "browse" }
	| { kind: "checking" }
	| { kind: "saving" }
	| { kind: "replace"; uuid: string; replace: string[] }
	| Extract<RootPickVerdict, { kind: "blocked" }>
	// Inside this photos directory: already read.
	| { kind: "inside"; root: string }

type DirectoryItem = Extract<DriveItem, { type: "directory" }>

const BROWSE: ChooserStep = { kind: "browse" }

// Photos' directory picker — composed from directoryPicker.tsx's gating-free pieces, not a lift of
// moveTargetDialog: that dialog's row/confirm gating is move-specific (it forbids the moved selection's own
// ancestry). A pick goes through the Videos chooser's checks (rootChooser.logic.ts), except that a directory
// inside a photos directory can't be picked at all (it is read already; the picker's path is its ancestry):
// Filen's own directory never shows, and one holding photos directories is offered as their replacement. The
// picker browses the own drive only, so a shared-in directory never shows. No create-directory-in-place: unlike
// a move destination, a photos directory doesn't need one carved out on the spot.
export function DirectoryChooserDialog({ roots, readOnly, onClose }: DirectoryChooserDialogProps) {
	const { t } = useTranslation(["photos", "drive"])
	const { pathStack, targetUuid, listingQuery, items, namesQuery, descend, goRoot, goTo } = useDirectoryPicker()
	const [filter, setFilter] = useDirectoryPickerFilter(pathStack)
	const driveRoot = useAccountQuery().data?.rootDirUuid
	const [step, setStep] = useState<ChooserStep>(BROWSE)
	const atDriveRoot = pathStack.length === 0
	const directories = items.filter(
		(item): item is DirectoryItem =>
			item.type === "directory" && !isHiddenChooserRow({ name: driveItemName(item), atDriveRoot, systemName: DOT_FILEN_DIR_NAME })
	)
	const filteredDirectories = filterDriveItemsByLocalSearch(directories, filter)
	const choice = photosChooserChoice(targetUuid, driveRoot)
	const hint = chooserPickHint({
		pathStack: driveRoot === undefined ? pathStack : [driveRoot, ...pathStack],
		roots
	})
	const busy = step.kind === "checking" || step.kind === "saving"
	const pickName = targetUuid === null ? t("drive:driveMyDrive") : (namesQuery.data?.[targetUuid] ?? "")

	const handleOpenChange = pendingGuardedOpenChange(busy, next => {
		if (!next) {
			onClose()
		}
	})

	async function save(uuid: string, replace: string[]): Promise<void> {
		setStep({ kind: "saving" })

		try {
			await addPhotosRoot({ uuid, replace })
			onClose()
		} catch (e) {
			toast.error(errorLabel(e))
			setStep(BROWSE)
		}
	}

	async function confirm(uuid: string): Promise<void> {
		setStep({ kind: "checking" })

		let verdict: ReturnType<typeof photosPickVerdict>

		try {
			verdict = photosPickVerdict(uuid, await checkDirectoryRoot({ uuid, ownDrive: true, roots: roots.map(root => root.uuid) }))
		} catch (e) {
			toast.error(errorLabel(e))
			setStep(BROWSE)

			return
		}

		if (verdict.kind === "clear") {
			await save(uuid, verdict.replace)
		} else if (verdict.kind === "replace") {
			setStep({ kind: "replace", uuid, replace: verdict.replace })
		} else {
			setStep(verdict)
		}
	}

	function blockedMessage(reason: Extract<ChooserStep, { kind: "blocked" }>["reason"]): string {
		switch (reason) {
			case "alreadyRoot":
				return t("photosChooserAlreadyRoot")
			case "systemDirectory":
				return t("photosChooserSystemDirectory")
			case "notFound":
			case "notOwnDrive":
				return t("photosChooserNotFound")
		}
	}

	const warning =
		step.kind === "replace"
			? t("photosChooserReplaceBody", {
					name: pickName,
					names: step.replace.map(uuid => roots.find(root => root.uuid === uuid)?.name ?? "").join(", ")
				})
			: step.kind === "blocked"
				? blockedMessage(step.reason)
				: step.kind === "inside"
					? t("photosChooserInsideRoot", { name: roots.find(root => root.uuid === step.root)?.name ?? "" })
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
					<DialogTitle>{roots.length === 0 ? t("photosChooserTitle") : t("photosChooserAddTitle")}</DialogTitle>
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
						placeholder={t("photosChooserFilterPlaceholder")}
						ariaLabel={t("photosChooserFilterPlaceholder")}
					/>
				) : null}
				<PickerListShell
					listingQuery={listingQuery}
					isEmpty={filteredDirectories.length === 0}
					noResults={filter.trim().length > 0}
				>
					{filteredDirectories.map(directory => (
						<PickerDirectoryRow
							key={directory.data.uuid}
							directory={directory}
							disabled={directory.data.undecryptable || busy}
							hint={isRootRow(directory.data.uuid, roots) ? t("photosChooserAlreadyRoot") : undefined}
							onDescend={uuid => {
								setStep(BROWSE)
								descend(uuid)
							}}
						/>
					))}
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
					{step.kind === "browse" && readOnly ? (
						<p className="mr-auto text-xs text-muted-foreground">{t("photosLibraryReadOnly")}</p>
					) : null}
					{step.kind === "browse" && !readOnly && hint.kind !== "none" ? (
						<p className="mr-auto text-xs text-muted-foreground">
							{hint.kind === "alreadyRoot"
								? t("photosChooserAlreadyRoot")
								: t("photosChooserInsideRoot", { name: hint.root.name })}
						</p>
					) : null}
					{step.kind === "replace" || step.kind === "blocked" || step.kind === "inside" ? (
						<>
							<Button
								variant="outline"
								onClick={() => {
									setStep(BROWSE)
								}}
							>
								{t("photosChooserBack")}
							</Button>
							{step.kind === "replace" ? (
								<Button
									onClick={() => {
										void save(step.uuid, step.replace)
									}}
								>
									{t("photosChooserReplaceAction")}
								</Button>
							) : null}
						</>
					) : (
						<Button
							disabled={busy || readOnly || choice === null || hint.kind !== "none"}
							onClick={() => {
								if (choice !== null) {
									void confirm(choice)
								}
							}}
						>
							{busy ? <Spinner data-icon="inline-start" /> : null}
							{t("photosChooserConfirmAction")}
						</Button>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}

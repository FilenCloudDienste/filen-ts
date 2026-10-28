import { useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { FolderClosedIcon, PlusIcon, XIcon } from "lucide-react"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { useIsOnline } from "@/lib/useIsOnline"
import { removePhotosRoot } from "@/features/photos/lib/library"
import { PHOTOS_CHOOSE_ACTION_ID } from "@/features/photos/lib/focusTargets"
import type { PhotosRootView } from "@/features/photos/hooks/usePhotosRootViews"
import { DirectoryChooserDialog } from "@/features/photos/components/directoryChooserDialog"
import { SettingsBlock, SettingsGroup } from "@/features/settings/components/settingsLayout"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"

// The Directories dialog: every photos directory with its path and Remove, Add directory (the chooser, over this
// dialog) and Done. Mounted only while open; the names and paths come from the directories' chains, usually from
// the directory cache.
export function PhotosDirectoriesDialog({
	roots,
	readOnly,
	onClose
}: {
	roots: readonly PhotosRootView[]
	// Saved by a newer version: shown, never changed here.
	readOnly: boolean
	onClose: () => void
}) {
	const { t } = useTranslation(["photos", "common"])
	const isOnline = useIsOnline()
	const [choosing, setChoosing] = useState(false)
	const [removing, setRemoving] = useState<PhotosRootView | null>(null)
	const [pending, setPending] = useState(false)
	// What focus returns to once a removal took the row that opened it away.
	const addRef = useRef<HTMLButtonElement>(null)

	// Promise handlers rather than try/finally, which the React Compiler can't compile yet.
	function remove(root: PhotosRootView): void {
		setPending(true)
		void removePhotosRoot(root.uuid).then(
			() => {
				setPending(false)
				setRemoving(null)
			},
			(e: unknown) => {
				setPending(false)
				toast.error(errorLabel(e))
			}
		)
	}

	return (
		<>
			<Dialog
				open
				onOpenChange={open => {
					if (!open) {
						onClose()
					}
				}}
			>
				<DialogContent
					className="flex max-h-[min(48rem,calc(100dvh-2rem))] flex-col sm:max-w-xl"
					// With the last directory removed, what opened it is gone: focus goes to the unset screen's button.
					finalFocus={() => (roots.length === 0 ? (document.getElementById(PHOTOS_CHOOSE_ACTION_ID) ?? true) : true)}
				>
					<DialogHeader>
						<DialogTitle>{t("photosDirectoriesTitle")}</DialogTitle>
						<DialogDescription>{readOnly ? t("photosLibraryReadOnly") : t("photosDirectoriesDescription")}</DialogDescription>
					</DialogHeader>
					<div className="flex min-h-0 flex-col overflow-y-auto">
						{roots.length === 0 ? (
							<p className="py-8 text-center text-sm text-muted-foreground">{t("photosDirectoriesNone")}</p>
						) : (
							<SettingsGroup>
								{roots.map(root => {
									const outer = root.within === undefined ? undefined : roots.find(other => other.uuid === root.within)

									return (
										<SettingsBlock
											key={root.uuid}
											className="flex items-center gap-3 py-3"
										>
											<FolderClosedIcon
												aria-hidden="true"
												className="size-4 shrink-0 text-muted-foreground"
											/>
											<div className="flex min-w-0 flex-1 flex-col gap-0.5">
												<p className="truncate text-sm font-medium">{root.name}</p>
												{root.path === undefined && outer === undefined ? null : (
													<p className="truncate text-sm text-muted-foreground">
														{outer === undefined
															? root.path
															: t("photosDirectoryWithin", { path: root.path ?? "", name: outer.name })}
													</p>
												)}
											</div>
											<Button
												variant="ghost"
												size="icon-sm"
												disabled={pending || readOnly || !isOnline}
												aria-label={t("photosRemoveDirectory", { name: root.name })}
												onClick={() => {
													setRemoving(root)
												}}
											>
												<XIcon />
											</Button>
										</SettingsBlock>
									)
								})}
							</SettingsGroup>
						)}
					</div>
					<DialogFooter className="sm:justify-between">
						<Button
							ref={addRef}
							variant="outline"
							disabled={readOnly || !isOnline}
							onClick={() => {
								setChoosing(true)
							}}
						>
							<PlusIcon data-icon="inline-start" />
							{t("photosAddDirectory")}
						</Button>
						<Button onClick={onClose}>{t("photosDirectoriesDone")}</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
			{choosing ? (
				<DirectoryChooserDialog
					roots={roots}
					readOnly={readOnly}
					onClose={() => {
						setChoosing(false)
					}}
				/>
			) : null}
			<ConfirmDialog
				open={removing !== null}
				pending={pending}
				finalFocus={addRef}
				title={t("photosRemoveConfirmTitle", { name: removing?.name ?? "" })}
				body={t("photosRemoveConfirmBody", { name: removing?.name ?? "" })}
				confirmLabel={t("photosRemoveConfirmAction")}
				cancelLabel={t("common:cancel")}
				destructive
				onOpenChange={open => {
					if (!open) {
						setRemoving(null)
					}
				}}
				onConfirm={() => {
					if (removing !== null) {
						remove(removing)
					}
				}}
			/>
		</>
	)
}

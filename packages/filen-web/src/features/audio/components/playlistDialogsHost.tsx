import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate } from "@tanstack/react-router"
import { toast } from "sonner"
import { createPlaylist, deletePlaylistAction, renamePlaylistAction } from "@/features/audio/lib/playlists"
import { closePlaylistDialog, usePlaylistDialogStore } from "@/features/audio/store/usePlaylistDialogStore"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { InputDialog } from "@/components/dialogs/inputDialog"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"

// Renders whichever playlist dialog the sidebar or the pane opened (usePlaylistDialogStore).
// `selectedUuid` is the route's raw `playlist` param: deleting the playlist it names drops the param,
// so the view falls back to the first remaining playlist instead of carrying a dead uuid in the URL.
export function PlaylistDialogsHost({ selectedUuid }: { selectedUuid: string | undefined }) {
	const { t } = useTranslation("audio")
	const { t: tCommon } = useTranslation("common")
	const navigate = useNavigate()
	const dialog = usePlaylistDialogStore(state => state.dialog)
	const [pending, setPending] = useState(false)

	// The store outlives this host: without the reset, a dialog open when the route unmounted would
	// reappear on the next visit.
	useEffect(() => closePlaylistDialog, [])

	async function handleCreate(name: string): Promise<void> {
		setPending(true)

		try {
			const playlist = await createPlaylist(name.trim())

			closePlaylistDialog()
			void navigate({ to: "/playlists", search: { playlist: playlist.uuid } })
		} catch (error) {
			toast.error(errorLabel(error))
		} finally {
			setPending(false)
		}
	}

	async function handleRename(name: string): Promise<void> {
		if (dialog?.kind !== "rename") {
			return
		}

		setPending(true)

		try {
			await renamePlaylistAction(dialog.playlist, name.trim())
			closePlaylistDialog()
		} catch (error) {
			toast.error(errorLabel(error))
		} finally {
			setPending(false)
		}
	}

	async function handleDelete(): Promise<void> {
		if (dialog?.kind !== "delete") {
			return
		}

		const { uuid } = dialog.playlist

		setPending(true)

		try {
			await deletePlaylistAction(dialog.playlist)
			closePlaylistDialog()

			if (uuid === selectedUuid) {
				void navigate({ to: "/playlists", search: {}, replace: true })
			}
		} catch (error) {
			toast.error(errorLabel(error))
		} finally {
			setPending(false)
		}
	}

	function handleOpenChange(open: boolean): void {
		if (!open) {
			closePlaylistDialog()
		}
	}

	return (
		<>
			<InputDialog
				open={dialog?.kind === "create"}
				pending={pending}
				title={t("newPlaylistTitle")}
				body={t("newPlaylistBody")}
				label={t("playlistNameLabel")}
				placeholder={t("playlistNamePlaceholder")}
				submitLabel={t("newPlaylistSubmit")}
				validate={value => value.trim().length > 0}
				onOpenChange={handleOpenChange}
				onSubmit={value => {
					void handleCreate(value)
				}}
			/>
			<InputDialog
				open={dialog?.kind === "rename"}
				pending={pending}
				title={t("renamePlaylistTitle")}
				body={t("renamePlaylistBody")}
				label={t("playlistNameLabel")}
				placeholder={t("playlistNamePlaceholder")}
				initialValue={dialog?.kind === "rename" ? dialog.playlist.name : ""}
				submitLabel={t("playlistActionRename")}
				validate={value => value.trim().length > 0}
				onOpenChange={handleOpenChange}
				onSubmit={value => {
					void handleRename(value)
				}}
			/>
			<ConfirmDialog
				open={dialog?.kind === "delete"}
				pending={pending}
				title={t("deletePlaylistTitle")}
				body={t("deletePlaylistBody", { name: dialog?.kind === "delete" ? dialog.playlist.name : "" })}
				confirmLabel={t("playlistActionDelete")}
				cancelLabel={tCommon("cancel")}
				destructive
				onOpenChange={handleOpenChange}
				onConfirm={() => {
					void handleDelete()
				}}
			/>
		</>
	)
}

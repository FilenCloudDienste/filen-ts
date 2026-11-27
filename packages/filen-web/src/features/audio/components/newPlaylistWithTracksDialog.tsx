import { useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { type DriveItem } from "@/features/drive/lib/item"
import { createPlaylist } from "@/features/audio/lib/playlists"
import { addSelectionToPlaylist } from "@/features/audio/lib/addTracks"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { InputDialog } from "@/components/dialogs/inputDialog"

// Add to playlist's New playlist… entry: the playlists screen's create dialog, then the selection's songs go in.
// Closes once the playlist exists; the add reports its own outcome.
export function NewPlaylistWithTracksDialog({ items, onClose }: { items: readonly DriveItem[]; onClose: () => void }) {
	const { t } = useTranslation("audio")
	const [pending, setPending] = useState(false)

	async function handleSubmit(name: string): Promise<void> {
		setPending(true)

		try {
			const playlist = await createPlaylist(name.trim())

			await addSelectionToPlaylist(playlist, items)
		} catch (error) {
			toast.error(errorLabel(error))
			setPending(false)

			return
		}

		setPending(false)
		onClose()
	}

	return (
		<InputDialog
			open
			pending={pending}
			title={t("newPlaylistTitle")}
			body={t("newPlaylistBody")}
			label={t("playlistNameLabel")}
			placeholder={t("playlistNamePlaceholder")}
			submitLabel={t("newPlaylistSubmit")}
			validate={value => value.trim().length > 0}
			onOpenChange={open => {
				if (!open) {
					onClose()
				}
			}}
			onSubmit={value => {
				void handleSubmit(value)
			}}
		/>
	)
}

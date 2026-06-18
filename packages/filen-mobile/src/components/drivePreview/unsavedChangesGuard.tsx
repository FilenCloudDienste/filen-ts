import { useEffect } from "react"
import { useNavigation } from "expo-router"
import { useTranslation } from "react-i18next"
import { run } from "@filen/utils"
import useDrivePreviewStore from "@/stores/useDrivePreview.store"
import prompts from "@/lib/prompts"
import alerts from "@/lib/alerts"
import logger from "@/lib/logger"

// Mounted by the drivePreview route. Every way out of the preview — the header close button, the
// Android hardware back button, and the iOS/Android swipe-back gesture — funnels through the route
// pop, so a single `beforeRemove` listener intercepts them all. When the open editable text file has
// unsaved edits it prompts Save / Discard / Cancel before leaving; otherwise navigation proceeds
// untouched. (Only the text/code preview is editable + manual-save; notes auto-save, images/videos
// have no editor.) Renders nothing.
const UnsavedChangesGuard = () => {
	const navigation = useNavigation()
	const { t } = useTranslation()

	useEffect(() => {
		const unsubscribe = navigation.addListener("beforeRemove", e => {
			if (!useDrivePreviewStore.getState().hasUnsavedEdits) {
				return
			}

			// Block the dismissal; we re-dispatch the original action ourselves once the user decides.
			e.preventDefault()

			void (async () => {
				const promptResult = await run(async () => {
					return await prompts.confirm3({
						title: t("unsaved_changes"),
						message: t("unsaved_changes_message"),
						primaryText: t("save"),
						destructiveText: t("discard"),
						cancelText: t("cancel")
					})
				})

				if (!promptResult.success) {
					logger.error("drivePreview", "unsaved-changes prompt failed", {
						error: promptResult.error instanceof Error ? promptResult.error.message : String(promptResult.error)
					})
					alerts.error(promptResult.error)

					return
				}

				// Cancel (or dismissing the alert) keeps the user on the preview.
				if (promptResult.data === "cancel") {
					return
				}

				if (promptResult.data === "primary") {
					const saveEdits = useDrivePreviewStore.getState().saveEdits
					const saved = saveEdits ? await saveEdits() : false

					// Could not save (e.g. offline) — keep the user put; save() already surfaced any error.
					if (!saved) {
						return
					}
				}

				// Saved, or the user chose to discard: clear the flag and let the original navigation run.
				// beforeRemove fires again on dispatch, but the flag is now false so it passes through.
				useDrivePreviewStore.getState().setHasUnsavedEdits(false)
				navigation.dispatch(e.data.action)
			})()
		})

		return unsubscribe
	}, [navigation, t])

	return null
}

export default UnsavedChangesGuard

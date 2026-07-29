import { useEffect } from "react"
import { useNavigation } from "expo-router"
import { useTranslation } from "react-i18next"
import { run } from "@filen/utils"
import useDrivePreviewStore from "@/stores/useDrivePreview.store"
import events from "@/lib/events"
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
						error: promptResult.error
					})
					alerts.error(promptResult.error)

					events.emit("drivePreviewDismissBlocked")

					return
				}

				// Cancel (or dismissing the alert) keeps the user on the preview.
				if (promptResult.data === "cancel") {
					events.emit("drivePreviewDismissBlocked")

					return
				}

				if (promptResult.data === "primary") {
					const saveEdits = useDrivePreviewStore.getState().saveEdits
					// saveEdits() reports an ordinary failure by returning false, but it is not a total
					// function: previewText's post-upload bookkeeping (cache invalidation and the
					// driveItemUpdated fan-out) runs outside its own error boundary, and EventEmitter3 does
					// not catch subscriber throws. A rejection escaping here would skip the
					// drivePreviewDismissBlocked emit below and strand the user in a preview whose close
					// button and dismiss gesture are both latched off — with no way out on iOS.
					const saveResult = await run(async () => (saveEdits ? await saveEdits() : false))

					if (!saveResult.success) {
						logger.error("drivePreview", "saving before dismissal threw", {
							error: saveResult.error
						})
						alerts.error(saveResult.error)

						events.emit("drivePreviewDismissBlocked")

						return
					}

					// Could not save (e.g. offline) — keep the user put; save() already surfaced any error.
					if (!saveResult.data) {
						events.emit("drivePreviewDismissBlocked")

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

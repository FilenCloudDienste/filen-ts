import { useState } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate } from "@tanstack/react-router"
import { toast } from "sonner"
import { sdkApi } from "@/lib/sdk/client"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { defaultRevealDeps } from "@/features/drive/lib/reveal"
import { useDriveStore } from "@/features/drive/store/useDriveStore"
import type { EventItemRef } from "@/features/settings/lib/eventModel"
import {
	itemDestination,
	locationDestination,
	lookupEventItem,
	type EventDriveDestination,
	type EventItemLookupDeps
} from "@/features/settings/lib/eventItemActions"

const lookupDeps: EventItemLookupDeps = {
	getFile: uuid => sdkApi.getFile(uuid),
	getFileByStableUuid: stableUuid => sdkApi.getFileByStableUuid(stableUuid),
	getDirectory: uuid => sdkApi.getDirectory(uuid)
}

export type EventItemStatus = "idle" | "pending" | "gone"

// Show in Cloud Drive and Open location, each looked up on click. Leaving for the drive closes the dialog with
// the settings route; a lookup that finds nothing marks the item gone instead.
export function useEventItemActions({ item, rootUuid }: { item: EventItemRef | undefined; rootUuid: string | undefined }) {
	const { t } = useTranslation("events")
	const navigate = useNavigate()
	const [itemStatus, setItemStatus] = useState<EventItemStatus>("idle")
	const [locationPending, setLocationPending] = useState(false)

	function go(destination: EventDriveDestination): void {
		switch (destination.type) {
			case "listing":
				if (destination.reveal !== undefined) {
					useDriveStore.getState().requestReveal({ uuid: destination.reveal, splat: destination.target.params._splat })
				}

				void navigate(destination.target)
				break

			case "trash":
				useDriveStore.getState().requestReveal({ uuid: destination.reveal, splat: "" })
				void navigate({ to: "/trash" })
				break

			case "error":
				toast.error(errorLabel(destination.dto))
				break

			case "gone":
				toast.error(t("eventsItemGone"))
				break
		}
	}

	async function showInDrive(): Promise<void> {
		if (item === undefined || itemStatus !== "idle") {
			return
		}

		setItemStatus("pending")

		try {
			const found = await lookupEventItem(item, lookupDeps)

			if (found === null) {
				setItemStatus("gone")

				return
			}

			go(await itemDestination(found, defaultRevealDeps))
		} catch (e) {
			toast.error(errorLabel(e))
		}

		setItemStatus(status => (status === "pending" ? "idle" : status))
	}

	async function openLocation(uuid: string): Promise<void> {
		if (locationPending) {
			return
		}

		setLocationPending(true)

		try {
			go(await locationDestination(uuid, rootUuid, lookupDeps, defaultRevealDeps))
		} catch (e) {
			toast.error(errorLabel(e))
		}

		setLocationPending(false)
	}

	return { itemStatus, locationPending, showInDrive, openLocation }
}

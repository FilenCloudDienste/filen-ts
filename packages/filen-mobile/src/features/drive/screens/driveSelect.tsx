import Drive from "@/features/drive/components"
import { Fragment, useEffect } from "react"
import DriveSelectToolbar from "@/components/driveSelectToolbar"
import auth, { useSdkClients } from "@/lib/auth"
import events from "@/lib/events"
import { randomUUID } from "expo-crypto"
import useEffectOnce from "@/hooks/useEffectOnce"
import { router } from "@/lib/router"
import useDrivePath, { type SelectOptions } from "@/hooks/useDrivePath"
import { serialize } from "@/lib/serializer"
import type { DriveItem } from "@/types"
import useDriveSelectStore from "@/features/drive/store/useDriveSelect.store"
import type { AnyNormalDir } from "@filen/sdk-rs"

export async function selectDriveItems(options: Omit<SelectOptions, "intention" | "id">): Promise<
	| {
			cancelled: true
	  }
	| {
			cancelled: false
			selectedItems: (
				| {
						type: "driveItem"
						data: DriveItem
				  }
				| {
						type: "root"
						data: AnyNormalDir
				  }
			)[]
	  }
> {
	const { authedSdkClient } = await auth.getSdkClients()
	const rootUuid = authedSdkClient.root().uuid

	return new Promise(resolve => {
		const id = randomUUID()

		const sub = events.subscribe("driveSelect", data => {
			if (data.id === id) {
				sub.remove()

				if (data.cancelled || data.selectedItems.length === 0) {
					resolve({
						cancelled: true
					})

					return
				}

				resolve({
					cancelled: false,
					selectedItems: data.selectedItems
				})
			}
		})

		router.push({
			pathname: "/driveSelect/[uuid]",
			params: {
				uuid: rootUuid,
				selectOptions: serialize({
					...options,
					intention: "select",
					id
				} satisfies SelectOptions)
			}
		})
	})
}

const DriveSelectListener = () => {
	const drivePath = useDrivePath()
	const { authedSdkClient } = useSdkClients()

	useEffect(() => {
		return () => {
			if (
				drivePath.selectOptions &&
				drivePath.selectOptions.intention === "select" &&
				authedSdkClient?.root().uuid === drivePath.uuid
			) {
				events.emit("driveSelect", {
					id: drivePath.selectOptions.id,
					cancelled: true
				})
			}
		}
	}, [drivePath, authedSdkClient])

	// Once per screen instance: seed the selection with the caller's current value (e.g.
	// the configured camera-upload directory) so the picker opens showing it ticked;
	// without a seed this is the plain reset it always was. selectOptions is a route
	// param — immutable for the screen's lifetime — so the first-render closure
	// useEffectOnce captures is exact. Reset on unmount so no selection leaks out.
	useEffectOnce(() => {
		useDriveSelectStore.getState().setSelectedItems(drivePath.selectOptions?.initiallySelected ?? [])

		return () => {
			useDriveSelectStore.getState().setSelectedItems([])
		}
	})

	return null
}

const DriveSelect = () => {
	return (
		<Fragment>
			<Drive />
			<DriveSelectToolbar />
			<DriveSelectListener />
		</Fragment>
	)
}

export default DriveSelect

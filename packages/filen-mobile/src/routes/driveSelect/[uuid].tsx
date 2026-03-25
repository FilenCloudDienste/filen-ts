import Drive from "@/components/drive"
import { Fragment, useEffect, memo, useCallback } from "react"
import DriveSelectToolbar from "@/components/driveSelectToolbar"
import auth, { useSdkClients } from "@/lib/auth"
import events from "@/lib/events"
import { randomUUID } from "expo-crypto"
import { router, useFocusEffect } from "expo-router"
import useDrivePath, { type SelectOptions } from "@/hooks/useDrivePath"
import { Buffer } from "react-native-quick-crypto"
import { pack } from "@/lib/msgpack"
import type { DriveItem } from "@/types"
import useDriveSelectStore from "@/stores/useDriveSelect.store"

export async function selectDriveItems(options: Omit<SelectOptions, "intention" | "id">): Promise<
	| {
			cancelled: true
	  }
	| {
			cancelled: false
			selectedItems: DriveItem[]
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
				selectOptions: Buffer.from(
					pack({
						...options,
						intention: "select",
						id
					} satisfies SelectOptions)
				).toString("base64")
			}
		})
	})
}

const DriveSelectListener = memo(() => {
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

	useFocusEffect(
		useCallback(() => {
			useDriveSelectStore.getState().setSelectedItems([])

			return () => {
				useDriveSelectStore.getState().setSelectedItems([])
			}
		}, [])
	)

	return null
})

const DriveSelect = memo(() => {
	return (
		<Fragment>
			<Drive />
			<DriveSelectToolbar />
			<DriveSelectListener />
		</Fragment>
	)
})

export default DriveSelect

import Drive from "@/features/drive/components"
import { Fragment, useEffect, useRef } from "react"
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

	// Latest values in refs so the cancel effect runs on unmount ONLY — depending on them
	// directly re-runs the cleanup on re-renders (useDrivePath returns a fresh object per
	// render), which can emit a spurious `cancelled: true` that silently aborts the
	// selection flow (same class as the contacts-picker share bug; mirrors playlists.tsx).
	const cancelStateRef = useRef({ drivePath, authedSdkClient })

	useEffect(() => {
		cancelStateRef.current = { drivePath, authedSdkClient }
	})

	useEffect(() => {
		return () => {
			const current = cancelStateRef.current

			if (
				current.drivePath.selectOptions &&
				current.drivePath.selectOptions.intention === "select" &&
				current.authedSdkClient?.root().uuid === current.drivePath.uuid
			) {
				events.emit("driveSelect", {
					id: current.drivePath.selectOptions.id,
					cancelled: true
				})
			}
		}
	}, [])

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

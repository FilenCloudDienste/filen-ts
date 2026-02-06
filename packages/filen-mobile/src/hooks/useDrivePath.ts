import { useLocalSearchParams, useNavigation } from "expo-router"
import { useMemo } from "@/lib/memo"
import type { Contact } from "@filen/sdk-rs"
import { validate as validateUuid } from "uuid"

export const DRIVE_PATH_TYPES = ["drive", "sharedIn", "recents", "favorites", "trash", "sharedOut", "offline"] as const

export type DrivePathType = (typeof DRIVE_PATH_TYPES)[number]

export type DrivePath =
	| {
			type: Exclude<DrivePathType, "sharedOut" | null>
			uuid: string | null
	  }
	| {
			type: null
			uuid: null
	  }
	| {
			type: "sharedOut"
			uuid: string
			contact?: Contact
	  }

export default function useDrivePath(): DrivePath {
	const localSearchParams = useLocalSearchParams<{ uuid?: string }>()
	const navigation = useNavigation()

	const drivePath = useMemo((): DrivePath => {
		const navigationId = navigation.getId() || ""
		const isInDriveTab = navigationId.startsWith("/tabs/drive")
		const isInOfflineTab = navigationId.startsWith("/offline")

		if (isInDriveTab || isInOfflineTab) {
			if (localSearchParams && localSearchParams.uuid && validateUuid(localSearchParams.uuid)) {
				return {
					type: isInDriveTab ? "drive" : "offline",
					uuid: localSearchParams.uuid
				}
			}

			return {
				type: isInDriveTab ? "drive" : "offline",
				uuid: null
			}
		}

		return {
			type: null,
			uuid: null
		}
	}, [localSearchParams, navigation])

	return drivePath
}

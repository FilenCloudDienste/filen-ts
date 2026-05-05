import * as MediaLibraryLegacy from "expo-media-library"
import * as ImagePicker from "expo-image-picker"
import useMediaPermissionsQuery from "@/queries/useMediaPermissions.query"
import { run } from "@filen/utils"
import { useEffect, useRef, useCallback } from "react"
import { AppState } from "react-native"

export type MediaPermissions =
	| {
			loading: true
			error: null
			granted: false
	  }
	| {
			loading: false
			error: unknown
			granted: false
	  }
	| {
			loading: false
			error: null
			granted: boolean
			requestPermissions: () => Promise<boolean>
	  }

export async function hasAllNeededMediaPermissions(params?: { shouldRequest?: boolean }): Promise<boolean> {
	const [mediaLibraryPermissions, cameraPermissions] = await Promise.all([
		MediaLibraryLegacy.getPermissionsAsync(),
		ImagePicker.getCameraPermissionsAsync()
	])

	if (
		mediaLibraryPermissions.granted &&
		mediaLibraryPermissions.accessPrivileges === "all" &&
		mediaLibraryPermissions.expires === "never" &&
		cameraPermissions.granted &&
		cameraPermissions.expires === "never"
	) {
		return true
	}

	if (!params?.shouldRequest) {
		return false
	}

	if (!mediaLibraryPermissions.canAskAgain || !cameraPermissions.canAskAgain) {
		return false
	}

	const mediaLibraryRequest = await MediaLibraryLegacy.requestPermissionsAsync()

	if (!mediaLibraryRequest.granted || mediaLibraryRequest.accessPrivileges !== "all" || mediaLibraryRequest.expires !== "never") {
		return false
	}

	const cameraRequest = await ImagePicker.requestCameraPermissionsAsync()

	if (!cameraRequest.granted || cameraRequest.expires !== "never") {
		return false
	}

	return true
}

export default function useMediaPermissions(params?: { shouldRequest?: boolean }): MediaPermissions {
	const didRequestRef = useRef<boolean>(false)

	const query = useMediaPermissionsQuery()

	const { refetch } = query

	const requestPermissions = useCallback(async () => {
		const result = await run(async defer => {
			defer(() => {
				refetch()
			})

			return await hasAllNeededMediaPermissions({
				shouldRequest: true
			})
		})

		if (!result.success) {
			return false
		}

		return result.data
	}, [refetch])

	useEffect(() => {
		if (params?.shouldRequest && !didRequestRef.current) {
			didRequestRef.current = true

			requestPermissions().catch(console.error)
		}
	}, [params?.shouldRequest, requestPermissions])

	useEffect(() => {
		const listener = AppState.addEventListener("change", nextAppState => {
			if (nextAppState === "active") {
				refetch()
			}
		})

		return () => {
			listener.remove()
		}
	}, [refetch])

	if (query.status === "pending") {
		return {
			loading: true,
			error: null,
			granted: false
		}
	}

	if (query.status === "error") {
		return {
			loading: false,
			error: query.error,
			granted: false
		}
	}

	return {
		loading: false,
		error: null,
		granted:
			query.data.camera.granted &&
			query.data.mediaLibrary.granted &&
			query.data.mediaLibrary.accessPrivileges === "all" &&
			query.data.mediaLibrary.expires === "never" &&
			query.data.camera.expires === "never",
		requestPermissions
	}
}

import * as MediaLibraryLegacy from "expo-media-library/legacy"
import * as ImagePicker from "expo-image-picker"
import useMediaPermissionsQuery from "@/queries/useMediaPermissions.query"
import { run } from "@filen/utils"
import { useEffect, useRef, useCallback } from "react"
import { AppState } from "react-native"
import { withSystemPresentation } from "@/lib/systemPresentation"
import logger from "@/lib/logger"

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

export type MediaPermissionsParams = {
	shouldRequest?: boolean
	/**
	 * Whether to check/request the CAMERA permission.
	 * Only pass true for flows that call `launchCameraAsync`.
	 */
	needCamera?: boolean
	/**
	 * Scope of the media-library check:
	 * - "all"  → requires `granted && accessPrivileges === "all"` (full access, e.g. camera-upload sync)
	 * - "any"  → requires `granted` (limited OR all, e.g. save-to-photos)
	 * - "none" → library check is skipped entirely (PHPicker / camera-only flows)
	 */
	library?: "all" | "any" | "none"
}

export async function hasAllNeededMediaPermissions(params?: MediaPermissionsParams): Promise<boolean> {
	const library = params?.library ?? "all"
	const needCamera = params?.needCamera ?? true

	const [mediaLibraryPermissions, cameraPermissions] = await Promise.all([
		library !== "none" ? MediaLibraryLegacy.getPermissionsAsync() : null,
		needCamera ? ImagePicker.getCameraPermissionsAsync() : null
	])

	// Check current state
	const libraryOk =
		library === "none" ||
		(library === "all"
			? mediaLibraryPermissions !== null &&
			  mediaLibraryPermissions.granted &&
			  mediaLibraryPermissions.accessPrivileges === "all" &&
			  mediaLibraryPermissions.expires === "never"
			: // "any"
			  mediaLibraryPermissions !== null && mediaLibraryPermissions.granted)

	const cameraOk = !needCamera || (cameraPermissions !== null && cameraPermissions.granted && cameraPermissions.expires === "never")

	if (libraryOk && cameraOk) {
		return true
	}

	if (!params?.shouldRequest) {
		return false
	}

	// Determine whether we can ask again for the parts that failed
	const libraryCanAsk = library === "none" || libraryOk || (mediaLibraryPermissions !== null && mediaLibraryPermissions.canAskAgain)
	const cameraCanAsk = !needCamera || cameraOk || (cameraPermissions !== null && cameraPermissions.canAskAgain)

	if (!libraryCanAsk || !cameraCanAsk) {
		return false
	}

	// Request only the permissions we actually need
	if (library !== "none" && !libraryOk) {
		const mediaLibraryRequest = await withSystemPresentation(() => MediaLibraryLegacy.requestPermissionsAsync())

		const requestedLibraryOk =
			library === "all"
				? mediaLibraryRequest.granted && mediaLibraryRequest.accessPrivileges === "all" && mediaLibraryRequest.expires === "never"
				: mediaLibraryRequest.granted

		if (!requestedLibraryOk) {
			return false
		}
	}

	if (needCamera && !cameraOk) {
		const cameraRequest = await withSystemPresentation(() => ImagePicker.requestCameraPermissionsAsync())

		if (!cameraRequest.granted || cameraRequest.expires !== "never") {
			return false
		}
	}

	return true
}

export default function useMediaPermissions(params?: MediaPermissionsParams): MediaPermissions {
	const didRequestRef = useRef<boolean>(false)

	const query = useMediaPermissionsQuery()

	const { refetch } = query

	const requestPermissions = useCallback(async () => {
		const result = await run(async defer => {
			defer(() => {
				refetch()
			})

			return await hasAllNeededMediaPermissions({
				...params,
				shouldRequest: true
			})
		})

		if (!result.success) {
			return false
		}

		return result.data
	}, [params, refetch])

	useEffect(() => {
		if (params?.shouldRequest && !didRequestRef.current) {
			didRequestRef.current = true

			requestPermissions().catch(e => logger.warn("media", "requestPermissions failed on mount", { error: e }))
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

	const library = params?.library ?? "all"
	const needCamera = params?.needCamera ?? true

	const libraryGranted =
		library === "none" ||
		(library === "all"
			? query.data.mediaLibrary.granted &&
			  query.data.mediaLibrary.accessPrivileges === "all" &&
			  query.data.mediaLibrary.expires === "never"
			: query.data.mediaLibrary.granted)

	const cameraGranted = !needCamera || (query.data.camera.granted && query.data.camera.expires === "never")

	return {
		loading: false,
		error: null,
		granted: libraryGranted && cameraGranted,
		requestPermissions
	}
}

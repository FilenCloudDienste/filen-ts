import * as MediaLibraryLegacy from "expo-media-library/legacy"
import * as ImagePicker from "expo-image-picker"
import useMediaPermissionsQuery from "@/queries/useMediaPermissions.query"
import { run } from "@filen/shared"
import { useEffect, useRef, useCallback } from "react"
import useOnAppForeground from "@/hooks/useOnAppForeground"
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

type LibraryScope = NonNullable<MediaPermissionsParams["library"]>

function isLibraryGranted(permissions: MediaLibraryLegacy.PermissionResponse | null, scope: LibraryScope): boolean {
	if (scope === "none") {
		return true
	}

	if (!permissions?.granted) {
		return false
	}

	return scope === "any" || (permissions.accessPrivileges === "all" && permissions.expires === "never")
}

function isCameraGranted(permissions: ImagePicker.CameraPermissionResponse | null): boolean {
	return permissions !== null && permissions.granted && permissions.expires === "never"
}

export async function hasAllNeededMediaPermissions(params?: MediaPermissionsParams): Promise<boolean> {
	const library = params?.library ?? "all"
	const needCamera = params?.needCamera ?? true

	const [mediaLibraryPermissions, cameraPermissions] = await Promise.all([
		library !== "none" ? MediaLibraryLegacy.getPermissionsAsync() : null,
		needCamera ? ImagePicker.getCameraPermissionsAsync() : null
	])

	// Check current state
	const libraryOk = isLibraryGranted(mediaLibraryPermissions, library)
	const cameraOk = !needCamera || isCameraGranted(cameraPermissions)

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

		if (!isLibraryGranted(mediaLibraryRequest, library)) {
			return false
		}
	}

	if (needCamera && !cameraOk) {
		const cameraRequest = await withSystemPresentation(() => ImagePicker.requestCameraPermissionsAsync())

		if (!isCameraGranted(cameraRequest)) {
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

	useOnAppForeground(refetch)

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

	return {
		loading: false,
		error: null,
		granted: isLibraryGranted(query.data.mediaLibrary, library) && (!needCamera || isCameraGranted(query.data.camera)),
		requestPermissions
	}
}

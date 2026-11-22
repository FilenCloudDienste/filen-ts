import { DESKTOP_ONLY_ERROR, MOUNTS_NOT_LOADED_ERROR, mountsStatus, SYNC_NOT_LOADED_ERROR, syncStatus } from "@filen/shared"
import { i18n } from "@/lib/i18n"
import { isDesktopApp } from "@/lib/desktop"
import { queryClient } from "@/queries/client"
import { accountQueryGet } from "@/queries/account"
import { cachedDirectoryName, driveNamesQueryKey } from "@/features/drive/queries/drive"
import { useSyncStore } from "@/features/sync/lib/syncStore"
import { useMountsStore } from "@/features/mounts/lib/mountsStore"
import { AssistantToolError } from "@/features/assistant/tools/format"
import { optionalString, type ToolAdapter } from "@/features/assistant/tools/entities"

// get_desktop_status over the sync and mounts overviews the desktop app holds and keeps current (desktopHost.tsx loads
// them app-wide): no IPC, no request.

// A pair's remote directory by name as the app already holds it: the account root's label, the name entry the sync
// screens read (useRemoteDirectoryName), or a cached listing row. null when none holds it; never fetched here.
function heldRemoteName(uuid: string): string | null {
	if (uuid.length === 0) {
		return null
	}

	if (uuid === accountQueryGet()?.rootDirUuid) {
		return i18n.t("drive:driveMyDrive")
	}

	return queryClient.getQueryData<string | null>(driveNamesQueryKey("drive", uuid)) ?? cachedDirectoryName(uuid) ?? null
}

export const getDesktopStatusTool: ToolAdapter = (input, scope) => {
	if (!isDesktopApp()) {
		throw new AssistantToolError(DESKTOP_ONLY_ERROR)
	}

	if (input["section"] === "mounts") {
		const overview = useMountsStore.getState().overview

		if (overview === null) {
			throw new AssistantToolError(MOUNTS_NOT_LOADED_ERROR)
		}

		return Promise.resolve({ value: mountsStatus(overview) })
	}

	const overview = useSyncStore.getState().overview

	if (overview === null) {
		throw new AssistantToolError(SYNC_NOT_LOADED_ERROR)
	}

	return Promise.resolve({
		value: syncStatus({
			overview,
			query: optionalString(input, "query"),
			handle: pair => scope.show({ kind: "syncPair", pairId: pair.id, name: pair.name }, pair.name),
			remoteName: pair => heldRemoteName(pair.remoteRoot),
			timeZone: scope.calendar.timeZone
		})
	})
}

import { useSyncExternalStore } from "react"
import { useQueries } from "@tanstack/react-query"
import { useTranslation } from "react-i18next"
import { activeLibraryRoots } from "@filen/shared/videos"
import { useLibraryConfigQuery } from "@/features/videos/queries/library"
import { directoryRootChainQueryOptions, useDirectoryRootChainQuery, type DirectoryRootChain } from "@/lib/directoryRoots"
import { videoLibrary } from "@/features/videos/lib/index"
import { libraryRootViews, type VideoLibraryRootView } from "@/features/videos/lib/libraryView.logic"

// The configuration and the index snapshot, joined per directory. Reads only: the Videos layout is what opens
// the library (useVideoLibrary).
export function useVideoLibraryView() {
	const configQuery = useLibraryConfigQuery()
	const snapshot = useSyncExternalStore(videoLibrary.subscribe, videoLibrary.getSnapshot)
	const roots = configQuery.data === undefined ? [] : libraryRootViews(activeLibraryRoots(configQuery.data.doc), snapshot.roots)

	return {
		configQuery,
		snapshot,
		roots
	}
}

function chainName(chain: DirectoryRootChain | undefined, driveName: string): string {
	if (chain === undefined || chain === null) {
		return ""
	}

	return chain.length <= 1 ? driveName : (chain.at(-1)?.name ?? "")
}

function knownName(name: string | undefined): name is string {
	return name !== undefined && name.length > 0
}

// Whether a directory's name has to come from its chain (which takes the drive lock): the index has none for it. A
// directory the index is still loading gets its name from its snapshot, so its chain isn't resolved meanwhile.
function needsChain(root: VideoLibraryRootView | undefined): boolean {
	if (root === undefined) {
		return true
	}

	if (root.enabled && (root.status === undefined || root.status.state === "loading")) {
		return false
	}

	return !knownName(root.status?.name)
}

// A library directory's name: the index's, else (before its first scan, or turned off) the last link of its
// chain. The drive root reads as My Drive.
export function useVideoRootName(uuid: string, root: VideoLibraryRootView | undefined): string {
	const { t } = useTranslation("drive")
	const indexName = root?.status?.name
	const chainQuery = useDirectoryRootChainQuery(uuid, needsChain(root) && uuid.length > 0)

	return knownName(indexName) ? indexName : chainName(chainQuery.data, t("driveMyDrive"))
}

// useVideoRootName for several directories at once, by uuid.
export function useVideoRootNames(roots: readonly VideoLibraryRootView[]): Map<string, string> {
	const { t } = useTranslation("drive")
	const unnamed = roots.filter(needsChain)
	const chains = useQueries({
		queries: unnamed.map(root => directoryRootChainQueryOptions(root.uuid))
	})
	const names = new Map<string, string>()

	for (const root of roots) {
		const indexName = root.status?.name

		names.set(root.uuid, knownName(indexName) ? indexName : chainName(chains[unnamed.indexOf(root)]?.data, t("driveMyDrive")))
	}

	return names
}

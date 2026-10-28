import { useTranslation } from "react-i18next"
import { directoryChainPath, useDirectoryRootChains } from "@/lib/directoryRoots"

export interface PhotosRootView {
	uuid: string
	// Empty while its chain is unresolved (or it can't be found).
	name: string
	// Below the drive root ("/Pictures/2024"); undefined for the whole drive, or while unresolved.
	path: string | undefined
	// Another photos directory holding this one (the timeline reads it through that one), by uuid.
	within: string | undefined
}

// The photos directories with their names and paths, from their chains (shared with the timeline's overlap check,
// so a chain is resolved once). Only while `enabled`.
export function usePhotosRootViews(roots: readonly string[], enabled: boolean): PhotosRootView[] {
	const { t } = useTranslation("drive")
	const chains = useDirectoryRootChains(roots, enabled)
	const rootSet = new Set(roots)

	return roots.map((uuid, index) => {
		const chain = chains[index] ?? null
		const wholeDrive = chain !== null && chain.length <= 1

		return {
			uuid,
			name: chain === null ? "" : wholeDrive ? t("driveMyDrive") : (chain.at(-1)?.name ?? ""),
			path: wholeDrive ? undefined : directoryChainPath(chain),
			within: chain?.slice(0, -1).find(link => link.uuid !== uuid && rootSet.has(link.uuid))?.uuid
		}
	})
}

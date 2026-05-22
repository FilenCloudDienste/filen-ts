import { create } from "zustand"
import type { FileVersion } from "@filen/sdk-rs"
import { toggleInArray } from "@/stores/createSelectionSlice"

export type FileVersionsStore = {
	selectedVersions: FileVersion[]
	setSelectedVersions: (fn: FileVersion[] | ((prev: FileVersion[]) => FileVersion[])) => void
	toggleSelectedVersion: (version: FileVersion) => void
	clearSelectedVersions: () => void
	selectAllVersions: (versions: FileVersion[]) => void
}

const versionId = (v: FileVersion) => v.uuid

export const useFileVersionsStore = create<FileVersionsStore>(set => ({
	selectedVersions: [],
	setSelectedVersions(fn) {
		set(state => ({
			selectedVersions: typeof fn === "function" ? fn(state.selectedVersions) : fn
		}))
	},
	toggleSelectedVersion(version) {
		set(state => ({
			selectedVersions: toggleInArray(state.selectedVersions, version, versionId)
		}))
	},
	clearSelectedVersions() {
		set({ selectedVersions: [] })
	},
	selectAllVersions(versions) {
		set({ selectedVersions: versions })
	}
}))

export default useFileVersionsStore

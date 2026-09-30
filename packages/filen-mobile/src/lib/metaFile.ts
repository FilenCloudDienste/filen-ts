// Sidecar metadata file naming shared by the offline store, file cache and audio cache.
// Dependency-free so test mocks of the storage modules never have to mirror it.

export const META_FILE_SUFFIX = ".filenmeta"

export function metaFileName(id: string): string {
	return `${id}${META_FILE_SUFFIX}`
}

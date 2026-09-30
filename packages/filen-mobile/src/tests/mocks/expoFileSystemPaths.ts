/**
 * Storage-independent Paths pieces shared by the canonical, fast and strict-URI expo-file-system
 * mocks. Their File/Directory backends stay separate on purpose.
 */

export const DOCUMENT_URI = "file:///document"
export const CACHE_URI = "file:///cache"
export const BUNDLE_URI = "file:///bundle"

export function toUriString(value: string | { uri: string }): string {
	return typeof value === "string" ? value : value.uri
}

/** Strips the final /segment (trailing slashes ignored); POSIX "/foo" -> "/", no parent -> DOCUMENT_URI. */
export function dirname(str: string): string {
	let end = str.length

	while (end > 0 && str.charCodeAt(end - 1) === 47) {
		end--
	}

	const idx = str.lastIndexOf("/", end - 1)
	const result = idx === -1 ? "" : str.slice(0, idx)

	if (result.length > 0) {
		return result
	}

	if (str.charCodeAt(0) === 47 && !str.startsWith("file://")) {
		return "/"
	}

	return DOCUMENT_URI
}

export type RootGetters<D> = {
	readonly document: D
	readonly cache: D
	readonly bundle: D
	readonly appleSharedContainers: Record<string, D>
	readonly totalDiskSpace: number
	readonly availableDiskSpace: number
}

function lazy<T>(get: () => T): PropertyDescriptor {
	// Configurable so tests can redefine a getter (e.g. availableDiskSpace).
	return {
		get,
		configurable: true,
		enumerable: true
	}
}

/** Attaches the root getters to `paths` in place. They stay lazy: every access builds a fresh Directory. */
export function withRootGetters<P extends object, D>(paths: P, DirectoryCtor: new (uri: string) => D): P & RootGetters<D> {
	return Object.defineProperties(paths, {
		document: lazy(() => new DirectoryCtor(DOCUMENT_URI)),
		cache: lazy(() => new DirectoryCtor(CACHE_URI)),
		bundle: lazy(() => new DirectoryCtor(BUNDLE_URI)),
		appleSharedContainers: lazy(
			() =>
				new Proxy({} as Record<string, D>, {
					get(_target, prop) {
						return new DirectoryCtor(`file:///shared/${String(prop)}`)
					}
				})
		),
		totalDiskSpace: lazy(() => 256 * 1024 * 1024 * 1024),
		availableDiskSpace: lazy(() => 128 * 1024 * 1024 * 1024)
	}) as P & RootGetters<D>
}

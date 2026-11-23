// The deployed commit (VITE_BUILD_ID, set by the deploy workflows); null in a local build. The page's one reader of it:
// the service worker update check, Settings → Advanced → About → Version and the exported logs' header.
export function buildId(): string | null {
	return import.meta.env.VITE_BUILD_ID ?? null
}

// How a build is named to the user and in exported logs: the commit, or "local" for a build no workflow made.
export function buildLabel(): string {
	return buildId() ?? "local"
}

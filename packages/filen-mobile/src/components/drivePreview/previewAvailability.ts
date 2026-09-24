// fileCache.get serves the offline store and the cache before it downloads, so a read that failed
// while offline means the device holds no copy: the same "unavailable offline" page the gallery
// shows for a URL-backed preview. A paused fetch means the same.
export function isUnavailableOffline(
	query: { status: "pending" | "error" | "success"; fetchStatus: "fetching" | "paused" | "idle" },
	isOnline: boolean
): boolean {
	return query.status !== "success" && (query.fetchStatus === "paused" || (query.status === "error" && !isOnline))
}

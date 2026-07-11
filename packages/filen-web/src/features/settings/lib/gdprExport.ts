import type { GdprInfo } from "@filen/sdk-rs"

// `getGdprInfo()`'s two bigint fields (GdprUser.lastActive/lastActiveChat, unix-ms timestamps)
// cross Comlink fine via structured clone, but `JSON.stringify` throws on a bare bigint — this
// stringifies them as plain decimal strings for the downloaded file. NOT queries/persist.ts's
// "$bigint:" round-trip envelope: that format is for this app's own cache, never a human-facing
// download, and its escaped-prefix bookkeeping would just be noise in an exported data file.
export function gdprInfoToJson(info: GdprInfo): string {
	return JSON.stringify(info, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value), 2)
}

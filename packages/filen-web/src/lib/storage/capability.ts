// Cheap, synchronous signal for whether this browser exposes the OPFS entry point at all.
// `navigator.storage.getDirectory` is spec-required, so TS's own DOM lib types both `Navigator.storage`
// and `StorageManager.getDirectory` as unconditionally present — but real browsers disagree (Firefox
// private windows drop it; old/unsupported browsers never had it), so the `in` check below (not `?.`,
// which the type-checker would flag as unnecessary against those always-present types) is what
// actually catches the gap at runtime.
//
// Presence alone does not prove OPFS WORKS: the SAH-pool VFS db.worker.ts opens additionally needs
// createSyncAccessHandle (MDN: dedicated-worker-only, unrelated to this app's separate cross-origin-
// isolation requirement — that one gates SharedArrayBuffer/wasm threading, see sdk.worker.ts), which
// this cheap check can't probe — it only catches the browser-has-nothing case. A present-but-broken
// API (e.g. Playwright's bundled WebKit, which still exposes getDirectory but fails to actually open a
// SAH pool) is NOT caught here; that narrower case stays the leader's open()-throws path's job (see
// @/lib/sdk/boot).
export function isOpfsApiAvailable(): boolean {
	return "storage" in navigator && typeof navigator.storage.getDirectory === "function"
}

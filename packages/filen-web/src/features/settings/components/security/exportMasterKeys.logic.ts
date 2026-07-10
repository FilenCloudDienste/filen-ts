// Pure helpers backing exportMasterKeys.tsx, split out so both are unit-testable without a
// worker, a query client, or the DOM (see download.ts for why the actual Blob/anchor download
// itself is not unit-tested here).

// Download filename convention for the exported master-keys artifact — kept pure so the exact
// format is asserted independently of the DOM-touching download call it feeds.
export function buildMasterKeysFilename(email: string, timestampMs: number): string {
	return `${email}.masterKeys.${String(timestampMs)}.txt`
}

// Module-level "fired this boot" flags for the two startup reminders — a fresh page load (or tab)
// gets a fresh module instance and can fire again, matching "once per app boot" (there is no
// unlock/lock concept on web to hang a "once per unlock" rule on, unlike a native app's lifecycle).
// Dismissing a reminder ("remind me later") sets its flag so it does not re-appear until the next
// reload. Tests reset these via `vi.resetModules()` + a fresh dynamic import (mirrors the keymap
// registry's own singleton-state test pattern) rather than exposing a test-only reset export.
let keysFired = false
let storageFired = false

export function reminderFired(): boolean {
	return keysFired
}

export function markReminderFired(): void {
	keysFired = true
}

export function storageReminderFired(): boolean {
	return storageFired
}

export function markStorageReminderFired(): void {
	storageFired = true
}

// Pure gating predicate for the boot reminder — deliberately takes `alreadyFired` as an explicit
// argument (rather than reading the module flag above internally) so every case is testable as a
// plain function of its inputs. Fires only once (`alreadyFired`), only once the account query has
// SETTLED successfully (never on pending/error — an error here must not be misread as "keys
// exported"), and only when the server says they genuinely have not been exported yet.
export function shouldShowExportReminder(params: {
	accountStatus: "pending" | "error" | "success"
	didExportMasterKeys: boolean
	alreadyFired: boolean
}): boolean {
	return !params.alreadyFired && params.accountStatus === "success" && !params.didExportMasterKeys
}

// Storage-over-limit trigger, ported verbatim from the mobile account reminders (`storageUsed >
// maxStorage`). Bigint-typed to match UserInfo's fields — never coerce to Number for the comparison.
export function isStorageOverLimit(storageUsed: bigint, maxStorage: bigint): boolean {
	return storageUsed > maxStorage
}

// The two startup reminders, in the order they surface.
export type ReminderKind = "exportKeys" | "storage"

// One-at-a-time selector for the blocking startup reminders: returns the single reminder to surface
// next, keys before storage, or null when none apply. It never returns "storage" while the keys
// reminder is still eligible, so a caller that marks a reminder's fired-flag on dismissal and
// re-evaluates gets the next one in sequence (keys → storage → done) without ever stacking modals.
export function selectActiveReminder(params: {
	accountStatus: "pending" | "error" | "success"
	didExportMasterKeys: boolean
	storageOverLimit: boolean
	keysFired: boolean
	storageFired: boolean
}): ReminderKind | null {
	if (
		shouldShowExportReminder({
			accountStatus: params.accountStatus,
			didExportMasterKeys: params.didExportMasterKeys,
			alreadyFired: params.keysFired
		})
	) {
		return "exportKeys"
	}

	if (params.accountStatus === "success" && !params.storageFired && params.storageOverLimit) {
		return "storage"
	}

	return null
}

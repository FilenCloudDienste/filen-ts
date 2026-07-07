// Pure helpers backing export-master-keys.tsx, split out so both are unit-testable without a
// worker, a query client, or the DOM (see download.ts for why the actual Blob/anchor download
// itself is not unit-tested here).

// Download filename convention for the exported master-keys artifact — kept pure so the exact
// format is asserted independently of the DOM-touching download call it feeds.
export function buildMasterKeysFilename(email: string, timestampMs: number): string {
	return `${email}.masterKeys.${String(timestampMs)}.txt`
}

// Module-level "fired this boot" flag for the export-keys reminder toast — a fresh page load (or
// tab) gets a fresh module instance and can fire again, matching "once per app boot" (there is no
// unlock/lock concept on web to hang a "once per unlock" rule on, unlike a native app's lifecycle).
// Tests reset this via `vi.resetModules()` + a fresh dynamic import (mirrors the keymap registry's
// own singleton-state test pattern) rather than exposing a test-only reset export.
let fired = false

export function reminderFired(): boolean {
	return fired
}

export function markReminderFired(): void {
	fired = true
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

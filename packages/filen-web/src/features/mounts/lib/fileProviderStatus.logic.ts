import type { DesktopFileProviderErrorCode, DesktopFileProviderState } from "@filen/shared/desktop"
import type { MountsKey } from "@/lib/i18n"
import type { DesktopCalloutTone } from "@/features/desktop/components/desktopCallout"
import type { RoleTone } from "@/features/mounts/lib/mountsStatus.logic"

// Filen in Finder as its card shows it. `needsEnabling`: on here, but switched off in System Settings.
export type FileProviderStatus = "off" | "starting" | "stopping" | "on" | "needsEnabling" | "error"

// A switch the page asked the shell for and is waiting on.
export type FileProviderPending = "enable" | "disable" | null

// Before the first read (null) it reads as off. A failure the page met wins over what the shell reports; on without a
// domain macOS knows means registering it failed.
export function fileProviderStatus(
	state: DesktopFileProviderState | null,
	pending: FileProviderPending,
	error: DesktopFileProviderErrorCode | null
): FileProviderStatus {
	if (pending !== null) {
		return pending === "enable" ? "starting" : "stopping"
	}

	if (error !== null) {
		return "error"
	}

	if (!state?.enabled) {
		return "off"
	}

	if (state.userEnabled === null) {
		return "error"
	}

	return state.userEnabled ? "on" : "needsEnabling"
}

export const FILE_PROVIDER_STATUS_KEY: Record<FileProviderStatus, MountsKey> = {
	off: "stateOff",
	starting: "stateStarting",
	stopping: "stateStopping",
	on: "finderStateOn",
	needsEnabling: "finderStateNeedsEnabling",
	error: "stateError"
}

export const FILE_PROVIDER_STATUS_TONE: Record<FileProviderStatus, RoleTone> = {
	off: "off",
	starting: "busy",
	stopping: "busy",
	on: "on",
	needsEnabling: "warning",
	error: "error"
}

// The switch waits for the first read and for a call in flight; turning it on waits for the app lock to go and for
// the app to run from Applications. Turning it off is always possible.
export function fileProviderSwitchLocked(state: DesktopFileProviderState | null, pending: FileProviderPending): boolean {
	return state === null || pending !== null || !state.supported || (!state.enabled && (state.lockBlocked || state.translocated))
}

// What the card explains under it, most fundamental first.
export type FileProviderCallout = "translocated" | "lockBlocked" | "needsEnabling" | "notRegistered" | "error"

export function fileProviderCallouts(
	state: DesktopFileProviderState | null,
	pending: FileProviderPending,
	error: DesktopFileProviderErrorCode | null
): FileProviderCallout[] {
	if (state === null) {
		return []
	}

	const callouts: FileProviderCallout[] = []

	if (state.translocated) {
		callouts.push("translocated")
	}

	if (state.lockBlocked) {
		callouts.push("lockBlocked")
	}

	if (pending !== null) {
		return callouts
	}

	// A refusal its own callout already explains is not told twice.
	const explained = (error === "translocated" && state.translocated) || (error === "appLocked" && state.lockBlocked)

	if (error !== null) {
		if (!explained) {
			callouts.push("error")
		}
	} else if (state.enabled && state.userEnabled === false) {
		callouts.push("needsEnabling")
	} else if (state.enabled && state.userEnabled === null) {
		callouts.push("notRegistered")
	}

	return callouts
}

export const FILE_PROVIDER_CALLOUT_TONE: Record<FileProviderCallout, DesktopCalloutTone> = {
	translocated: "warning",
	lockBlocked: "info",
	needsEnabling: "warning",
	notRegistered: "error",
	error: "error"
}

// The text of every callout but `error`, which tells its error's own.
export const FILE_PROVIDER_CALLOUT_KEY: Record<Exclude<FileProviderCallout, "error">, MountsKey> = {
	translocated: "finderTranslocated",
	lockBlocked: "finderLockBlocked",
	needsEnabling: "finderNeedsEnabling",
	notRegistered: "finderNotRegistered"
}

export const FILE_PROVIDER_ERROR_KEY: Record<DesktopFileProviderErrorCode, MountsKey> = {
	unsupported: "finderErrorUnsupported",
	appLocked: "finderLockBlocked",
	noSession: "finderErrorNoSession",
	translocated: "finderTranslocated",
	extensionMissing: "errorBinaryInvalid",
	notFound: "finderErrorNotFound",
	timeout: "errorTimeout",
	unknown: "errorUnknown"
}

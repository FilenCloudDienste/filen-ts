import type { DesktopPlatform, DesktopSyncActivityKind, DesktopSyncHostState } from "@filen/shared/desktop"
import type { NativeActivity, NativeAggregate } from "../../shared/nativeProtocol.ts"

export type TrayState = "idle" | "syncing" | "attention"

// A host that gave up needs the user as much as a pair does; one that is off or starting has nothing to show.
export function trayState(aggregate: NativeAggregate, host: DesktopSyncHostState): TrayState {
	if (host.state === "failed") {
		return "attention"
	}

	return host.state === "running" ? aggregate : "idle"
}

// The status line of the tray menu, and the tooltip's second half; null while sync is off.
export function traySyncStatus(state: TrayState, host: DesktopSyncHostState): string | null {
	if (state === "attention") {
		return host.state === "failed" ? "Sync stopped" : "Sync needs attention"
	}

	if (state === "syncing") {
		return "Syncing…"
	}

	return host.state === "running" ? "Sync up to date" : null
}

export function trayTooltip(state: TrayState, host: DesktopSyncHostState): string {
	const status = traySyncStatus(state, host)

	return status === null ? "Filen" : `Filen: ${status}`
}

// macOS takes template images (a name ending in "Template"; the @2x sibling loads with it); Windows an icon; Linux
// a plain PNG.
export function trayIconFile(platform: DesktopPlatform, state: TrayState): string {
	if (platform === "darwin") {
		return state === "idle" ? "trayTemplate.png" : `tray${state === "syncing" ? "Syncing" : "Attention"}Template.png`
	}

	const suffix = state === "idle" ? "" : `-${state}`

	return platform === "win32" ? `tray${suffix}.ico` : `tray${suffix}.png`
}

// A notification is due once per entry into attention, not for every change while it lasts.
export function attentionTransitions(prev: TrayState, next: TrayState): boolean {
	return next === "attention" && prev !== "attention"
}

const ATTENTION_KINDS: ReadonlySet<DesktopSyncActivityKind> = new Set(["conflict", "deletionsHeld", "passFailed", "failed"])

// The pair a notification opens: the last one whose activity asked for the user.
export function attentionPair(entries: readonly NativeActivity[], current: string | null): string | null {
	return entries.findLast(entry => ATTENTION_KINDS.has(entry.kind))?.pairId ?? current
}

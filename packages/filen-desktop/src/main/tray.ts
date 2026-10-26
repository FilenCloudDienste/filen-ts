import type { DesktopMountsRole, DesktopPlatform, DesktopSyncActivityKind, DesktopSyncHostState } from "@filen/shared/desktop"
import type { NativeActivity, NativeAggregate, NativeMountsStatus } from "../shared/nativeProtocol.ts"

export type TrayState = "idle" | "syncing" | "attention"

const RANK: Record<TrayState, number> = { idle: 0, syncing: 1, attention: 2 }

// What mounts add to the tray: a role that failed needs the user; uploads the drive still holds are work in progress.
export function mountsAggregate(status: NativeMountsStatus | null): NativeAggregate {
	if (status === null) {
		return "idle"
	}

	if (status.roles.some(role => role.state === "error")) {
		return "attention"
	}

	return (status.uploads?.pending ?? 0) > 0 ? "syncing" : "idle"
}

// A host that gave up needs the user as much as a pair or a mount does; one that is off or starting has nothing to
// show. Otherwise the more urgent of sync and mounts.
export function trayState(sync: NativeAggregate, mounts: NativeAggregate, host: DesktopSyncHostState): TrayState {
	if (host.state === "failed") {
		return "attention"
	}

	if (host.state !== "running") {
		return "idle"
	}

	return RANK[sync] >= RANK[mounts] ? sync : mounts
}

// Sync's line of the tray menu; null while sync is off.
export function traySyncStatus(state: TrayState, host: DesktopSyncHostState): string | null {
	if (state === "attention") {
		return host.state === "failed" ? "Sync stopped" : "Sync needs attention"
	}

	if (state === "syncing") {
		return "Syncing…"
	}

	return host.state === "running" ? "Sync up to date" : null
}

// The tray menu's status lines, the most urgent first: sync's, then what the mounts report. `mountPoint` is where the
// drive is mounted now, null while it is not.
export function trayStatusLines(
	sync: NativeAggregate,
	mounts: NativeAggregate,
	host: DesktopSyncHostState,
	mountPoint: string | null
): string[] {
	const running = host.state === "running"
	const syncState = trayState(sync, "idle", host)
	const syncLine = traySyncStatus(syncState, host)
	const mountsLine = running && mounts === "attention" ? "Mounts need attention" : null
	const urgent = syncState === "attention" ? [syncLine, mountsLine] : [mountsLine, syncLine]

	return [
		...urgent,
		running && mounts === "syncing" ? "Uploading from the network drive…" : null,
		running && mountPoint !== null ? `Network drive: mounted at ${mountPoint}` : null
	].filter(line => line !== null)
}

export function trayTooltip(lines: readonly string[]): string {
	return lines[0] === undefined ? "Filen" : `Filen: ${lines[0]}`
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

// The roles that went into error between two statuses; a role already failing is not told again.
export function newlyFailedRoles(prev: NativeMountsStatus | null, next: NativeMountsStatus | null): DesktopMountsRole[] {
	const failed = new Set(prev?.roles.filter(role => role.state === "error").map(role => role.role))

	return (next?.roles ?? []).filter(role => role.state === "error" && !failed.has(role.role)).map(role => role.role)
}

const ROLE_NAMES: Record<DesktopMountsRole, string> = {
	drive: "The network drive",
	webdav: "The WebDAV server",
	s3: "The S3 server",
	ftp: "The FTP server",
	sftp: "The SFTP server",
	http: "The HTTP server",
	restic: "The restic server",
	nfs: "The NFS server"
}

export function roleFailureMessage(roles: readonly DesktopMountsRole[]): string {
	const [first] = roles

	return first === undefined || roles.length > 1
		? "Mounts stopped. Open Filen to see why."
		: `${ROLE_NAMES[first]} stopped. Open Filen to see why.`
}

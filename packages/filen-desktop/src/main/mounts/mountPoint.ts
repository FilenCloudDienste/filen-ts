import { lstat, opendir, realpath, stat } from "node:fs/promises"
import path from "node:path"
import { type } from "arktype"
import type { OpenDialogOptions, OpenDialogReturnValue } from "electron"
import type { DesktopMountPointChoice, DesktopMountPointProblem } from "@filen/shared/desktop"
import { driveLetterSchema } from "../../shared/nativeProtocol.ts"
import { isWithin, realOrSelf, type RootTokens, samePath } from "../sync/localRoot.ts"
import type { MountsConfig } from "./store.ts"

// Where the network drive may be mounted on macOS and Linux: an empty directory of the user's own, never home itself,
// app data, a temporary directory (the old client's /tmp/filen) or a sync pair's root. Windows mounts on a drive
// letter instead. Every path is absolute and real; inspectMountPoint resolves them.
export interface MountPointContext {
	platform: NodeJS.Platform
	home: string
	// The app's own data directory and the OS's per-user app data root.
	appData: readonly string[]
	temporary: readonly string[]
	// The local roots of the user's sync pairs.
	pairRoots: readonly string[]
}

export interface MountPointEntry {
	directory: boolean
	// The chosen path is a symlink itself.
	symlink: boolean
	empty: boolean
}

export function mountPointProblem(realPath: string, ctx: MountPointContext, entry: MountPointEntry): DesktopMountPointProblem | null {
	if (!entry.directory) {
		return "notDirectory"
	}

	if (entry.symlink) {
		return "symlink"
	}

	const inside = (other: string) => isWithin(realPath, other, ctx.platform)
	const contains = (other: string) => isWithin(other, realPath, ctx.platform)

	if (samePath(realPath, ctx.home, ctx.platform)) {
		return "homeDirectory"
	}

	if (ctx.appData.some(dir => inside(dir) || contains(dir))) {
		return "appData"
	}

	if (ctx.temporary.some(dir => inside(dir) || contains(dir))) {
		return "temporary"
	}

	if (!inside(ctx.home)) {
		return "outsideHome"
	}

	if (ctx.pairRoots.some(inside)) {
		return "insidePair"
	}

	if (ctx.pairRoots.some(contains)) {
		return "containsPair"
	}

	return entry.empty ? null : "notEmpty"
}

// Windows letters from X down to D, the old client's default first.
const LETTERS_FROM_X = "XWVUTSRQPONMLKJIHGFED".split("")

// `<home>/Filen` on macOS and Linux; on Windows the first of X..D among `available` (rcloneAvailableDriveLetters), or
// null when none is free.
export function defaultMountPoint(home: string, platform: NodeJS.Platform, available: readonly string[]): string | null {
	if (platform !== "win32") {
		return path.posix.join(home, "Filen")
	}

	return LETTERS_FROM_X.find(letter => available.includes(letter)) ?? null
}

// A letter the page sent: D-Z and free now.
export function validDriveLetter(value: unknown, available: readonly string[]): value is string {
	return typeof value === "string" && !(driveLetterSchema(value) instanceof type.errors) && available.includes(value)
}

// What a sync pair may not overlap: the drive's mount point (or the root of its letter), whether mounted now or not.
export function configuredMountPoints(config: MountsConfig, platform: NodeJS.Platform): string[] {
	const { mountPoint, driveLetter } = config.drive

	if (platform === "win32") {
		return driveLetter === null ? [] : [`${driveLetter}:\\`]
	}

	return mountPoint === null ? [] : [mountPoint]
}

export interface InspectedMountPoint {
	path: string
	problem: DesktopMountPointProblem | null
}

async function isEmpty(dir: string): Promise<boolean> {
	const handle = await opendir(dir)

	try {
		return (await handle.read()) === null
	} finally {
		await handle.close()
	}
}

// Resolves the chosen directory and the context's own directories (macOS /tmp is /private/tmp) and checks it. Also
// the re-check before mounting, since the directory may have changed since it was chosen.
export async function inspectMountPoint(chosen: string, ctx: MountPointContext): Promise<InspectedMountPoint> {
	let real: string
	let symlink: boolean

	try {
		symlink = (await lstat(chosen)).isSymbolicLink()
		real = await realpath(chosen)
	} catch {
		return { path: chosen, problem: "notDirectory" }
	}

	const directory = await stat(real).then(
		stats => stats.isDirectory(),
		() => false
	)
	const empty =
		directory &&
		(await isEmpty(real).then(
			result => result,
			() => false
		))
	const [home, appData, temporary] = await Promise.all([
		realOrSelf(ctx.home),
		Promise.all(ctx.appData.map(realOrSelf)),
		Promise.all(ctx.temporary.map(realOrSelf))
	])

	return { path: real, problem: mountPointProblem(real, { ...ctx, home, appData, temporary }, { directory, symlink, empty }) }
}

// The main-owned directory dialog; `showOpenDialog` is bound to the asking window. The page gets an id for the
// directory (single use, ten minutes), never a path to send back.
export async function chooseMountPoint(
	showOpenDialog: (options: OpenDialogOptions) => Promise<OpenDialogReturnValue>,
	context: () => MountPointContext | Promise<MountPointContext>,
	tokens: RootTokens
): Promise<DesktopMountPointChoice> {
	const result = await showOpenDialog({
		title: "Choose where to mount the network drive",
		properties: ["openDirectory", "createDirectory"]
	})
	const chosen = result.filePaths[0]

	if (result.canceled || chosen === undefined) {
		return { status: "canceled" }
	}

	const inspected = await inspectMountPoint(chosen, await context())

	return inspected.problem === null
		? { status: "ok", id: tokens.issue(inspected.path), path: inspected.path }
		: { status: "refused", path: inspected.path, problem: inspected.problem }
}

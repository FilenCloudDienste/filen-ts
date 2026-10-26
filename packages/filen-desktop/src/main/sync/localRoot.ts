import { randomBytes } from "node:crypto"
import { access, constants, realpath, stat } from "node:fs/promises"
import path from "node:path"
import type { OpenDialogOptions, OpenDialogReturnValue } from "electron"
import type { DesktopSyncLocalRootChoice, DesktopSyncRootProblem, DesktopSyncRootWarning } from "@filen/shared/desktop"

// Where a sync pair's local root may not be. Every path is absolute; the checks resolve none of them, so the caller
// passes real paths (inspectLocalRoot does).
export interface LocalRootContext {
	platform: NodeJS.Platform
	home: string
	// The app's own data directory and the OS's per-user app data root.
	appData: readonly string[]
	temporary: readonly string[]
	// The local roots of the user's pairs, the ones the engine does not hold yet included.
	pairRoots: readonly string[]
	mountPoints: readonly string[]
	// Windows: the OneDrive roots the environment names.
	oneDrive: readonly string[]
}

export interface LocalRootEntry {
	directory: boolean
	writable: boolean
}

// A Windows path as the engine canonicalizes it may carry the verbatim prefix (\\?\C:\…, \\?\UNC\server\share).
export function stripVerbatim(localRoot: string): string {
	if (localRoot.startsWith("\\\\?\\UNC\\")) {
		return `\\\\${localRoot.slice(8)}`
	}

	return localRoot.startsWith("\\\\?\\") ? localRoot.slice(4) : localRoot
}

function pathsOf(platform: NodeJS.Platform): path.PlatformPath {
	return platform === "win32" ? path.win32 : path.posix
}

// Windows and macOS file systems are case-insensitive by default, so containment is too: refusing a case-sensitive
// volume's look-alike is the safe side.
function comparable(value: string, platform: NodeJS.Platform): string {
	const resolved = pathsOf(platform).resolve(platform === "win32" ? stripVerbatim(value) : value)

	return platform === "linux" ? resolved : resolved.toLowerCase()
}

// `child` is `parent` or inside it; both comparable.
function within(child: string, parent: string, separator: string): boolean {
	return child === parent || child.startsWith(parent.endsWith(separator) ? parent : `${parent}${separator}`)
}

export function localRootProblem(realPath: string, ctx: LocalRootContext, entry: LocalRootEntry): DesktopSyncRootProblem | null {
	if (!entry.directory) {
		return "notDirectory"
	}

	if (!entry.writable) {
		return "notWritable"
	}

	const paths = pathsOf(ctx.platform)
	const target = comparable(realPath, ctx.platform)
	const inside = (other: string) => within(target, comparable(other, ctx.platform), paths.sep)
	const contains = (other: string) => within(comparable(other, ctx.platform), target, paths.sep)

	if (paths.parse(target).root === target) {
		return "filesystemRoot"
	}

	if (target === comparable(ctx.home, ctx.platform)) {
		return "homeDirectory"
	}

	if (ctx.appData.some(dir => inside(dir) || contains(dir))) {
		return "appData"
	}

	if (ctx.temporary.some(dir => inside(dir) || contains(dir))) {
		return "temporary"
	}

	if (ctx.pairRoots.some(inside)) {
		return "insidePair"
	}

	if (ctx.pairRoots.some(contains)) {
		return "containsPair"
	}

	if (ctx.mountPoints.some(inside)) {
		return "insideMount"
	}

	if (ctx.mountPoints.some(contains)) {
		return "containsMount"
	}

	return null
}

// Directories another app syncs. Both apps then write the same files, which the user may want, so these only warn.
export function localRootWarnings(realPath: string, ctx: LocalRootContext): DesktopSyncRootWarning[] {
	const paths = pathsOf(ctx.platform)
	const target = comparable(realPath, ctx.platform)
	const inside = (dir: string) => within(target, comparable(dir, ctx.platform), paths.sep)

	if (ctx.platform === "darwin") {
		const library = paths.join(ctx.home, "Library")
		const cloudStorage = paths.join(library, "CloudStorage")

		if (inside(paths.join(library, "Mobile Documents"))) {
			return ["iCloud"]
		}

		if (inside(cloudStorage)) {
			// File providers mount at CloudStorage/<Provider>-<account>.
			const provider = target.slice(comparable(cloudStorage, ctx.platform).length + 1)

			return [provider.startsWith("onedrive") ? "oneDrive" : "cloudStorage"]
		}
	}

	return ctx.oneDrive.some(inside) ? ["oneDrive"] : []
}

export interface InspectedRoot {
	path: string
	problem: DesktopSyncRootProblem | null
	warnings: DesktopSyncRootWarning[]
}

async function realOrSelf(value: string): Promise<string> {
	try {
		return await realpath(value)
	} catch {
		return value
	}
}

// Resolves the chosen directory and the context's own directories (macOS /var is /private/var) and checks it. Also
// the re-check addPair runs on a token's path, which may have changed since it was chosen.
export async function inspectLocalRoot(chosen: string, ctx: LocalRootContext): Promise<InspectedRoot> {
	let real: string

	try {
		real = await realpath(chosen)
	} catch {
		return { path: chosen, problem: "notDirectory", warnings: [] }
	}

	const directory = await stat(real).then(
		stats => stats.isDirectory(),
		() => false
	)
	const writable =
		directory &&
		(await access(real, constants.W_OK).then(
			() => true,
			() => false
		))
	const [home, appData, temporary, oneDrive] = await Promise.all([
		realOrSelf(ctx.home),
		Promise.all(ctx.appData.map(realOrSelf)),
		Promise.all(ctx.temporary.map(realOrSelf)),
		Promise.all(ctx.oneDrive.map(realOrSelf))
	])
	const resolved = { ...ctx, home, appData, temporary, oneDrive }
	const problem = localRootProblem(real, resolved, { directory, writable })

	return { path: real, problem, warnings: problem === null ? localRootWarnings(real, resolved) : [] }
}

export const ROOT_TOKEN_TTL_MS = 10 * 60 * 1000

// Opaque stand-ins for chosen directories: the page names a root by id, never by path. Each id works once, within
// ten minutes.
export interface RootTokens {
	issue(root: string): string
	take(id: string): string | null
}

export function createRootTokens(now: () => number): RootTokens {
	const tokens = new Map<string, { path: string; expiresAt: number }>()

	return {
		issue: root => {
			const at = now()

			for (const [id, token] of tokens) {
				if (token.expiresAt <= at) {
					tokens.delete(id)
				}
			}

			const id = randomBytes(16).toString("hex")

			tokens.set(id, { path: root, expiresAt: at + ROOT_TOKEN_TTL_MS })

			return id
		},
		take: id => {
			const token = tokens.get(id)

			if (token === undefined) {
				return null
			}

			tokens.delete(id)

			return token.expiresAt > now() ? token.path : null
		}
	}
}

// The main-owned directory dialog; `showOpenDialog` is bound to the asking window.
export async function chooseLocalDirectory(
	showOpenDialog: (options: OpenDialogOptions) => Promise<OpenDialogReturnValue>,
	context: () => LocalRootContext | Promise<LocalRootContext>,
	tokens: RootTokens
): Promise<DesktopSyncLocalRootChoice> {
	const result = await showOpenDialog({ title: "Choose a directory to sync", properties: ["openDirectory", "createDirectory"] })
	const chosen = result.filePaths[0]

	if (result.canceled || chosen === undefined) {
		return { status: "canceled" }
	}

	const ctx = await context()
	const inspected = await inspectLocalRoot(chosen, ctx)

	if (inspected.problem !== null) {
		return { status: "refused", path: inspected.path, problem: inspected.problem }
	}

	return {
		status: "ok",
		id: tokens.issue(inspected.path),
		path: inspected.path,
		name: pathsOf(ctx.platform).basename(inspected.path),
		warnings: inspected.warnings
	}
}

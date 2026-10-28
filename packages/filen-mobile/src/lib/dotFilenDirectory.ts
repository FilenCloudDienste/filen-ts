import auth from "@/lib/auth"
import { AnyNormalDir, CreatedTime, DirMeta_Tags, type Dir, type JsClientInterface } from "@filen/sdk-rs"
import { DOT_FILEN_DIR_NAME, dotFilenSubdirLookupNames, dotFilenSubdirRename } from "@filen/shared"
import { toSignalOpts } from "@/lib/signals"
import { useSocketStore } from "@/stores/useSocket.store"
import events from "@/lib/events"
import logger from "@/lib/logger"
import { forgetKnownDotFilenDirs, noteKnownDotFilenDirs } from "@/lib/dotFilenKnown"

// Resolved subdirectories, trusted only within the socket session that resolved them: while it stays
// connected every directory change reaches the drive socket handler, which clears this.
const memo = new Map<string, { sub: Dir; connectedAt: number }>()
// Bumped on every clear, so a resolve that overlapped one never stores what it listed before it.
let generation = 0

export function clearDotFilenDirectoryMemo(): void {
	generation++
	memo.clear()
}

// Local moves, renames, trashes and deletes land before their socket echo.
events.subscribe("driveItemRemoved", clearDotFilenDirectoryMemo)
events.subscribe("driveItemUpdated", clearDotFilenDirectoryMemo)
events.subscribe("logout", clearDotFilenDirectoryMemo)
events.subscribe("logout", forgetKnownDotFilenDirs)

type SignalOpts = ReturnType<typeof toSignalOpts>

// A subdirectory under each name it is looked up under (dotFilenSubdirLookupNames), the canonical one first.
async function findSubdirUuid(client: JsClientInterface, dotFilenUuid: string, name: string, opts: SignalOpts): Promise<string | undefined> {
	for (const candidate of dotFilenSubdirLookupNames(name)) {
		const uuid = await client.findDirUuid(dotFilenUuid, candidate, opts)

		if (uuid !== undefined) {
			return uuid
		}
	}

	return undefined
}

// A subdirectory found under another case or a legacy name takes its canonical one, best-effort: a failed rename is
// logged and the directory used as it is. The fetched Dir carries the name, so the check costs nothing.
async function canonicalized(client: JsClientInterface, sub: Dir, name: string, opts: SignalOpts): Promise<Dir> {
	const rename = sub.meta.tag === DirMeta_Tags.Decoded ? dotFilenSubdirRename(sub.meta.inner[0].name, name) : null

	if (rename === null) {
		return sub
	}

	try {
		return await client.updateDirMetadata(sub, { name: rename, created: CreatedTime.Keep.new() }, opts)
	} catch (error) {
		logger.warn("dotFilen", "could not rename a .filen subdirectory to its canonical name", { error, name })

		return sub
	}
}

// Every feature must resolve the same root-level ".filen" directory, so the name match lives here once. Each level is
// found by name hash (one request, no listing or decryption, case-insensitive like the server's hash); only the
// directory handed back is fetched whole, and ".filen" itself only when a missing subdirectory must be created in it.
// `name` is one of DOT_FILEN_SUBDIRS.
export async function ensureDotFilenSubdirectory(name: string, signal?: AbortSignal): Promise<Dir> {
	const socket = useSocketStore.getState()
	const memoized = memo.get(name)

	if (socket.state === "connected" && memoized && memoized.connectedAt === socket.connectedAt) {
		return memoized.sub
	}

	const resolvedGeneration = generation
	const connectedAt = socket.connectedAt
	const opts = toSignalOpts(signal)
	const { authedSdkClient } = await auth.getSdkClients()
	const rootUuid = authedSdkClient.root().uuid
	const dotFilenUuid = await authedSdkClient.findDirUuid(rootUuid, DOT_FILEN_DIR_NAME, opts)
	let sub: Dir
	let parent: string

	if (dotFilenUuid === undefined) {
		const dotFilenDir = await authedSdkClient.createDir(
			new AnyNormalDir.Root({
				uuid: rootUuid
			}),
			DOT_FILEN_DIR_NAME,
			opts
		)

		// Created just now: it has no children to find.
		sub = await authedSdkClient.createDir(new AnyNormalDir.Dir(dotFilenDir), name, opts)
		parent = dotFilenDir.uuid
	} else {
		parent = dotFilenUuid

		const subUuid = await findSubdirUuid(authedSdkClient, dotFilenUuid, name, opts)

		// createDir is find-or-create, so it too may hand back one made elsewhere under another case.
		sub = await canonicalized(
			authedSdkClient,
			subUuid !== undefined
				? await authedSdkClient.getDir(subUuid, opts)
				: await authedSdkClient.createDir(new AnyNormalDir.Dir(await authedSdkClient.getDir(dotFilenUuid, opts)), name, opts),
			name,
			opts
		)
	}

	// Not when a clear (a logout among them) overlapped this resolve.
	if (generation === resolvedGeneration) {
		noteKnownDotFilenDirs(parent, sub.uuid)
	}

	const after = useSocketStore.getState()

	if (after.state === "connected" && after.connectedAt === connectedAt && generation === resolvedGeneration) {
		memo.set(name, {
			sub,
			connectedAt
		})
	}

	return sub
}

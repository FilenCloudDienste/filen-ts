import auth from "@/lib/auth"
import { AnyNormalDir, DirMeta_Tags, type Dir, type JsClientInterface } from "@filen/sdk-rs"
import { toSignalOpts } from "@/lib/signals"
import { useSocketStore } from "@/stores/useSocket.store"
import events from "@/lib/events"

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

async function findOrCreateDir(client: JsClientInterface, parent: AnyNormalDir, name: string, signal?: AbortSignal): Promise<Dir> {
	const lowerName = name.toLowerCase()
	const existing = (await client.listDir(parent, toSignalOpts(signal))).dirs.find(
		d => d.meta.tag === DirMeta_Tags.Decoded && d.meta.inner[0].name.trim().toLowerCase() === lowerName
	)

	return existing ?? (await client.createDir(parent, name, toSignalOpts(signal)))
}

// Every feature must resolve the same root-level ".filen" directory, so the name match lives here once.
export async function ensureDotFilenSubdirectory(name: string, signal?: AbortSignal): Promise<Dir> {
	const socket = useSocketStore.getState()
	const memoized = memo.get(name)

	if (socket.state === "connected" && memoized && memoized.connectedAt === socket.connectedAt) {
		return memoized.sub
	}

	const resolvedGeneration = generation
	const connectedAt = socket.connectedAt
	const { authedSdkClient } = await auth.getSdkClients()
	const dotFilenDir = await findOrCreateDir(
		authedSdkClient,
		new AnyNormalDir.Root({
			uuid: authedSdkClient.root().uuid
		}),
		".filen",
		signal
	)
	const sub = await findOrCreateDir(authedSdkClient, new AnyNormalDir.Dir(dotFilenDir), name, signal)
	const after = useSocketStore.getState()

	if (after.state === "connected" && after.connectedAt === connectedAt && generation === resolvedGeneration) {
		memo.set(name, {
			sub,
			connectedAt
		})
	}

	return sub
}

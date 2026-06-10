export type RemoteTreeEntry = {
	uuid: string
	// Raw root-relative path with leading "/" — original decrypted names, NEVER decoded or encoded.
	path: string
	isDirectory: boolean
}

export type LocalTreeEntry = {
	uuid: string
	path: string
	isDirectory: boolean
	existsOnDisk: boolean
}

export type TreeOp =
	| { type: "move"; uuid: string; from: string; to: string; isDirectory: boolean }
	| { type: "delete"; uuid: string; path: string; isDirectory: boolean }

export type TreeReconcilePlan = {
	// Ordered: phase-1 extractions (deepest current path first), deletes (deepest first), phase-2 placements (shallowest destination first).
	ops: TreeOp[]
	missingUuids: string[]
}

const TMP_NAME_PREFIX = ".sync-tmp-"
const TMP_PREFIX = `/${TMP_NAME_PREFIX}`

export function tmpPathForUuid(uuid: string): string {
	return `${TMP_PREFIX}${uuid}`
}

export function isSyncTmpName(name: string): boolean {
	return name.startsWith(TMP_NAME_PREFIX)
}

// Extracts the uuid a /.sync-tmp-{uuid} extraction temp was created for (crash-recovery rescue
// keys the temp back into the current meta by this uuid). Null for non-temp or malformed names.
export function uuidFromSyncTmpName(name: string): string | null {
	if (!isSyncTmpName(name)) {
		return null
	}

	const uuid = name.slice(TMP_NAME_PREFIX.length)

	return uuid.length > 0 ? uuid : null
}

function depth(path: string): number {
	return path.split("/").length
}

// Rewrite the simulated location of `from` and everything under it to live under `to`.
function rewritePrefix(paths: Map<string, string>, from: string, to: string): void {
	const fromPrefix = `${from}/`

	for (const [uuid, p] of paths) {
		if (p === from) {
			paths.set(uuid, to)
		} else if (p.startsWith(fromPrefix)) {
			paths.set(uuid, `${to}/${p.slice(fromPrefix.length)}`)
		}
	}
}

export function planTreeReconcile({
	remote,
	local,
	allowDeletes
}: {
	remote: Map<string, RemoteTreeEntry>
	local: LocalTreeEntry[]
	allowDeletes: boolean
}): TreeReconcilePlan {
	const ops: TreeOp[] = []
	const missingUuids: string[] = []
	const localByUuid = new Map<string, LocalTreeEntry>()
	// Simulated on-disk location per uuid; only physically present entries participate in moves/deletes.
	const simulated = new Map<string, string>()

	for (const entry of local) {
		localByUuid.set(entry.uuid, entry)

		if (entry.existsOnDisk) {
			simulated.set(entry.uuid, entry.path)
		}
	}

	for (const uuid of remote.keys()) {
		if (!simulated.has(uuid)) {
			missingUuids.push(uuid)
		}
	}

	// Reduction pass: find EXPLICIT movers — entries whose path change is not already explained by a
	// moving ancestor directory. Processing shallowest-local-first and rewriting a scratch map after
	// each prospective dir move collapses "10k children of a renamed dir" into one explicit mover.
	const scratch = new Map(simulated)
	const explicit: string[] = []
	const candidates = [...scratch.keys()]
		.filter(uuid => {
			const r = remote.get(uuid)

			return r !== undefined && r.path !== scratch.get(uuid)
		})
		.sort((a, b) => {
			const depthDiff = depth(scratch.get(a) ?? "") - depth(scratch.get(b) ?? "")

			if (depthDiff !== 0) {
				return depthDiff
			}

			// Dirs before files at equal depth so their rewrites apply first.
			const aDir = remote.get(a)?.isDirectory === true ? 0 : 1
			const bDir = remote.get(b)?.isDirectory === true ? 0 : 1

			return aDir - bDir
		})

	for (const uuid of candidates) {
		const current = scratch.get(uuid)
		const want = remote.get(uuid)?.path

		if (current === undefined || want === undefined || current === want) {
			continue
		}

		explicit.push(uuid)
		rewritePrefix(scratch, current, want)
	}

	// Phase 1 — extract explicit movers to root-level temps, deepest CURRENT path first so an
	// independently moving child leaves its moving ancestor before the ancestor is extracted.
	// Non-moving children ride along inside moved directories.
	const phase1 = [...explicit].sort((a, b) => depth(simulated.get(b) ?? "") - depth(simulated.get(a) ?? ""))

	for (const uuid of phase1) {
		const from = simulated.get(uuid)
		const remoteEntry = remote.get(uuid)

		if (from === undefined || !remoteEntry) {
			continue
		}

		const to = tmpPathForUuid(uuid)

		ops.push({
			type: "move",
			uuid,
			from,
			to,
			isDirectory: remoteEntry.isDirectory
		})
		rewritePrefix(simulated, from, to)
	}

	// Deletes — only-local entries at their simulated (possibly temp-prefixed) locations, deepest first.
	if (allowDeletes) {
		const deletes = [...simulated.entries()]
			.filter(([uuid]) => !remote.has(uuid))
			.sort((a, b) => depth(b[1]) - depth(a[1]))

		for (const [uuid, path] of deletes) {
			ops.push({
				type: "delete",
				uuid,
				path,
				isDirectory: localByUuid.get(uuid)?.isDirectory === true
			})
			simulated.delete(uuid)
		}
	}

	// Phase 2 — place movers at their remote paths, shallowest destination first so moving parent
	// dirs land before children move into them. Executor creates missing destination parents.
	const phase2 = [...explicit].sort((a, b) => depth(remote.get(a)?.path ?? "") - depth(remote.get(b)?.path ?? ""))

	for (const uuid of phase2) {
		const from = simulated.get(uuid)
		const remoteEntry = remote.get(uuid)

		if (from === undefined || !remoteEntry) {
			continue
		}

		ops.push({
			type: "move",
			uuid,
			from,
			to: remoteEntry.path,
			isDirectory: remoteEntry.isDirectory
		})
		rewritePrefix(simulated, from, remoteEntry.path)
	}

	return {
		ops,
		missingUuids
	}
}

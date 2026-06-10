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
	// Ordered: phase-1 extractions (deepest current path first), rider rescues (ancestors first),
	// deletes (deepest first), phase-2 placements (shallowest destination first).
	ops: TreeOp[]
	missingUuids: string[]
	// Explicit movers NOT planned this pass (degraded listings only — allowDeletes: false): their
	// remote destination is occupied by an entry that stays put and that only the (skipped) delete
	// phase would clear, so the executor's never-overwrite move would throw every pass. Deferred
	// entries keep their current paths; reconcileTree commits them with their CURRENT meta path
	// and the move proceeds on the next clean pass (deletes run, the occupant goes).
	deferredMoves: string[]
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

// Replays the full two-phase move plan for a candidate mover set on a COPY of the simulated map
// and returns every uuid's FINAL path (non-movers ride along via the prefix rewrites). Used by
// the degraded-pass deferral check to know where kept entries will actually sit when phase 2
// runs — a mover's destination colliding with any such stay would make the executor throw.
function simulateMoves(simulated: Map<string, string>, movers: string[], remote: Map<string, RemoteTreeEntry>): Map<string, string> {
	const projected = new Map(simulated)
	const phase1 = [...movers].sort((a, b) => depth(projected.get(b) ?? "") - depth(projected.get(a) ?? ""))

	for (const uuid of phase1) {
		const from = projected.get(uuid)

		if (from === undefined) {
			continue
		}

		rewritePrefix(projected, from, tmpPathForUuid(uuid))
	}

	const phase2 = [...movers].sort((a, b) => depth(remote.get(a)?.path ?? "") - depth(remote.get(b)?.path ?? ""))

	for (const uuid of phase2) {
		const from = projected.get(uuid)
		const to = remote.get(uuid)?.path

		if (from === undefined || to === undefined) {
			continue
		}

		rewritePrefix(projected, from, to)
	}

	return projected
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

	// Degraded-pass deferral (allowDeletes: false): a mover whose REMOTE destination is occupied
	// by an entry that stays this pass would make the executor's never-overwrite move throw —
	// only the delete phase clears such occupants, and degraded passes skip it. Defer those
	// movers (no extraction, no placement — the entry simply stays at its current path) instead
	// of livelocking the tree on a store error every pass. A deferred mover is itself a stay, so
	// it can block further movers — iterate to a fixpoint (each round defers at least one mover,
	// so it terminates). Deferred dir-movers implicitly defer their whole subtree: descendants
	// were "explained" by the ancestor in the reduction above and have no ops of their own.
	const deferredMoves: string[] = []
	let movers = explicit

	if (!allowDeletes && explicit.length > 0) {
		movers = [...explicit]

		while (movers.length > 0) {
			const finalPaths = simulateMoves(simulated, movers, remote)
			const moverSet = new Set(movers)
			const occupiedStays = new Set<string>()

			for (const [uuid, path] of finalPaths) {
				if (!moverSet.has(uuid)) {
					occupiedStays.add(path)
				}
			}

			const kept: string[] = []
			let deferredThisRound = false

			for (const uuid of movers) {
				const destination = remote.get(uuid)?.path

				if (destination !== undefined && occupiedStays.has(destination)) {
					deferredMoves.push(uuid)
					deferredThisRound = true
				} else {
					kept.push(uuid)
				}
			}

			movers = kept

			if (!deferredThisRound) {
				break
			}
		}
	}

	// Phase 1 — extract explicit movers to root-level temps, deepest CURRENT path first so an
	// independently moving child leaves its moving ancestor before the ancestor is extracted.
	// Non-moving children ride along inside moved directories.
	const phase1 = [...movers].sort((a, b) => depth(simulated.get(b) ?? "") - depth(simulated.get(a) ?? ""))

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

	// Rider rescue — remote-KEPT entries still sitting inside an only-local directory at this
	// point would be destroyed by that directory's recursive delete below (e.g. dir D deleted
	// remotely + same-name D' created: the child keeps its uuid and relative path, so it is not a
	// mover, yet its bytes live inside doomed D). Extract such riders to root temps BEFORE the
	// delete phase; phase 2 places them back at their remote paths (the executor recreates
	// destination parents). Ancestors first: a rescued directory carries its subtree along, and
	// the live doomed-path lookups keep matching entries that are still doomed afterwards.
	const allMovers = [...movers]

	if (allowDeletes) {
		const doomedDirUuids: string[] = []

		for (const [uuid] of simulated) {
			if (!remote.has(uuid) && localByUuid.get(uuid)?.isDirectory === true) {
				doomedDirUuids.push(uuid)
			}
		}

		if (doomedDirUuids.length > 0) {
			const moverSet = new Set(allMovers)
			const riderCandidates = [...simulated.keys()]
				.filter(uuid => remote.has(uuid) && !moverSet.has(uuid))
				.sort((a, b) => depth(simulated.get(a) ?? "") - depth(simulated.get(b) ?? ""))

			for (const uuid of riderCandidates) {
				const from = simulated.get(uuid)
				const remoteEntry = remote.get(uuid)

				if (from === undefined || !remoteEntry) {
					continue
				}

				const doomed = doomedDirUuids.some(doomedUuid => {
					const doomedPath = simulated.get(doomedUuid)

					return doomedPath !== undefined && from.startsWith(`${doomedPath}/`)
				})

				if (!doomed) {
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
				allMovers.push(uuid)
			}
		}
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

	// Phase 2 — place movers (incl. rescued riders) at their remote paths, shallowest destination
	// first so moving parent dirs land before children move into them. Executor creates missing
	// destination parents.
	const phase2 = [...allMovers].sort((a, b) => depth(remote.get(a)?.path ?? "") - depth(remote.get(b)?.path ?? ""))

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
		missingUuids,
		deferredMoves
	}
}

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
	// uuid → FINAL planned on-disk path after every op in `ops` has run, for each entry that was
	// physically present at plan time and not deleted. Lets reconcileTree resolve an entry's
	// post-pass disk location in O(1) instead of replaying the move ops per path.
	finalPaths: Map<string, string>
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

// Segment depth without the per-call array allocation of path.split("/").length —
// equal to slash count + 1 for the leading-"/" paths this module works on.
function depth(path: string): number {
	let segments = 1

	for (let i = 0; i < path.length; i++) {
		if (path.charCodeAt(i) === 47) {
			segments++
		}
	}

	return segments
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

// Apply one mover's rewrite. A FILE mover has no subtree in a coherent tree, so only its own
// entry moves — O(1) instead of rewritePrefix's full-map scan. Directory movers (whose subtree
// genuinely rides along) keep the full scan. This is what turns "10k renamed files" from
// O(movers × entries) into O(movers).
function rewriteMover(paths: Map<string, string>, uuid: string, from: string, to: string, isDirectory: boolean): void {
	if (!isDirectory) {
		if (paths.get(uuid) === from) {
			paths.set(uuid, to)
		}

		return
	}

	rewritePrefix(paths, from, to)
}

// Replays the full two-phase move plan for a candidate mover set on a COPY of the simulated map
// and returns every uuid's FINAL path (non-movers ride along via the prefix rewrites). Used by
// the degraded-pass deferral check to know where kept entries will actually sit when phase 2
// runs — a mover's destination colliding with any such stay would make the executor throw.
function simulateMoves(simulated: Map<string, string>, movers: string[], remote: Map<string, RemoteTreeEntry>): Map<string, string> {
	const projected = new Map(simulated)
	const phase1Depths = new Map<string, number>()

	for (const uuid of movers) {
		phase1Depths.set(uuid, depth(projected.get(uuid) ?? ""))
	}

	const phase1 = [...movers].sort((a, b) => (phase1Depths.get(b) as number) - (phase1Depths.get(a) as number))

	for (const uuid of phase1) {
		const from = projected.get(uuid)

		if (from === undefined) {
			continue
		}

		rewriteMover(projected, uuid, from, tmpPathForUuid(uuid), remote.get(uuid)?.isDirectory === true)
	}

	const phase2Depths = new Map<string, number>()

	for (const uuid of movers) {
		phase2Depths.set(uuid, depth(remote.get(uuid)?.path ?? ""))
	}

	const phase2 = [...movers].sort((a, b) => (phase2Depths.get(a) as number) - (phase2Depths.get(b) as number))

	for (const uuid of phase2) {
		const from = projected.get(uuid)
		const to = remote.get(uuid)?.path

		if (from === undefined || to === undefined) {
			continue
		}

		rewriteMover(projected, uuid, from, to, remote.get(uuid)?.isDirectory === true)
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
	// Simulated on-disk location per uuid; only physically present entries participate in moves/deletes.
	const simulated = new Map<string, string>()

	for (const entry of local) {
		if (entry.existsOnDisk) {
			simulated.set(entry.uuid, entry.path)
		}
	}

	// uuid → LocalTreeEntry, built LAZILY: only the rider/delete phases consult it, and only for
	// local-only (remote-gone) entries — a fixed-point pass (the common case) never pays the
	// whole-map build.
	let localByUuidLazy: Map<string, LocalTreeEntry> | null = null

	const localByUuid = (): Map<string, LocalTreeEntry> => {
		if (localByUuidLazy === null) {
			localByUuidLazy = new Map<string, LocalTreeEntry>()

			for (const entry of local) {
				localByUuidLazy.set(entry.uuid, entry)
			}
		}

		return localByUuidLazy
	}

	for (const uuid of remote.keys()) {
		if (!simulated.has(uuid)) {
			missingUuids.push(uuid)
		}
	}

	// Reduction pass: find EXPLICIT movers — entries whose path change is not already explained by a
	// moving ancestor directory. Processing shallowest-local-first and rewriting a scratch map after
	// each prospective dir move collapses "10k children of a renamed dir" into one explicit mover.
	const explicit: string[] = []
	const candidates: string[] = []
	// Depth + kind per candidate, computed once — the sort below would otherwise recompute
	// depth O(n log n) times.
	const candidateDepths = new Map<string, number>()
	const candidateIsDir = new Map<string, boolean>()

	for (const [uuid, p] of simulated) {
		const r = remote.get(uuid)

		if (r !== undefined && r.path !== p) {
			candidates.push(uuid)
			candidateDepths.set(uuid, depth(p))
			candidateIsDir.set(uuid, r.isDirectory)
		}
	}

	if (candidates.length > 0) {
		candidates.sort((a, b) => {
			const depthDiff = (candidateDepths.get(a) as number) - (candidateDepths.get(b) as number)

			if (depthDiff !== 0) {
				return depthDiff
			}

			// Dirs before files at equal depth so their rewrites apply first.
			return (candidateIsDir.get(a) === true ? 0 : 1) - (candidateIsDir.get(b) === true ? 0 : 1)
		})

		// The scratch copy of the whole map is only needed once there is anything to reduce —
		// fixed-point passes (zero candidates) skip it entirely.
		const scratch = new Map(simulated)

		for (const uuid of candidates) {
			const current = scratch.get(uuid)
			const want = remote.get(uuid)?.path

			if (current === undefined || want === undefined || current === want) {
				continue
			}

			explicit.push(uuid)
			rewriteMover(scratch, uuid, current, want, candidateIsDir.get(uuid) === true)
		}
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

		let hasDirMover = false

		for (const uuid of movers) {
			if (candidateIsDir.get(uuid) === true) {
				hasDirMover = true

				break
			}
		}

		if (!hasDirMover) {
			// File-only movers: nobody rides along, so every non-mover's projected final path IS
			// its current simulated path. Maintain the occupied-stay set incrementally across
			// fixpoint rounds instead of re-simulating the whole map each round.
			const occupiedStays = new Set<string>(simulated.values())

			for (const uuid of movers) {
				const moverPath = simulated.get(uuid)

				if (moverPath !== undefined) {
					occupiedStays.delete(moverPath)
				}
			}

			while (movers.length > 0) {
				const kept: string[] = []
				const deferredThisRoundPaths: string[] = []

				for (const uuid of movers) {
					const destination = remote.get(uuid)?.path

					if (destination !== undefined && occupiedStays.has(destination)) {
						deferredMoves.push(uuid)

						const stayPath = simulated.get(uuid)

						if (stayPath !== undefined) {
							deferredThisRoundPaths.push(stayPath)
						}
					} else {
						kept.push(uuid)
					}
				}

				movers = kept

				if (deferredThisRoundPaths.length === 0) {
					break
				}

				// Deferred movers become stays at their current paths — visible to checks from
				// the NEXT round on, exactly like the re-simulated variant below.
				for (const stayPath of deferredThisRoundPaths) {
					occupiedStays.add(stayPath)
				}
			}
		} else {
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
	}

	// Phase 1 — extract explicit movers to root-level temps, deepest CURRENT path first so an
	// independently moving child leaves its moving ancestor before the ancestor is extracted.
	// Non-moving children ride along inside moved directories.
	const phase1Depths = new Map<string, number>()

	for (const uuid of movers) {
		phase1Depths.set(uuid, depth(simulated.get(uuid) ?? ""))
	}

	const phase1 = [...movers].sort((a, b) => (phase1Depths.get(b) as number) - (phase1Depths.get(a) as number))

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
		rewriteMover(simulated, uuid, from, to, remoteEntry.isDirectory)
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
			if (!remote.has(uuid) && localByUuid().get(uuid)?.isDirectory === true) {
				doomedDirUuids.push(uuid)
			}
		}

		if (doomedDirUuids.length > 0) {
			const moverSet = new Set(allMovers)
			const riderCandidates: string[] = []
			const riderDepths = new Map<string, number>()

			for (const [uuid, p] of simulated) {
				if (remote.has(uuid) && !moverSet.has(uuid)) {
					riderCandidates.push(uuid)
					riderDepths.set(uuid, depth(p))
				}
			}

			riderCandidates.sort((a, b) => (riderDepths.get(a) as number) - (riderDepths.get(b) as number))

			// "Is some doomed dir's CURRENT path a proper slash-aligned prefix of `from`?" —
			// answered by walking `from`'s ancestor paths against a set instead of scanning every
			// doomed dir per candidate. Doomed paths only change when a DIRECTORY rider is rescued
			// (its subtree rewrite can carry doomed dirs riding inside it), so the set is rebuilt
			// only on that rare event; file-rider rescues cannot move directories.
			let doomedPathSet = new Set<string>()

			const rebuildDoomedPathSet = (): void => {
				doomedPathSet = new Set<string>()

				for (const doomedUuid of doomedDirUuids) {
					const doomedPath = simulated.get(doomedUuid)

					if (doomedPath !== undefined) {
						doomedPathSet.add(doomedPath)
					}
				}
			}

			rebuildDoomedPathSet()

			const isUnderDoomedDir = (from: string): boolean => {
				let end = from.lastIndexOf("/")

				while (end > 0) {
					if (doomedPathSet.has(from.slice(0, end))) {
						return true
					}

					end = from.lastIndexOf("/", end - 1)
				}

				return false
			}

			for (const uuid of riderCandidates) {
				const from = simulated.get(uuid)
				const remoteEntry = remote.get(uuid)

				if (from === undefined || !remoteEntry) {
					continue
				}

				if (!isUnderDoomedDir(from)) {
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
				rewriteMover(simulated, uuid, from, to, remoteEntry.isDirectory)
				allMovers.push(uuid)

				if (remoteEntry.isDirectory) {
					rebuildDoomedPathSet()
				}
			}
		}
	}

	// Deletes — only-local entries at their simulated (possibly temp-prefixed) locations, deepest first.
	if (allowDeletes) {
		const deletes: { uuid: string; path: string; pathDepth: number }[] = []

		for (const [uuid, path] of simulated) {
			if (!remote.has(uuid)) {
				deletes.push({
					uuid,
					path,
					pathDepth: depth(path)
				})
			}
		}

		deletes.sort((a, b) => b.pathDepth - a.pathDepth)

		for (const { uuid, path } of deletes) {
			ops.push({
				type: "delete",
				uuid,
				path,
				isDirectory: localByUuid().get(uuid)?.isDirectory === true
			})
			simulated.delete(uuid)
		}
	}

	// Phase 2 — place movers (incl. rescued riders) at their remote paths, shallowest destination
	// first so moving parent dirs land before children move into them. Executor creates missing
	// destination parents.
	const phase2Depths = new Map<string, number>()

	for (const uuid of allMovers) {
		phase2Depths.set(uuid, depth(remote.get(uuid)?.path ?? ""))
	}

	const phase2 = [...allMovers].sort((a, b) => (phase2Depths.get(a) as number) - (phase2Depths.get(b) as number))

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
		rewriteMover(simulated, uuid, from, remoteEntry.path, remoteEntry.isDirectory)
	}

	// After phase 2, `simulated` holds every surviving entry's FINAL planned path.
	return {
		ops,
		missingUuids,
		deferredMoves,
		finalPaths: simulated
	}
}

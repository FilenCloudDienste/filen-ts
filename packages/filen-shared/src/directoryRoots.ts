// Directories a feature reads recursively as its roots (the Videos libraries, the Photos timeline): own-drive
// directories outside `.filen` that never overlap, so no directory is listed twice.

// A directory as the root chooser sees it: its uuid, and the uuids from the drive root (inclusive) down to its
// parent; empty for the drive root itself. `ownDrive` is false for shared-in and public-link directories, which have
// no stable file ids.
export interface RootCandidate {
	uuid: string
	ancestors: readonly string[]
	ownDrive: boolean
}

export type RootValidation =
	| { ok: true }
	| { ok: false; reason: "notOwnDrive" | "systemDirectory" | "alreadyRoot" }
	// Overlaps existing roots (inside one, or holding some): offered as a replacement for them (Videos). `within`
	// names the roots holding the candidate, present only when some do (a feature may refuse that case instead).
	| { ok: false; reason: "nested"; replace: string[]; within?: string[] }

export function validateRootCandidate({
	candidate,
	roots,
	dotFilenUuid
}: {
	candidate: RootCandidate
	// The current roots, each with its own ancestor chain.
	roots: readonly { uuid: string; ancestors: readonly string[] }[]
	// The `.filen` directory's uuid when known.
	dotFilenUuid: string | null
}): RootValidation {
	if (!candidate.ownDrive) {
		return {
			ok: false,
			reason: "notOwnDrive"
		}
	}

	if (dotFilenUuid !== null && (candidate.uuid === dotFilenUuid || candidate.ancestors.includes(dotFilenUuid))) {
		return {
			ok: false,
			reason: "systemDirectory"
		}
	}

	const replace: string[] = []
	const within: string[] = []

	for (const root of roots) {
		if (root.uuid === candidate.uuid) {
			return {
				ok: false,
				reason: "alreadyRoot"
			}
		}

		const holdsCandidate = candidate.ancestors.includes(root.uuid)

		if (holdsCandidate || root.ancestors.includes(candidate.uuid)) {
			replace.push(root.uuid)
		}

		if (holdsCandidate) {
			within.push(root.uuid)
		}
	}

	if (replace.length === 0) {
		return {
			ok: true
		}
	}

	return within.length > 0
		? {
				ok: false,
				reason: "nested",
				replace,
				within
			}
		: {
				ok: false,
				reason: "nested",
				replace
			}
}

// The roots no other root holds, in their given order; a duplicate counts once. Overlap still arises after
// validation (two devices adding nested directories at once, a root moved into another), and a nested root's
// directories are already read through the root holding it. A root whose ancestors are unknown (null) is kept.
export function outermostRoots(roots: readonly { uuid: string; ancestors: readonly string[] | null }[]): string[] {
	const uuids = new Set(roots.map(root => root.uuid))
	const out: string[] = []
	const seen = new Set<string>()

	for (const root of roots) {
		if (seen.has(root.uuid) || (root.ancestors?.some(ancestor => uuids.has(ancestor)) ?? false)) {
			continue
		}

		seen.add(root.uuid)
		out.push(root.uuid)
	}

	return out
}

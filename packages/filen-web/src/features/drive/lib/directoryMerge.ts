import { driveKeepBothName, nameCollisionKey } from "@filen/shared"
import { log } from "@/lib/log"
import { sdkApi } from "@/lib/sdk/client"
import { narrowItem } from "@/features/drive/lib/item"
import { cachedListing, isDriveListingCurrent } from "@/features/drive/queries/drive"
import { heldNamesOf, withClaims, type HeldNames, type NestedPolicy } from "@/features/drive/lib/nameConflicts"

// The lazy recursive check of a directory upload merged into an existing directory. Only a local directory whose name
// its remote parent already holds needs a listing of its own (one per merged directory, its files waiting only for
// it); everything below a directory the run created fresh is new and checked against nothing. Every decision is made
// once the run starts: no prompt mid-run, the merge's one policy (NestedPolicy) answers each clash below it.

// A remote directory the run writes into: `held` the names it held when the run listed it, null for one the run
// created (nothing to clash with); `allocated` the names the run gave in it so far (local case or NFC variants of
// one name, which the drive keeps as one).
export interface RunDirectory {
	// null: the drive's root.
	readonly uuid: string | null
	readonly held: HeldNames | null
	readonly allocated: Set<string>
}

export interface DirectoryMergeDeps {
	// One bare listing of a directory, never seeded into the query cache (a merged tree may hold thousands).
	listDirectory: (uuid: string) => Promise<HeldNames>
}

export const defaultDirectoryMergeDeps: DirectoryMergeDeps = {
	listDirectory: async uuid => {
		const cached = cachedListing("drive", uuid)

		// A listing current under the live socket answers without a request.
		if (cached !== undefined && isDriveListingCurrent(uuid)) {
			return heldNamesOf(cached)
		}

		const { dirs, files } = await sdkApi.listDirectory({ kind: "uuid", uuid })

		return heldNamesOf([...dirs.map(narrowItem), ...files.map(narrowItem)])
	}
}

// One run's remote directories by uuid (two local paths naming one remote directory share it, and its listing), and
// the listings it asked for.
export class RunDirectories {
	private readonly directories = new Map<string, Promise<RunDirectory>>()
	private readonly deps: DirectoryMergeDeps

	public constructor(deps: DirectoryMergeDeps) {
		this.deps = deps
	}

	// A directory the run created: nothing in it to clash with.
	public fresh(uuid: string | null): Promise<RunDirectory> {
		return this.directory(uuid, false)
	}

	// A directory that existed: listed once, with the names uploads of this tab claim in it. A listing that fails
	// leaves it unchecked, as a fresh one: an upload is never blocked by its check.
	public merged(uuid: string): Promise<RunDirectory> {
		return this.directory(uuid, true)
	}

	private directory(uuid: string | null, list: boolean): Promise<RunDirectory> {
		const known = this.directories.get(uuid ?? "")

		if (known !== undefined) {
			return known
		}

		const directory = (async (): Promise<RunDirectory> => {
			let held: HeldNames | null = null

			if (list && uuid !== null) {
				try {
					held = withClaims(await this.deps.listDirectory(uuid), uuid)
				} catch (e) {
					log.warn("upload", "directory merge: listing failed, its files are not checked", uuid, e)
				}
			}

			return { uuid, held, allocated: new Set() }
		})()

		this.directories.set(uuid ?? "", directory)

		return directory
	}
}

// The names a directory holds or the run gave in it.
function takenIn(parent: RunDirectory): { has: (key: string) => boolean } {
	return { has: key => parent.allocated.has(key) || parent.held?.has(key) === true }
}

export type NestedDirectoryDecision =
	// It exists: written into, listed. `uuid` undefined: an upload under way claims it, so it is created (the create
	// returns the existing one) and listed then.
	{ action: "merge"; uuid: string | undefined } | { action: "create"; name: string } | { action: "skip" }

// A local sub-directory `name` of `parent`: merged into the remote directory of its name; created fresh when the name
// is free; when a file holds it, created under a numbered name, or skipped with its whole subtree under Skip.
export function nestedDirectoryDecision(parent: RunDirectory, name: string, policy: NestedPolicy): NestedDirectoryDecision {
	const key = nameCollisionKey(name)
	const remote = parent.held?.get(key)

	if (remote === undefined) {
		parent.allocated.add(key)

		return { action: "create", name }
	}

	if (remote.kind === "directory") {
		return { action: "merge", uuid: remote.item?.data.uuid }
	}

	if (policy === "skip") {
		return { action: "skip" }
	}

	const renamed = driveKeepBothName({ name, isDirectory: true, taken: takenIn(parent) })

	parent.allocated.add(nameCollisionKey(renamed))

	return { action: "create", name: renamed }
}

export type NestedFileDecision = { action: "upload"; name: string } | { action: "skip" }

// A local file `name` (as it will be uploaded: a converted HEIC's ".jpg") of `parent`. A name free there uploads; one a
// remote file holds follows the policy (Replace makes a new version); one a remote directory holds is skipped under
// Skip and numbered otherwise; one another file of this run took (a case variant) is numbered, never versioned.
export function nestedFileDecision(parent: RunDirectory, name: string, policy: NestedPolicy): NestedFileDecision {
	const key = nameCollisionKey(name)
	const local = parent.allocated.has(key)
	const remote = local ? undefined : parent.held?.get(key)

	if (!local && (remote === undefined || (remote.kind === "file" && policy === "replace"))) {
		parent.allocated.add(key)

		return { action: "upload", name }
	}

	if (!local && policy === "skip") {
		return { action: "skip" }
	}

	const renamed = driveKeepBothName({ name, isDirectory: false, taken: takenIn(parent) })

	parent.allocated.add(nameCollisionKey(renamed))

	return { action: "upload", name: renamed }
}

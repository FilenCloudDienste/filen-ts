import path from "node:path"
import { keepBothName } from "@filen/shared/localName"
import { TransferCommitError } from "./transferErrors.ts"

// The fs calls a download's last steps make (node:fs/promises in the host).
export interface CommitFs {
	rename(from: string, to: string): Promise<void>
	link(existing: string, target: string): Promise<void>
	unlink(path: string): Promise<void>
	mkdir(path: string): Promise<unknown>
	open(path: string, flags: "wx"): Promise<{ close(): Promise<void> }>
	stat(path: string): Promise<{ size: number }>
}

// Past this many taken names something else is wrong; nothing loops forever.
const MAX_CANDIDATES = 10_000

function codeOf(error: unknown): unknown {
	return typeof error === "object" && error !== null && "code" in error ? error.code : undefined
}

// What a hard link refuses on a filesystem without them (FAT, exFAT, some network shares) or across volumes.
const LINK_UNSUPPORTED = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "EINVAL", "ENOSYS"])

// join(dirname(target), `${id}.filendl`): a uuid-stem .filendl FILE, which sync scans ignore and collect when stale.
export function stagingPathOf(target: string, id: string): string {
	return path.join(path.dirname(target), `${id}.filendl`)
}

function candidate(dir: string, name: string, n: number, kind: "file" | "directory"): string {
	if (n >= MAX_CANDIDATES) {
		throw new Error(`no free name for ${path.join(dir, name)}`)
	}

	return path.join(dir, keepBothName(name, n, kind))
}

// The file download's last step: the SDK wrote `staging`; put it at `target` and return where it landed.
// replace: rename over target (win32 EPERM/EBUSY: another app holds it open → localInUse).
// keepBoth: link(staging, free name) until not EEXIST, then unlink(staging), so a file that appeared at the name
// meanwhile is never replaced; where links are unsupported, an exclusive placeholder (open "wx") reserves the name and
// the staging file is renamed over it.
export async function commitDownload(
	fs: CommitFs,
	staging: string,
	target: string,
	conflict: "replace" | "keepBoth",
	platform: NodeJS.Platform = process.platform
): Promise<string> {
	if (conflict === "replace") {
		try {
			await fs.rename(staging, target)
		} catch (error) {
			const code = codeOf(error)

			if (platform === "win32" && (code === "EPERM" || code === "EBUSY")) {
				throw new TransferCommitError("localInUse", `${target} is in use`)
			}

			throw error
		}

		return target
	}

	const dir = path.dirname(target)
	const name = path.basename(target)
	let n = 0

	for (; ; n++) {
		const free = candidate(dir, name, n, "file")

		try {
			await fs.link(staging, free)
		} catch (error) {
			const code = codeOf(error)

			if (code === "EEXIST") {
				continue
			}

			if (typeof code === "string" && LINK_UNSUPPORTED.has(code)) {
				break
			}

			throw error
		}

		// The file is in place; a staging name left behind is swept as stale.
		await fs.unlink(staging).catch(() => undefined)

		return free
	}

	for (; ; n++) {
		const free = candidate(dir, name, n, "file")

		try {
			await (await fs.open(free, "wx")).close()
		} catch (error) {
			if (codeOf(error) === "EEXIST") {
				continue
			}

			throw error
		}

		try {
			await fs.rename(staging, free)
		} catch (error) {
			// Never an empty file under the final name.
			await fs.unlink(free).catch(() => undefined)

			throw error
		}

		return free
	}
}

// mkdir(target), not recursive; EEXIST → keepBothName(basename, n, "directory"). Returns the created path.
export async function makeFreeDirectory(fs: CommitFs, target: string): Promise<string> {
	const dir = path.dirname(target)
	const name = path.basename(target)

	for (let n = 0; ; n++) {
		const free = candidate(dir, name, n, "directory")

		try {
			await fs.mkdir(free)

			return free
		} catch (error) {
			if (codeOf(error) !== "EEXIST") {
				throw error
			}
		}
	}
}

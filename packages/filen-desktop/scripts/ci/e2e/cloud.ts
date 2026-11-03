import { createHash } from "node:crypto"
import { chmodSync, mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { pinnedRclone } from "../../stageRclone.ts"
import { fail, runBounded, type BoundedResult } from "../support.ts"
import { mask, runId, type HarnessRemote } from "./session.ts"

// The harness's view of the account's drive: the pinned rclone (the release the app ships) with the account as its
// `FILEN` remote, given through RCLONE_CONFIG_FILEN_* variables and an in-memory config, as sdk-rs's own rclone
// passthrough does; nothing secret reaches argv or disk. rclone's filen backend reports every item's uuid, so a
// listing is also an identity witness. Its deletions go to the Filen trash; emptyTrash() empties it (the whole account's
// trash, which is the dedicated e2e account's).
//
// Every path is relative to the drive's root, "/"-separated.

export const CLOUD_ROOT = "filen-desktop-e2e"

// This attempt's directory: a re-run attempt starts from a clean one.
export function runDir(): string {
	return `${CLOUD_ROOT}/${runId()}-${process.env["GITHUB_RUN_ATTEMPT"] ?? "1"}`
}

const REMOTE = "FILEN"
const CALL_TIMEOUT_MS = 5 * 60 * 1000
const QUICK_TIMEOUT_MS = 60_000

export interface CloudEntry {
	path: string
	isDir: boolean
	size: number
	modTime: string
	id: string
}

// The account's storage as `rclone about` reports it, in bytes; null for a figure the backend does not give.
export interface CloudUsage {
	total: number | null
	used: number | null
	free: number | null
	trashed: number | null
}

export function parseAbout(stdout: string): CloudUsage {
	const about = JSON.parse(stdout) as Partial<Record<keyof CloudUsage, unknown>>
	const figure = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null)

	return { total: figure(about.total), used: figure(about.used), free: figure(about.free), trashed: figure(about.trashed) }
}

export interface Cloud {
	mkdir(dir: string): Promise<void>
	// Copies a local tree into `dir` (created when missing), empty directories included. `big` raises the time bound and
	// the parallel transfers for a tree of thousands of files.
	upload(localDir: string, dir: string, big?: BigCopy): Promise<void>
	uploadFile(localFile: string, file: string): Promise<void>
	// Every entry below `dir` (only its children without `recursive`), paths relative to it; null when `dir` does not
	// exist.
	list(dir: string, recursive?: boolean): Promise<CloudEntry[] | null>
	// The uuid of directory `dir`.
	dirId(dir: string): Promise<string>
	// `exclude`: paths relative to `dir` left out, with everything below them.
	download(dir: string, localDir: string, exclude?: readonly string[]): Promise<void>
	// Moves `dir` and everything below it to the trash; a missing `dir` is not an error.
	purge(dir: string): Promise<void>
	// Deletes the files directly in `dir` whose names start with `prefix`, in one call (rclone delete).
	purgeFiles(dir: string, prefix: string): Promise<void>
	emptyTrash(): Promise<void>
	about(): Promise<CloudUsage>
	// A file's content as the cloud serves it (decrypted), whole in memory: for small files.
	cat(file: string): Promise<Buffer>
	// sha256 (hex) of a file's content, hashed as it streams.
	sha256Of(file: string): Promise<string>
	// Moves or renames one file or directory; the destination's parent is created when missing.
	moveto(from: string, to: string): Promise<void>
}

// A copy of many small files: its own time bound and rclone's --transfers (and --checkers).
export interface BigCopy {
	timeoutMs: number
	transfers: number
}

// rclone filter rules leaving out `prefixes` (relative to the copy's source) and everything below them; glob
// characters in a name are escaped.
export function excludeArgs(prefixes: readonly string[]): string[] {
	return prefixes.flatMap(prefix => {
		const rule = `/${prefix.replace(/[\\*?[\]{}]/g, "\\$&")}`

		return ["--exclude", rule, "--exclude", `${rule}/**`]
	})
}

// rclone filter rules keeping only the files directly in the source whose names start with `prefix`; glob characters
// in it are escaped.
export function prefixFilterArgs(prefix: string): string[] {
	return ["--max-depth", "1", "--include", `/${prefix.replace(/[\\*?[\]{}]/g, "\\$&")}*`]
}

function remotePath(relative: string): string {
	return `${REMOTE}:${relative.replace(/^\/+/, "")}`
}

function describe(result: BoundedResult): string {
	const status = result.timedOut ? "timed out (process group killed)" : `exit ${String(result.status)}`

	return `${status}: ${result.stderr.trim().split("\n").slice(-8).join(" | ")}`
}

// rclone's "directory not found" exit status.
const NOT_FOUND = 3

export async function openCloud(remote: HarnessRemote, work: string): Promise<Cloud> {
	const binary = path.join(work, "rclone", process.platform === "win32" ? "rclone.exe" : "rclone")

	mkdirSync(path.dirname(binary), { recursive: true })
	writeFileSync(binary, await pinnedRclone(process.arch === "arm64" ? "arm64" : "x64"))
	chmodSync(binary, 0o755)

	// A config file holds password options obscured; rclone's own obscure reads the value from stdin.
	const obscure = async (value: string): Promise<string> => {
		const result = await runBounded(binary, ["obscure", "-"], QUICK_TIMEOUT_MS, { input: value })
		const obscured = result.stdout.trim()

		if (result.status !== 0 || obscured === "") {
			fail(`infra: rclone obscure: ${describe(result)}`)
		}

		mask([obscured])

		return obscured
	}

	// The backend signs in with the keys, never with a password, but requires the option; this is the value it
	// documents for that.
	const options: Record<string, string> = {
		TYPE: "filen",
		EMAIL: remote.email,
		PASSWORD: await obscure("INTERNAL"),
		API_KEY: await obscure(remote.apiKey),
		MASTER_KEYS: remote.masterKeys.join("|"),
		PUBLIC_KEY: remote.publicKey,
		PRIVATE_KEY: remote.privateKey,
		AUTH_VERSION: String(remote.authVersion),
		BASE_FOLDER_UUID: remote.rootUuid
	}
	const env: NodeJS.ProcessEnv = {
		...process.env,
		...Object.fromEntries(Object.entries(options).map(([key, value]) => [`RCLONE_CONFIG_${REMOTE}_${key}`, value]))
	}
	const rclone = (args: string[], timeoutMs = CALL_TIMEOUT_MS, onStdout?: (chunk: Buffer) => void) =>
		runBounded(binary, ["--config", "", ...args], timeoutMs, onStdout === undefined ? { env } : { env, onStdout })
	const must = async (what: string, args: string[], timeoutMs = CALL_TIMEOUT_MS): Promise<void> => {
		const result = await rclone(args, timeoutMs)

		if (result.status !== 0) {
			fail(`rclone ${what}: ${describe(result)}`)
		}
	}

	// The file's bytes to `onChunk`; a failure fails by name.
	const stream = async (file: string, onChunk: (chunk: Buffer) => void): Promise<void> => {
		const result = await rclone(["cat", remotePath(file)], CALL_TIMEOUT_MS, onChunk)

		if (result.status !== 0) {
			fail(`rclone cat ${file}: ${describe(result)}`)
		}
	}

	const list = async (dir: string, recursive = true): Promise<CloudEntry[] | null> => {
		const result = await rclone(["lsjson", ...(recursive ? ["--recursive"] : []), "--no-mimetype", remotePath(dir)])

		if (result.status === NOT_FOUND) {
			return null
		}

		if (result.status !== 0) {
			fail(`rclone lsjson ${dir}: ${describe(result)}`)
		}

		const entries = JSON.parse(result.stdout) as { Path: string; IsDir: boolean; Size: number; ModTime: string; ID?: string }[]

		return entries.map(entry => ({
			path: entry.Path,
			isDir: entry.IsDir,
			size: entry.IsDir ? 0 : entry.Size,
			modTime: entry.ModTime,
			id: entry.ID ?? fail(`rclone lists ${entry.Path} without an ID`)
		}))
	}

	return {
		mkdir: async dir => {
			await must(`mkdir ${dir}`, ["mkdir", remotePath(dir)])
		},
		upload: async (localDir, dir, big) => {
			const parallel = big === undefined ? [] : ["--transfers", String(big.transfers), "--checkers", String(big.transfers)]

			await must(`copy to ${dir}`, ["copy", "--create-empty-src-dirs", ...parallel, localDir, remotePath(dir)], big?.timeoutMs)
		},
		uploadFile: async (localFile, file) => {
			await must(`copyto ${file}`, ["copyto", localFile, remotePath(file)])
		},
		list,
		dirId: async dir => {
			const parent = path.posix.dirname(dir)
			const name = path.posix.basename(dir)
			const found = (await list(parent === "." ? "" : parent, false))?.find(entry => entry.isDir && entry.path === name)

			return found?.id ?? fail(`no directory ${dir} in the cloud`)
		},
		download: async (dir, localDir, exclude = []) => {
			await must(`copy from ${dir}`, ["copy", "--create-empty-src-dirs", ...excludeArgs(exclude), remotePath(dir), localDir])
		},
		purge: async dir => {
			const result = await rclone(["purge", remotePath(dir)])

			if (result.status !== 0 && result.status !== NOT_FOUND) {
				fail(`rclone purge ${dir}: ${describe(result)}`)
			}
		},
		purgeFiles: async (dir, prefix) => {
			await must(`delete ${prefix}* in ${dir}`, ["delete", ...prefixFilterArgs(prefix), remotePath(dir)])
		},
		emptyTrash: async () => {
			await must("cleanup", ["cleanup", remotePath("")])
		},
		about: async () => {
			const result = await rclone(["about", "--json", remotePath("")], QUICK_TIMEOUT_MS)

			if (result.status !== 0) {
				fail(`rclone about: ${describe(result)}`)
			}

			return parseAbout(result.stdout)
		},
		cat: async file => {
			const chunks: Buffer[] = []

			await stream(file, chunk => chunks.push(chunk))

			return Buffer.concat(chunks)
		},
		sha256Of: async file => {
			const hash = createHash("sha256")

			await stream(file, chunk => hash.update(chunk))

			return hash.digest("hex")
		},
		moveto: async (from, to) => {
			await must(`moveto ${from} ${to}`, ["moveto", remotePath(from), remotePath(to)])
		}
	}
}

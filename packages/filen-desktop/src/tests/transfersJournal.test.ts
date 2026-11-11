import path from "node:path"
import { describe, expect, it, vi } from "vitest"
import { createStagingJournal, type JournalFs } from "../main/transfers/journal.ts"
import { memoryFile } from "./fileFakes.ts"

const DIR = path.resolve("downloads")
const at = (...names: string[]) => path.join(DIR, ...names)
const ID = "0d3c6b1e-8f4a-4c2d-9b7e-5a1f3e2d4c6b"
const ID2 = "1e4d7c2f-9a5b-4d3e-8c8f-6b2a4f3e5d7c"
const FILE_UUID = "4f8e2c1a-3b5d-4e6f-8a9b-0c1d2e3f4a5b"

type Node = "file" | "dir" | "link"

// A tree of paths: files, directories and symlinks (never followed).
function treeFs(nodes: Record<string, Node>) {
	const tree = new Map(Object.entries(nodes))
	const enoent = (at: string) => Object.assign(new Error(`ENOENT: ${at}`), { code: "ENOENT" })
	const fs: JournalFs = {
		lstat: at => {
			const node = tree.get(at)

			return node === undefined
				? Promise.reject(enoent(at))
				: Promise.resolve({ isFile: () => node === "file", isDirectory: () => node === "dir" })
		},
		unlink: at => {
			if (tree.get(at) === "dir" || !tree.delete(at)) {
				return Promise.reject(enoent(at))
			}

			return Promise.resolve()
		},
		readdir: at => {
			if (tree.get(at) !== "dir") {
				return Promise.reject(enoent(at))
			}

			return Promise.resolve(
				[...tree]
					.filter(([child]) => path.dirname(child) === at)
					.map(([child, node]) => ({
						name: path.basename(child),
						isFile: () => node === "file",
						isDirectory: () => node === "dir"
					}))
			)
		}
	}

	return { fs: { ...fs, unlink: vi.fn(fs.unlink) }, tree }
}

function setup(nodes: Record<string, Node>, stored: unknown = null) {
	const file = memoryFile(stored === null ? null : Buffer.from(JSON.stringify(stored)))
	const { fs, tree } = treeFs(nodes)
	const queue: (() => void)[] = []
	const journal = createStagingJournal({
		file,
		fs,
		schedule: run => {
			queue.push(run)
		},
		log: { warn: vi.fn() }
	})
	const runRound = async () => {
		for (const run of queue.splice(0)) {
			run()
		}

		await vi.waitFor(() => {
			expect(queue).toEqual([])
		})
		await new Promise(resolve => setImmediate(resolve))
	}
	const written = () => (file.data === null ? null : (JSON.parse(file.data.toString()) as unknown))

	return { journal, file, fs, tree, queue, runRound, written }
}

describe("staging journal", () => {
	it("sweep removes listed uuid .filendl files and leaves a symlink or a user's notes.filendl", async () => {
		const { journal, tree, written } = setup(
			{
				[DIR]: "dir",
				[at(`${ID}.filendl`)]: "file",
				[at(`${FILE_UUID}.filendl`)]: "link",
				[at("notes.filendl")]: "file",
				[at("a.txt")]: "file"
			},
			[{ id: ID, dir: DIR, names: [`${ID}.filendl`, `${FILE_UUID}.filendl`], tree: false }]
		)

		await journal.sweep()
		await new Promise(resolve => setImmediate(resolve))

		expect([...tree.keys()]).toEqual([DIR, at(`${FILE_UUID}.filendl`), at("notes.filendl"), at("a.txt")])
		expect(written()).toBeNull()
	})

	it("sweep walks a tree root without following links", async () => {
		const root = at("Projects")
		const { journal, tree } = setup(
			{
				[root]: "dir",
				[path.join(root, `${FILE_UUID}.filendl`)]: "file",
				[path.join(root, "sub")]: "dir",
				[path.join(root, "sub", `${ID2}.filendl`)]: "file",
				[path.join(root, "sub", "keep.txt")]: "file",
				[path.join(root, "sub", "notes.filendl")]: "file",
				[path.join(root, "away")]: "link",
				[path.join(root, "away", `${ID2}.filendl`)]: "file"
			},
			[{ id: ID, dir: root, names: [], tree: true }]
		)

		await journal.sweep()

		expect([...tree.keys()]).toEqual([
			root,
			path.join(root, "sub"),
			path.join(root, "sub", "keep.txt"),
			path.join(root, "sub", "notes.filendl"),
			path.join(root, "away"),
			path.join(root, "away", `${ID2}.filendl`)
		])
	})

	it("an unreadable journal is dropped", async () => {
		const { journal, file, fs } = setup({ [DIR]: "dir" }, { not: "entries" })

		await journal.sweep()
		await new Promise(resolve => setImmediate(resolve))

		expect(fs.unlink).not.toHaveBeenCalled()
		expect(file.data).toBeNull()
	})

	it("writes at most once per round", async () => {
		const { journal, file, queue, runRound, written } = setup({ [DIR]: "dir" })

		journal.add([{ id: ID, dir: DIR, names: [`${ID}.filendl`], tree: false }])
		journal.add([{ id: ID2, dir: DIR, names: [`${ID2}.filendl`], tree: false }])
		journal.remove([ID])

		expect(queue).toHaveLength(1)
		await runRound()

		expect(file.writes).toBe(1)
		expect(written()).toEqual([{ id: ID2, dir: DIR, names: [`${ID2}.filendl`], tree: false }])
	})

	it("adding and removing within one round writes nothing", async () => {
		const { journal, file, runRound } = setup({ [DIR]: "dir" })

		journal.add([{ id: ID, dir: DIR, names: [`${ID}.filendl`], tree: false }])
		journal.remove([ID])
		await runRound()

		expect(file.writes).toBe(0)
	})

	it("discard removes the staging files of the given ids and forgets them", async () => {
		const { journal, tree, runRound, written } = setup({
			[DIR]: "dir",
			[at(`${ID}.filendl`)]: "file",
			[at(`${FILE_UUID}.filendl`)]: "file",
			[at(`${ID2}.filendl`)]: "file"
		})

		journal.add([
			{ id: ID, dir: DIR, names: [`${ID}.filendl`, `${FILE_UUID}.filendl`], tree: false },
			{ id: ID2, dir: DIR, names: [`${ID2}.filendl`], tree: false }
		])
		await runRound()
		await journal.discard([ID])
		await runRound()

		expect([...tree.keys()]).toEqual([DIR, at(`${ID2}.filendl`)])
		expect(written()).toEqual([{ id: ID2, dir: DIR, names: [`${ID2}.filendl`], tree: false }])
	})

	it("an entry added while the sweep runs is kept", async () => {
		const { journal, runRound, written } = setup({ [DIR]: "dir" }, [{ id: ID, dir: DIR, names: [`${ID}.filendl`], tree: false }])
		const sweeping = journal.sweep()

		journal.add([{ id: ID2, dir: DIR, names: [`${ID2}.filendl`], tree: false }])
		await sweeping
		await runRound()

		expect(written()).toEqual([{ id: ID2, dir: DIR, names: [`${ID2}.filendl`], tree: false }])
	})
})

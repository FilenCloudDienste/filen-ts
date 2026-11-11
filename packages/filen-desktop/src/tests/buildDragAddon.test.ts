import path from "node:path"
import { describe, expect, it } from "vitest"
import {
	buildDragAddon,
	type DragAddonHost,
	dragAddonArtifact,
	dragAddonOutput,
	dragAddonSources,
	needsRebuild,
	windowsTriple
} from "../../scripts/buildDragAddon.ts"
import type { NativeArch } from "../../scripts/nativeArch.ts"

const packageDir = path.join(import.meta.dirname, "..", "..")
const crateDir = path.join(packageDir, "native", "dragOut", "win")

function fakeHost(overrides: Partial<DragAddonHost> & { mtimes?: Map<string, number> } = {}) {
	const runs: string[][] = []
	const copies: [string, string][] = []
	const logs: string[] = []
	const mtimes = overrides.mtimes ?? new Map<string, number>()
	const env: DragAddonHost = {
		platform: "win32",
		arch: "x64",
		run: (_command, args) => {
			runs.push([...args])

			return 0
		},
		mtime: file => mtimes.get(file) ?? null,
		copy: (from, to) => {
			copies.push([from, to])
		},
		archOf: file => (file.includes("win-arm64") ? "arm64" : "x64") as NativeArch,
		log: message => {
			logs.push(message)
		},
		...overrides
	}

	return { env, runs, copies, logs, mtimes }
}

describe("buildDragAddon", () => {
	it("output paths per arch", () => {
		expect(dragAddonOutput("x64")).toBe(path.join(packageDir, "build", "native", "win-x64", "filen-drag.node"))
		expect(dragAddonOutput("arm64")).toBe(path.join(packageDir, "build", "native", "win-arm64", "filen-drag.node"))
		expect(dragAddonArtifact("arm64")).toBe(path.join(crateDir, "target", "aarch64-pc-windows-msvc", "release", "filen_drag.dll"))
	})

	it("triple map for x64 and arm64", () => {
		expect(windowsTriple("x64")).toBe("x86_64-pc-windows-msvc")
		expect(windowsTriple("arm64")).toBe("aarch64-pc-windows-msvc")
	})

	it("sources are the manifests, the toolchain pin, the build script and every module", () => {
		const sources = dragAddonSources()

		for (const file of [
			"Cargo.toml",
			"Cargo.lock",
			"rust-toolchain.toml",
			"build.rs",
			path.join("src", "lib.rs"),
			path.join("src", "stream.rs")
		]) {
			expect(sources).toContain(path.join(crateDir, file))
		}
	})

	it("dev skips when the output is newer than every source", () => {
		const sources = dragAddonSources()
		const output = dragAddonOutput("x64")
		const mtimes = new Map<string, number>([[output, 100], ...sources.map(source => [source, 10] as [string, number])])
		const { env, runs, copies } = fakeHost({ mtimes })

		expect(needsRebuild(output, sources, file => mtimes.get(file) ?? null)).toBe(false)
		buildDragAddon({ dev: true }, env)
		expect(runs).toEqual([])
		expect(copies).toEqual([])

		mtimes.set(path.join(crateDir, "src", "lib.rs"), 150)
		expect(needsRebuild(output, sources, file => mtimes.get(file) ?? null)).toBe(true)
		expect(needsRebuild(dragAddonOutput("arm64"), sources, file => mtimes.get(file) ?? null)).toBe(true)
	})

	it("a package run builds both arches, and only copies a cargo build newer than its sources", () => {
		const sources = dragAddonSources()
		const mtimes = new Map<string, number>([
			[dragAddonArtifact("x64"), 100],
			...sources.map(source => [source, 10] as [string, number])
		])
		const { env, runs, copies } = fakeHost({ mtimes })

		buildDragAddon({ dev: false }, env)

		expect(runs).toEqual([
			["build", "--release", "--locked", "--target", "aarch64-pc-windows-msvc", "--target-dir", path.join(crateDir, "target")]
		])
		expect(copies).toEqual([
			[dragAddonArtifact("x64"), dragAddonOutput("x64")],
			[dragAddonArtifact("arm64"), dragAddonOutput("arm64")]
		])
	})

	it("skips with a warning when cargo is missing", () => {
		const { env, copies, logs } = fakeHost({ run: () => null })

		buildDragAddon({ dev: true }, env)

		expect(copies).toEqual([])
		expect(logs).toEqual(["buildDragAddon: cargo not found; skipped (dragging out to Explorer is unavailable)"])
	})

	it("fails on a cargo error or a binary of another arch", () => {
		expect(() => {
			buildDragAddon({ dev: true }, fakeHost({ run: () => 101 }).env)
		}).toThrow("cargo build failed")
		expect(() => {
			buildDragAddon({ dev: true }, fakeHost({ archOf: () => "arm64" }).env)
		}).toThrow("not x64")
	})

	it("does nothing off Windows", () => {
		const { env, runs, logs } = fakeHost({ platform: "darwin" })

		buildDragAddon({ dev: false }, env)

		expect(runs).toEqual([])
		expect(logs).toEqual(["buildDragAddon: not Windows; skipped"])
	})
})

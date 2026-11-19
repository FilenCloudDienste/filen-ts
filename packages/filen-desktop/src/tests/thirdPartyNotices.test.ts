import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { lockedCrates, workspacePatches } from "@filen/shared/tooling"
import { CHANNELS } from "../shared/channels.ts"
import { fileThirdPartyNotices, registerThirdPartyNoticesIpc, THIRD_PARTY_NOTICES_FILE } from "../main/thirdPartyNotices.ts"
import { fakeIpc } from "./ipcFakes.ts"
import {
	bundledNpmPackages,
	DRAG_ADDON_LOCK,
	NODE_API_HEADERS,
	packageDir,
	readDesktopNotices,
	readWebNotices,
	type BundledPackage
} from "../../scripts/thirdPartyNoticesSources.ts"
import { readVersions } from "../../scripts/stageRclone.ts"

/**
 * The desktop notices discharge a legal obligation for what the shell ships beyond the web build, so the failure that
 * matters is a silent one: a dependency, addon, Electron, rclone or WinFsp change that skips
 * scripts/generateThirdPartyNotices.ts. The generator cannot run in CI (filen-rs checkout, cargo caches, Go, the
 * network), so every guard reads what CI has: the committed payload, filen-web's committed payload, the installed tree
 * and the pins.
 */
const file = readDesktopNotices()
const web = readWebNotices()
const { texts, notices } = file
const key = (notice: { ecosystem: string; name: string; version: string }) => `${notice.ecosystem}:${notice.name}@${notice.version}`
const listed = new Set([...web.notices.map(key), ...notices.map(key)])
const textsOf = (notice: { texts: number[] }) => notice.texts.map(index => texts[index] ?? "")
const find = (ecosystem: string, name: string) => notices.find(notice => notice.ecosystem === ecosystem && notice.name === name)
const installedVersion = (name: string) =>
	(JSON.parse(readFileSync(path.join(packageDir, "node_modules", name, "package.json"), "utf8")) as { version: string }).version

let bundled: BundledPackage[]

beforeAll(async () => {
	bundled = await bundledNpmPackages()
}, 60_000)

describe("desktop third-party notices drift guard", () => {
	it("was generated against the installed SDK, at its release tag", () => {
		const sdk = installedVersion("@filen/sdk-rs")

		expect(file.generated.sdkVersion).toBe(sdk)
		expect(file.generated.filenRsRef).toBe(`filen-js@${sdk}`)
	})

	it("extends filen-web's payload as it is committed now", () => {
		// filen-web regenerated (an SDK bump there) changes what desktop must add.
		expect(file.generated.web).toEqual({ sdkVersion: web.sdkVersion, filenRsRef: web.filenRsRef })
	})

	it("lists nothing filen-web already lists", () => {
		const webKeys = new Set(web.notices.map(key))

		expect(notices.filter(notice => webKeys.has(key(notice))).map(key)).toEqual([])
	})

	it("covers every npm package the bundles in dist/ include", () => {
		expect(bundled.length).toBeGreaterThan(0)
		expect(bundled.some(pkg => pkg.name === "electron-updater")).toBe(true)
		expect(bundled.filter(pkg => !listed.has(`npm:${pkg.name}@${pkg.version}`)).map(pkg => `${pkg.name}@${pkg.version}`)).toEqual([])
	})

	it("lists no npm package that ships no longer", () => {
		const shipped = new Set([
			...bundled.map(pkg => `${pkg.name}@${pkg.version}`),
			`${NODE_API_HEADERS}@${installedVersion(NODE_API_HEADERS)}`
		])

		expect(notices.filter(notice => notice.ecosystem === "npm" && !shipped.has(`${notice.name}@${notice.version}`)).map(key)).toEqual(
			[]
		)
	})

	it("lists the Node-API headers the Swift addons compile with", () => {
		expect(listed.has(`npm:${NODE_API_HEADERS}@${installedVersion(NODE_API_HEADERS)}`)).toBe(true)
	})

	it("names the patch pnpm applies to every bundled package it patches", () => {
		const patches = workspacePatches(path.join(packageDir, "..", "..", "pnpm-workspace.yaml"))

		for (const pkg of bundled) {
			const patch = patches.get(`${pkg.name}@${pkg.version}`) ?? patches.get(pkg.name)
			const notice = notices.find(entry => entry.ecosystem === "npm" && entry.name === pkg.name && entry.version === pkg.version)

			if (patch !== undefined && notice !== undefined) {
				expect(
					textsOf(notice).some(text => text.includes(`the patch ${patch}`)),
					`${pkg.name}@${pkg.version}`
				).toBe(true)
			}
		}
	})

	it("covers every crate of the Explorer drag-out addon", () => {
		const crates = lockedCrates(readFileSync(DRAG_ADDON_LOCK, "utf8"))

		expect(crates.length).toBeGreaterThan(0)
		expect(
			crates.filter(crate => !listed.has(`rust:${crate.name}@${crate.version}`)).map(crate => `${crate.name}@${crate.version}`)
		).toEqual([])
	})

	it("was generated against the filen-rs commit the File Provider extension builds from", () => {
		expect(file.generated.fileProviderFilenRs).toBe(
			execFileSync("git", ["-C", packageDir, "rev-parse", "HEAD:./filen-rs"], { encoding: "utf8" }).trim()
		)
	})

	it("describes the installed Electron, and the Chromium and Node.js it includes", () => {
		const electron = installedVersion("electron")

		expect(file.generated.electron).toBe(electron)
		expect(find("vendored", "Electron")?.version).toBe(electron)
		expect(find("vendored", "Chromium")?.version).toBe(file.generated.chromium)
		expect(find("vendored", "Node.js")?.version).toBe(file.generated.node)

		// Their components' licenses are in the credits file electron-builder keeps in every package (checkPackage.ts).
		for (const name of ["Electron", "Chromium", "Node.js"]) {
			const notice = find("vendored", name)

			expect(notice === undefined ? [] : textsOf(notice).filter(text => text.includes("LICENSES.chromium.html")), name).toHaveLength(
				1
			)
		}
	})

	it("describes the pinned rclone, with every release binary it bundles, and the Go modules linked into it", () => {
		const versions = readVersions()
		const rclone = find("vendored", "rclone")
		const terms = rclone === undefined ? "" : textsOf(rclone).join("\n")

		expect(file.generated.rclone).toBe(versions.rclone)
		expect(rclone?.version).toBe(versions.rclone)
		expect(rclone?.license).toBe("MIT")

		for (const sha256 of Object.values(versions.rcloneSha256)) {
			expect(terms).toContain(`SHA-256 ${sha256}`)
		}

		expect(notices.filter(notice => notice.ecosystem === "go").length).toBeGreaterThan(100)
		expect(find("vendored", "Go standard library")?.version).toBe(file.generated.go)
	})

	it("describes the pinned WinFsp installer with the notice and link its FLOSS exception asks for", () => {
		const versions = readVersions()
		const winfsp = find("vendored", "WinFsp")

		expect(file.generated.winfsp).toBe(versions.winfsp)
		expect(winfsp).toMatchObject({
			version: versions.winfsp,
			copyright: ["WinFsp - Windows File System Proxy, Copyright (C) Bill Zissimopoulos"],
			repository: "https://github.com/winfsp/winfsp"
		})
		expect(winfsp === undefined ? "" : textsOf(winfsp).join("\n")).toContain(`SHA-256 ${versions.winfspSha256}`)
	})
})

describe("desktop third-party notices honesty and integrity", () => {
	it("resolves every text index", () => {
		expect(notices.filter(notice => notice.texts.some(index => index < 0 || index >= texts.length)).map(key)).toEqual([])
	})

	it("names and versions every entry, and keys each uniquely beside filen-web's, as the dialog's list requires", () => {
		expect(notices.filter(notice => notice.name.length === 0 || notice.version.length === 0).map(key)).toEqual([])
		expect(new Set(notices.map(key)).size).toBe(notices.length)
		expect(listed.size).toBe(web.notices.length + notices.length)
	})

	it("gives every vendored component its license text and holder", () => {
		expect(
			notices
				.filter(notice => notice.ecosystem === "vendored" && (notice.texts.length === 0 || notice.copyright.length === 0))
				.map(key)
		).toEqual([])
	})

	it("does not borrow a copyright for a package that shipped no license file", () => {
		expect(notices.filter(notice => notice.texts.length === 0 && notice.copyright.length > 0).map(key)).toEqual([])
	})

	it("never lends the Apache-2.0 text to a package that did not elect it", () => {
		const apache = texts
			.map((text, index) => ({ text, index }))
			.filter(
				({ text }) =>
					text.trimStart().startsWith("Apache License") && text.includes("APPENDIX: How to apply the Apache License to your work")
			)

		expect(apache.length).toBeGreaterThan(0)

		for (const { index } of apache) {
			expect(notices.filter(notice => notice.texts.includes(index) && !/apache/i.test(notice.license)).map(key)).toEqual([])
		}
	})

	it("never says open source", () => {
		expect(texts.filter(text => /open[- ]source/i.test(text) && !/Open Source Definition|opensource\.org/i.test(text)).length).toBe(0)
	})
})

describe("third-party notices IPC", () => {
	const dirs: string[] = []

	afterAll(() => {
		for (const dir of dirs) {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	function register(read: () => Promise<string>) {
		const { ipc, handlers } = fakeIpc()

		registerThirdPartyNoticesIpc(ipc, { read }, url => url?.startsWith("filen://app/") === true)

		const invoke = (url: string | null, ...args: unknown[]) =>
			Promise.resolve().then(() =>
				handlers.get(CHANNELS.thirdPartyNotices)?.(
					{ senderFrame: url === null ? null : { url }, sender: { id: 1, send: vi.fn(), isDestroyed: () => false } },
					...args
				)
			)

		return { invoke, handlers }
	}

	it("registers its one channel and answers the app's page with the file's text", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "notices-"))

		dirs.push(dir)
		writeFileSync(path.join(dir, THIRD_PARTY_NOTICES_FILE), '{"texts":[],"notices":[]}')

		const { invoke, handlers } = register(fileThirdPartyNotices(dir).read)

		expect([...handlers.keys()]).toEqual([CHANNELS.thirdPartyNotices])
		await expect(invoke("filen://app/settings")).resolves.toBe('{"texts":[],"notices":[]}')
	})

	it("refuses another sender and any argument", async () => {
		const read = vi.fn(() => Promise.resolve("{}"))
		const { invoke } = register(read)

		await expect(invoke("https://example.com/")).rejects.toThrow("untrusted sender")
		await expect(invoke(null)).rejects.toThrow("untrusted sender")
		await expect(invoke("filen://app/", "extra")).rejects.toThrow("invalid third-party notices payload")
		expect(read).not.toHaveBeenCalled()
	})
})

import { describe, expect, it, vi } from "vitest"
import { fuseStatus, installWinFsp, linuxFuseGap, msiOutcome, winFspInstallDir, type FuseContext } from "../main/mounts/fuse.ts"

const REG_QUERY =
	"\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\WinFsp\r\n    InstallDir    REG_SZ    C:\\Program Files (x86)\\WinFsp\\\r\n\r\n"

function context(overrides: Partial<FuseContext> = {}): FuseContext {
	return {
		platform: "darwin",
		arch: "arm64",
		env: {},
		exists: () => false,
		run: () => Promise.resolve({ code: 1, stdout: "" }),
		fuseInstaller: null,
		...overrides
	}
}

describe("fuse", () => {
	it("mounts with macFUSE when installed, else over NFS", async () => {
		const macFuse = new Set(["/Library/Filesystems/macfuse.fs", "/usr/local/lib/libfuse.2.dylib"])

		expect(await fuseStatus(context({ exists: file => macFuse.has(file) }))).toEqual({ state: "ready", provider: "macFuse" })
		expect(await fuseStatus(context({ exists: file => file === "/usr/local/lib/libfuse.2.dylib" }))).toEqual({
			state: "ready",
			provider: "nfsMount"
		})
	})

	it("finds WinFsp's DLL for this CPU through its 32-bit registry key", async () => {
		expect(winFspInstallDir(REG_QUERY)).toBe("C:\\Program Files (x86)\\WinFsp\\")
		expect(winFspInstallDir("ERROR: The system was unable to find the specified registry key or value.")).toBeNull()

		const run = vi.fn<FuseContext["run"]>(() => Promise.resolve({ code: 0, stdout: REG_QUERY }))
		const win = context({
			platform: "win32",
			arch: "x64",
			env: { SystemRoot: "C:\\Windows" },
			run,
			fuseInstaller: "C:\\Filen\\winfsp.msi"
		})

		expect(await fuseStatus({ ...win, exists: file => file === "C:\\Program Files (x86)\\WinFsp\\bin\\winfsp-x64.dll" })).toEqual({
			state: "ready",
			provider: "winFsp"
		})
		expect(run).toHaveBeenCalledWith("C:\\Windows\\System32\\reg.exe", [
			"query",
			"HKLM\\SOFTWARE\\WinFsp",
			"/v",
			"InstallDir",
			"/reg:32"
		])
		expect(await fuseStatus({ ...win, arch: "arm64", exists: file => file.endsWith("winfsp-x64.dll") })).toEqual({
			state: "missing",
			installable: true
		})
		expect(await fuseStatus({ ...win, fuseInstaller: null, run: () => Promise.resolve({ code: 1, stdout: "" }) })).toEqual({
			state: "missing",
			installable: false
		})
	})

	it("names what a Linux system lacks", async () => {
		const linux = context({ platform: "linux", env: { PATH: "/home/u/.local/bin:/usr/sbin" } })

		expect(linuxFuseGap({ ...linux, exists: () => false })).toBe("fuse3")
		expect(linuxFuseGap({ ...linux, exists: file => file === "/usr/sbin/fusermount3" })).toBe("device")
		expect(linuxFuseGap({ ...linux, exists: file => file === "/bin/fusermount3" || file === "/dev/fuse" })).toBeNull()
		expect(await fuseStatus({ ...linux, exists: file => file === "/usr/bin/fusermount3" || file === "/dev/fuse" })).toEqual({
			state: "ready",
			provider: "fuse3"
		})
		expect(await fuseStatus({ ...linux, exists: () => false })).toEqual({ state: "missing", installable: false })
	})

	it("maps msiexec's exit codes", () => {
		const table: [number | null, ReturnType<typeof msiOutcome>][] = [
			[0, "installed"],
			[1638, "installed"],
			[3010, "rebootRequired"],
			[1641, "rebootRequired"],
			[1602, "canceled"],
			[1223, "canceled"],
			[1603, "failed"],
			[1618, "failed"],
			[1, "failed"],
			[null, "failed"]
		]

		for (const [code, outcome] of table) {
			expect(msiOutcome(code)).toBe(outcome)
		}
	})

	it("installs WinFsp elevated, the MSI path only in the environment, and retries while another install runs", async () => {
		const codes = [1618, 1618, 3010]
		const run = vi.fn<FuseContext["run"]>(() => Promise.resolve({ code: codes.shift() ?? null, stdout: "" }))
		const msi = "C:\\Program Files\\Filen\\resources\\deps\\winfsp.msi"

		expect(await installWinFsp({ env: { SystemRoot: "C:\\Windows" }, run }, msi, 3, 0)).toBe("rebootRequired")
		expect(run).toHaveBeenCalledTimes(3)

		const [file, args, env] = run.mock.calls[0] ?? []

		expect(file).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
		expect(args?.join(" ")).toContain("-Verb RunAs")
		expect(args?.join(" ")).not.toContain(msi)
		expect(env?.["FILEN_WINFSP_MSI"]).toBe(msi)

		const busy = vi.fn<FuseContext["run"]>(() => Promise.resolve({ code: 1618, stdout: "" }))

		expect(await installWinFsp({ env: {}, run: busy }, msi, 2, 0)).toBe("failed")
		expect(busy).toHaveBeenCalledTimes(2)
	})
})

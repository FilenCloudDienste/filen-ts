import { execFile } from "node:child_process"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import type { DesktopFuseStatus } from "@filen/shared/desktop"

// What mounts the network drive, and getting it there:
// - macOS: macFUSE when the user installed it, else rclone's NFS mount, which needs nothing; the app installs neither.
// - Windows: WinFsp, which the NSIS installer brings; when it is missing anyway the app runs the bundled MSI elevated.
// - Linux: fuse3 (fusermount3 plus /dev/fuse). The deb and rpm recommend it; AppImage and zip users install it
//   themselves, which linuxFuseGap tells them how to.

export interface ProgramResult {
	// null when the program could not be started or was killed.
	code: number | null
	stdout: string
}

export interface FuseContext {
	platform: NodeJS.Platform
	arch: string
	env: NodeJS.ProcessEnv
	exists(file: string): boolean
	// Runs a program without a shell or a window.
	run(file: string, args: readonly string[], env?: NodeJS.ProcessEnv): Promise<ProgramResult>
	// The bundled WinFsp MSI (rclonePaths().fuseInstaller), null where the app ships none.
	fuseInstaller: string | null
}

export function runProgram(file: string, args: readonly string[], env?: NodeJS.ProcessEnv): Promise<ProgramResult> {
	return new Promise(resolve => {
		execFile(file, args, { encoding: "utf8", windowsHide: true, env: env ?? process.env }, (error, stdout) => {
			resolve({ code: error === null ? 0 : typeof error.code === "number" ? error.code : null, stdout })
		})
	})
}

// macFUSE's file system bundle plus the libfuse rclone's cmount loads.
export function macFuseInstalled(exists: (file: string) => boolean): boolean {
	return (
		exists("/Library/Filesystems/macfuse.fs") &&
		(exists("/usr/local/lib/libfuse.2.dylib") || exists("/usr/local/lib/libosxfuse.2.dylib"))
	)
}

// What a Linux system lacks to mount: the fuse3 package (fusermount3), or the FUSE device (a container or sandbox
// without /dev/fuse, which no package fixes). null when both are there.
export function linuxFuseGap(ctx: Pick<FuseContext, "env" | "exists">): "fuse3" | "device" | null {
	const dirs = [...(ctx.env["PATH"] ?? "").split(path.delimiter).filter(dir => dir.length > 0), "/usr/bin", "/bin"]

	if (!dirs.some(dir => ctx.exists(path.posix.join(dir, "fusermount3")))) {
		return "fuse3"
	}

	return ctx.exists("/dev/fuse") ? null : "device"
}

// WinFsp's install directory from its 32-bit registry key, the only one it writes.
export function winFspInstallDir(regQuery: string): string | null {
	return /^\s*InstallDir\s+REG_SZ\s+(.+?)\s*$/m.exec(regQuery)?.[1] ?? null
}

function system32(ctx: Pick<FuseContext, "env">, ...file: string[]): string {
	return path.win32.join(ctx.env["SystemRoot"] ?? "C:\\Windows", "System32", ...file)
}

async function winFspInstalled(ctx: FuseContext): Promise<boolean> {
	const query = await ctx.run(system32(ctx, "reg.exe"), ["query", "HKLM\\SOFTWARE\\WinFsp", "/v", "InstallDir", "/reg:32"])
	const installDir = query.code === 0 ? winFspInstallDir(query.stdout) : null

	return installDir !== null && ctx.exists(path.win32.join(installDir, "bin", ctx.arch === "arm64" ? "winfsp-a64.dll" : "winfsp-x64.dll"))
}

export async function fuseStatus(ctx: FuseContext): Promise<DesktopFuseStatus> {
	switch (ctx.platform) {
		case "darwin":
			return { state: "ready", provider: macFuseInstalled(ctx.exists) ? "macFuse" : "nfsMount" }
		case "win32":
			return (await winFspInstalled(ctx))
				? { state: "ready", provider: "winFsp" }
				: { state: "missing", installable: ctx.fuseInstaller !== null }
		case "linux":
			return linuxFuseGap(ctx) === null ? { state: "ready", provider: "fuse3" } : { state: "missing", installable: false }
		default:
			return { state: "missing", installable: false }
	}
}

export type FuseInstallResult = "installed" | "rebootRequired" | "canceled" | "failed"

// ERROR_INSTALL_ALREADY_RUNNING: another installation holds the Windows Installer mutex.
const MSI_BUSY = 1618

// msiexec's exit code (or ERROR_CANCELLED from a declined UAC prompt) as the outcome the user sees. 1638: another
// version of WinFsp is installed already, so it is there.
export function msiOutcome(code: number | null): FuseInstallResult {
	switch (code) {
		case 0:
		case 1638:
			return "installed"
		case 3010:
		case 1641:
			return "rebootRequired"
		case 1602:
		case 1223:
			return "canceled"
		default:
			return "failed"
	}
}

// Starts msiexec elevated through UAC and exits with its code; a declined prompt exits with ERROR_CANCELLED (1223).
// The MSI path arrives through the environment, never interpolated into the script.
const ELEVATED_MSIEXEC = [
	"try {",
	"$p = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\\msiexec.exe') -ArgumentList @('/i', ('\"' + $env:FILEN_WINFSP_MSI + '\"'), '/qn', '/norestart') -Verb RunAs -Wait -PassThru;",
	"exit $p.ExitCode",
	"} catch {",
	"$e = $_.Exception; while ($null -ne $e) { if ($e.NativeErrorCode -eq 1223) { exit 1223 }; $e = $e.InnerException };",
	"exit 1",
	"}"
].join(" ")

// Installs WinFsp per machine from the bundled MSI after the user's UAC consent. Retried while another installation
// is running.
export async function installWinFsp(
	ctx: Pick<FuseContext, "env" | "run">,
	msi: string,
	attempts = 3,
	waitMs = 5000
): Promise<FuseInstallResult> {
	for (let attempt = 1; ; attempt++) {
		const { code } = await ctx.run(
			system32(ctx, "WindowsPowerShell", "v1.0", "powershell.exe"),
			["-NoProfile", "-NonInteractive", "-Command", ELEVATED_MSIEXEC],
			{ ...ctx.env, FILEN_WINFSP_MSI: msi }
		)

		if (code !== MSI_BUSY || attempt >= attempts) {
			return msiOutcome(code)
		}

		await sleep(waitMs)
	}
}

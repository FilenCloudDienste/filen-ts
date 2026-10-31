import { spawn, type ChildProcess } from "node:child_process"
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { assertDisposableMachine } from "./e2e/context.ts"
import { asarVersion, fail, powershell, run } from "./support.ts"

// One install format on the runner it is tested on: how a user installs it, where its files and userData land, how
// it is launched and how its running main process is found. Names and locations are the frozen 3.x ones (PLAN D5),
// so the same target serves the 3.0.53 artifacts and the new ones.

export type Platform = "win" | "mac" | "linux"
export type Arch = "x64" | "arm64"
export type Format = "nsis" | "dmg" | "deb" | "rpm" | "AppImage"

export interface AppProcess {
	pid: number
	path: string
}

export interface Target {
	readonly platform: Platform
	readonly format: Format
	// The artifact a user downloads and installs; the 3.x release used the same name.
	readonly installer: string
	// The manifest this install polls and the file it must download from it.
	readonly manifest: string
	readonly updateFile: string
	// What a user's launch runs; the relaunched app must run from the same place.
	readonly executable: string
	readonly userData: string
	install(artifact: string): void
	// The machine without the app, its data or its updater caches; safe when nothing is installed.
	reset(): void
	// `args` reach the app after any the format itself needs; the child is the started process (the app's main process,
	// or the AppImage runtime that starts it).
	launch(env: NodeJS.ProcessEnv, args?: readonly string[]): ChildProcess
	// Main (browser) processes of the installed app; helpers and renderers are not listed.
	mainProcesses(): AppProcess[]
	// The version packed into the installed app.
	installedVersion(): string
	// The version the OS's package database or uninstall entry records, null where there is none.
	registeredVersion(): string | null
	// Checks run after every install: location, registration and the payload's signature when signed; on Windows also
	// WinFsp, which every installer (3.0.53's and the new one) installs.
	verifyInstall(signed: boolean): void
	// Hands `use` a file of the installed app's resources directory (an AppImage's is extracted for the call).
	resource<T>(relative: string, use: (file: string) => T): T
}

const home = os.homedir()

function remove(...paths: string[]): void {
	for (const target of paths) {
		rmSync(target, { recursive: true, force: true })
	}
}

const DELETED = " (deleted)"

function linuxPids(): number[] {
	return readdirSync("/proc")
		.map(Number)
		.filter(pid => Number.isSafeInteger(pid))
}

function linuxExe(pid: number): string | null {
	try {
		return readlinkSync(`/proc/${String(pid)}/exe`)
	} catch {
		return null
	}
}

function linuxParent(pid: number): number {
	try {
		return Number(/^PPid:\s*(\d+)/m.exec(readFileSync(`/proc/${String(pid)}/status`, "utf8"))?.[1] ?? 0)
	} catch {
		return 0
	}
}

// Linux: every process that is not a Chromium child (--type=...) and that `identify` attributes to the install, with
// the path `identify` reports for it.
function linuxProcesses(identify: (pid: number, exe: string) => string | null): AppProcess[] {
	const found: AppProcess[] = []

	for (const pid of linuxPids()) {
		try {
			const exe = linuxExe(pid)
			const cmdline = readFileSync(`/proc/${String(pid)}/cmdline`, "utf8").split("\0")
			const reported = exe === null || cmdline.some(arg => arg.startsWith("--type=")) ? null : identify(pid, exe)

			if (reported !== null) {
				found.push({ pid, path: reported })
			}
		} catch {
			// Gone, or another user's process.
		}
	}

	return found
}

// Diagnostics: every Filen or AppImage process with its parent chain and what its environ says about APPIMAGE.
export function linuxProcessReport(): string {
	const lines = linuxPids().flatMap(pid => {
		const exe = linuxExe(pid)

		if (exe === null || (path.basename(exe) !== "Filen" && !exe.includes(".AppImage"))) {
			return []
		}

		const chain: string[] = []

		for (let current = linuxParent(pid), depth = 0; current > 1 && depth < 4; current = linuxParent(current), depth++) {
			chain.push(`${String(current)}:${linuxExe(current) ?? "?"}`)
		}

		let appImage: string

		try {
			appImage =
				readFileSync(`/proc/${String(pid)}/environ`, "utf8")
					.split("\0")
					.find(entry => entry.startsWith("APPIMAGE=")) ?? "no APPIMAGE"
		} catch (error) {
			appImage = `environ unreadable (${error instanceof Error ? error.message : String(error)})`
		}

		let args: string

		try {
			args = readFileSync(`/proc/${String(pid)}/cmdline`, "utf8")
				.split("\0")
				.slice(0, 3)
				.join(" ")
		} catch {
			args = "?"
		}

		return [`${String(pid)} ${exe} [${args}] ${appImage} parents ${chain.join(" <- ") || "none"}`]
	})

	return lines.join("\n") || "(no Filen or AppImage processes)"
}

function killAll(processes: AppProcess[]): void {
	for (const { pid } of processes) {
		try {
			process.kill(pid, "SIGKILL")
		} catch {
			// Already gone.
		}
	}
}

function detached(executable: string, args: readonly string[], env: NodeJS.ProcessEnv): ChildProcess {
	const child = spawn(executable, args, { detached: true, stdio: "ignore", env })

	child.on("error", error => {
		console.error(`${executable}: ${error.message}`)
	})
	child.unref()

	return child
}

function powershellText(script: string): string {
	return powershell(script).stdout.trim()
}

function windows(): Target {
	const installDir = path.join(process.env["ProgramFiles"] ?? "C:\\Program Files", "Filen")
	const executable = path.join(installDir, "Filen.exe")
	const appData = process.env["APPDATA"] ?? path.join(home, "AppData", "Roaming")
	const localAppData = process.env["LOCALAPPDATA"] ?? path.join(home, "AppData", "Local")
	// The per-machine uninstall entry; a per-user one would mean the installer ignored perMachine.
	const uninstallEntry = (root: "HKLM" | "HKCU") =>
		powershellText(
			`$roots = @('${root}:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall', '${root}:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'); ` +
				`foreach ($r in $roots) { Get-ChildItem $r -ErrorAction SilentlyContinue | ForEach-Object { $p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue; ` +
				`if ($p.DisplayName -eq 'Filen' -or $p.DisplayName -like 'Filen [0-9]*') { "$($p.DisplayVersion)|$($p.InstallLocation)" } } }`
		)
	// WinFsp registers under the 32-bit view only; its DLL for this CPU must be there too.
	const winFspDll = (): string | null => {
		const installDir = powershellText(
			"(Get-ItemProperty -Path 'HKLM:\\SOFTWARE\\WOW6432Node\\WinFsp' -Name InstallDir -ErrorAction SilentlyContinue).InstallDir"
		)
		const dll =
			installDir === "" ? null : path.win32.join(installDir, "bin", process.arch === "arm64" ? "winfsp-a64.dll" : "winfsp-x64.dll")

		return dll !== null && existsSync(dll) ? dll : null
	}
	const mainProcesses = (): AppProcess[] =>
		powershellText(
			'Get-CimInstance Win32_Process -Filter "Name=\'Filen.exe\'" | ForEach-Object { "$($_.ProcessId)`t$($_.ExecutablePath)`t$($_.CommandLine)" }'
		)
			.split(/\r?\n/)
			.filter(line => line !== "" && !line.includes("--type="))
			.map(line => {
				const [pid, exe] = line.split("\t")

				return { pid: Number(pid), path: exe ?? "" }
			})

	return {
		platform: "win",
		format: "nsis",
		installer: "Filen_win.exe",
		manifest: "latest.yml",
		updateFile: "Filen_win.exe",
		executable,
		userData: path.join(appData, "@filen", "desktop"),
		install(artifact) {
			// Silent, from the already elevated runner shell: the per-machine install a user confirms through UAC.
			run(artifact, ["/S"])
		},
		reset() {
			run("taskkill.exe", ["/F", "/T", "/IM", "Filen.exe"], { allowFailure: true })

			const uninstaller = path.join(installDir, "Uninstall Filen.exe")

			if (existsSync(uninstaller)) {
				// _?= runs the uninstaller in place (synchronously) and must reach NSIS unquoted to the end of the line.
				run("cmd.exe", ["/d", "/s", "/c", `""${uninstaller}" /S _?=${installDir}"`], { verbatim: true, allowFailure: true })
			}

			// WinFsp outlives the app's uninstaller; removed so that every install has to bring it.
			const winFsp = powershellText(
				"$roots = @('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall', 'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'); " +
					"foreach ($r in $roots) { Get-ChildItem $r -ErrorAction SilentlyContinue | ForEach-Object { $p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue; " +
					"if ($p.DisplayName -like 'WinFsp*' -and $_.PSChildName -match '^\\{[0-9A-Fa-f-]+\\}$') { $_.PSChildName } } }"
			)

			for (const product of new Set(winFsp.split(/\r?\n/).filter(line => line !== ""))) {
				run("msiexec.exe", ["/x", product, "/qn", "/norestart"], { allowFailure: true })
			}

			remove(
				installDir,
				path.join(appData, "@filen", "desktop"),
				path.join(appData, "@filen", "logs"),
				path.join(localAppData, "@filendesktop-updater"),
				path.join(localAppData, "@filen", "desktop-updater")
			)
		},
		launch(env, args = []) {
			return detached(executable, args, env)
		},
		mainProcesses,
		installedVersion: () => asarVersion(path.join(installDir, "resources", "app.asar")),
		registeredVersion() {
			const entry = uninstallEntry("HKLM")

			return entry === "" ? null : (entry.split(/\r?\n/)[0]?.split("|")[0] ?? null)
		},
		verifyInstall(signed) {
			if (!existsSync(executable)) {
				fail(`${executable} is missing: the installer put the app somewhere else`)
			}

			if (existsSync(path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Filen", "Filen.exe"))) {
				fail("Filen is (also) installed under Program Files (x86)")
			}

			if (!existsSync(path.join(installDir, "resources", "elevate.exe"))) {
				fail("resources\\elevate.exe is missing: a per-machine install could not update itself")
			}

			if (uninstallEntry("HKLM") === "") {
				fail("no per-machine (HKLM) uninstall entry for Filen")
			}

			if (uninstallEntry("HKCU") !== "") {
				fail("a per-user (HKCU) uninstall entry for Filen exists: the install was not per-machine")
			}

			if (winFspDll() === null) {
				fail("WinFsp is not installed (no InstallDir under HKLM\\SOFTWARE\\WinFsp, or no DLL for this CPU)")
			}

			if (signed) {
				const status = powershellText(`(Get-AuthenticodeSignature -FilePath '${executable}').Status`)

				if (status !== "Valid") {
					fail(`${executable}: Authenticode status ${status}`)
				}
			}
		},
		resource: (relative, use) => use(path.join(installDir, "resources", relative))
	}
}

function mac(arch: Arch): Target {
	const app = "/Applications/Filen.app"
	const executable = path.join(app, "Contents", "MacOS", "Filen")
	const support = path.join(home, "Library", "Application Support")
	const caches = path.join(home, "Library", "Caches")

	return {
		platform: "mac",
		format: "dmg",
		installer: `Filen_mac_${arch}.dmg`,
		manifest: "latest-mac.yml",
		updateFile: `Filen_mac_${arch}.zip`,
		executable,
		userData: path.join(support, "@filen", "desktop"),
		install(artifact) {
			// Mount, drag to Applications, eject: what a user does with the website's disk image.
			const mountpoint = mkdtempSync(path.join(os.tmpdir(), "filen-dmg-"))

			run("hdiutil", ["attach", "-nobrowse", "-readonly", "-noautoopen", "-mountpoint", mountpoint, artifact])

			try {
				run("ditto", [path.join(mountpoint, "Filen.app"), app])
			} finally {
				// Spotlight indexing the fresh mount can hold it busy for a moment.
				if (run("hdiutil", ["detach", mountpoint], { allowFailure: true }).status !== 0) {
					run("hdiutil", ["detach", "-force", mountpoint], { allowFailure: true })
				}
			}
		},
		reset() {
			run("pkill", ["-9", "-f", app], { allowFailure: true })
			remove(app, path.join(support, "@filen"))

			if (existsSync(caches)) {
				for (const entry of readdirSync(caches)) {
					if (entry.startsWith("@filen") || entry.startsWith("io.filen.desktop")) {
						remove(path.join(caches, entry))
					}
				}
			}
		},
		launch(env, args = []) {
			return detached(executable, args, env)
		},
		mainProcesses: () =>
			run("ps", ["-axo", "pid=,comm="])
				.stdout.split("\n")
				.map(line => /^\s*(\d+)\s+(.+?)\s*$/.exec(line))
				.filter(match => match !== null && match[2] === executable)
				.map(match => ({ pid: Number(match?.[1]), path: match?.[2] ?? "" })),
		installedVersion: () => asarVersion(path.join(app, "Contents", "Resources", "app.asar")),
		registeredVersion: () =>
			run("/usr/libexec/PlistBuddy", [
				"-c",
				"Print :CFBundleShortVersionString",
				path.join(app, "Contents", "Info.plist")
			]).stdout.trim(),
		verifyInstall(signed) {
			const lipo = run("lipo", ["-archs", executable]).stdout.trim()

			if (lipo !== (arch === "x64" ? "x86_64" : "arm64")) {
				fail(`${executable} is ${lipo}, expected the ${arch} build`)
			}

			if (signed) {
				run("codesign", ["--verify", "--deep", "--strict", app])
			}
		},
		resource: (relative, use) => use(path.join(app, "Contents", "Resources", relative))
	}
}

function linux(arch: Arch, format: "deb" | "rpm" | "AppImage"): Target {
	const config = process.env["XDG_CONFIG_HOME"] ?? path.join(home, ".config")
	const cache = process.env["XDG_CACHE_HOME"] ?? path.join(home, ".cache")
	const userData = path.join(config, "@filen", "desktop")
	const manifest = arch === "x64" ? "latest-linux.yml" : "latest-linux-arm64.yml"
	const clean = () => {
		remove(path.join(config, "@filen"))

		if (existsSync(cache)) {
			for (const entry of readdirSync(cache)) {
				if (entry.startsWith("@filen")) {
					remove(path.join(cache, entry))
				}
			}
		}
	}

	if (format === "AppImage") {
		const file = `Filen_linux_${arch === "x64" ? "x86_64" : "arm64"}.AppImage`
		const executable = path.join(home, "Applications", file)
		// A Filen main process belongs to this AppImage when the runtime that started it is this file. The runtime is the
		// AppImage file itself running (its exe reads "<file> (deleted)" once an update replaced the file) and starts the
		// app (extracted, or from its FUSE mount) as its child. Its APPIMAGE export cannot be read back from the app:
		// Chromium reuses the main process's environ area for its process title. Reported at the AppImage's path.
		const mainProcesses = () =>
			linuxProcesses((pid, exe) => {
				if (path.basename(exe) !== "Filen" || exe === "/opt/Filen/Filen") {
					return null
				}

				for (let current = linuxParent(pid), depth = 0; current > 1 && depth < 4; current = linuxParent(current), depth++) {
					const runtime = linuxExe(current)

					if (runtime === executable || runtime === `${executable}${DELETED}`) {
						return runtime
					}
				}

				return null
			})

		return {
			platform: "linux",
			format,
			installer: file,
			manifest,
			updateFile: file,
			executable,
			userData,
			install(artifact) {
				mkdirSync(path.dirname(executable), { recursive: true })
				copyFileSync(artifact, executable)
				chmodSync(executable, 0o755)
			},
			reset() {
				killAll(mainProcesses())
				run("pkill", ["-9", "-f", executable], { allowFailure: true })
				remove(executable)
				clean()
			},
			launch(env, args = []) {
				// No FUSE on the runners: the runtime extracts itself instead, and still sets APPIMAGE for the updater.
				return detached(executable, args, { ...env, APPIMAGE_EXTRACT_AND_RUN: "1" })
			},
			mainProcesses,
			installedVersion() {
				const work = mkdtempSync(path.join(os.tmpdir(), "filen-appimage-"))

				try {
					run(executable, ["--appimage-extract", "resources/app.asar"], { cwd: work })

					return asarVersion(path.join(work, "squashfs-root", "resources", "app.asar"))
				} finally {
					remove(work)
				}
			},
			registeredVersion: () => null,
			verifyInstall() {
				if (!existsSync(executable)) {
					fail(`${executable} is missing`)
				}
			},
			resource(relative, use) {
				const work = mkdtempSync(path.join(os.tmpdir(), "filen-appimage-"))

				try {
					run(executable, ["--appimage-extract", `resources/${relative}`], { cwd: work })

					return use(path.join(work, "squashfs-root", "resources", relative))
				} finally {
					remove(work)
				}
			}
		}
	}

	const executable = "/opt/Filen/Filen"
	const root = process.getuid?.() === 0
	const sudo = (command: string, args: string[], allowFailure = false) =>
		root ? run(command, args, { allowFailure }) : run("sudo", ["--non-interactive", command, ...args], { allowFailure })
	const deb = format === "deb"
	const file = deb ? `Filen_linux_${arch === "x64" ? "amd64" : "arm64"}.deb` : `Filen_linux_${arch === "x64" ? "x86_64" : "aarch64"}.rpm`
	const mainProcesses = () => linuxProcesses((_pid, exe) => (exe === executable ? exe : null))
	// Package names are matched case-insensitively: dpkg lowercases what the rpm keeps as "Filen".
	const packageVersion = (): string | null => {
		const listing = deb
			? run("dpkg-query", ["-W", "-f", "${db:Status-Abbrev}|${Package}|${Version}\\n"], { allowFailure: true }).stdout
			: run("rpm", ["-qa", "--qf", "ii |%{NAME}|%{VERSION}\\n"], { allowFailure: true }).stdout
		const line = listing.split("\n").find(entry => /^ii\s*\|filen\|/i.test(entry))

		return line?.split("|")[2] ?? null
	}

	return {
		platform: "linux",
		format,
		installer: file,
		manifest,
		updateFile: file,
		executable,
		userData,
		install(artifact) {
			if (deb) {
				sudo("env", ["DEBIAN_FRONTEND=noninteractive", "apt-get", "install", "--yes", path.resolve(artifact)])
			} else {
				sudo("dnf", ["install", "--assumeyes", path.resolve(artifact)])
			}
		},
		reset() {
			killAll(mainProcesses())

			if (packageVersion() !== null) {
				if (deb) {
					sudo("env", ["DEBIAN_FRONTEND=noninteractive", "dpkg", "--purge", "filen"], true)
				} else {
					sudo("dnf", ["remove", "--assumeyes", "Filen"], true)
				}
			}

			clean()
		},
		launch(env, args = []) {
			// Chromium refuses to run as root with its sandbox; only the rpm container runs as root.
			return detached(executable, root ? ["--no-sandbox", ...args] : args, env)
		},
		mainProcesses,
		installedVersion: () => asarVersion("/opt/Filen/resources/app.asar"),
		registeredVersion: packageVersion,
		verifyInstall() {
			if (!existsSync(executable)) {
				fail(`${executable} is missing`)
			}

			if (packageVersion() === null) {
				fail(`the package manager does not list Filen as installed`)
			}

			// electron-updater picks its Linux updater from this file.
			const packageType = readFileSync("/opt/Filen/resources/package-type", "utf8").trim()

			if (packageType !== format) {
				fail(`resources/package-type is "${packageType}", expected "${format}"`)
			}

			// Without the profile Ubuntu 24.04 aborts the sandbox at startup; the deb's postinst installs it.
			if (deb && existsSync("/sys/kernel/security/apparmor") && !existsSync("/etc/apparmor.d/Filen")) {
				fail("/etc/apparmor.d/Filen is missing: the app cannot start its sandbox on Ubuntu 24.04")
			}
		},
		resource: (relative, use) => use(path.join("/opt/Filen/resources", relative))
	}
}

function create(platform: Platform, arch: Arch, format: Format): Target {
	if (platform === "win" && format === "nsis") {
		return windows()
	}

	if (platform === "mac" && format === "dmg") {
		return mac(arch)
	}

	if (platform === "linux" && (format === "deb" || format === "rpm" || format === "AppImage")) {
		return linux(arch, format)
	}

	return fail(`no ${format} target on ${platform}`)
}

// Every target passes the disposable-machine guard before anything can reset or install it.
export function targetFor(platform: Platform, arch: Arch, format: Format): Target {
	const target = create(platform, arch, format)

	assertDisposableMachine(target)

	return target
}

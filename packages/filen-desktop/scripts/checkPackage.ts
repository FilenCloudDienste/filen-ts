import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { parseArgs } from "node:util"
import { isFeedPlatform } from "./feed.ts"
import { nativeArchOf } from "./nativeArch.ts"
import { MAC_TEAM } from "./signRclone.ts"

// Checks the unpacked apps electron-builder leaves in release/: the web build, tray assets, the sync addon and rclone
// (both built for the app's arch) and, on Windows, WinFsp's installer made it in, and the app-update.yml baked into
// each app polls the frozen feed with no channel. On Linux, rclone must be the binary whose sha256 the main bundle
// carries. With --signed, the Windows one must also pin the publisher, which is what makes the updater verify an
// update's signature, and rclone.exe must carry the publisher's valid Authenticode signature; on macOS the addon and
// rclone must carry the team's valid signature (the hardened runtime loads nothing else), rclone with the hardened
// runtime, a secure timestamp and exactly build/entitlements.rclone.plist.
// DESKTOP_FEED_URL, when set, must equal the builder config's feed, so a workflow cannot upload somewhere else.
//
//   node scripts/checkPackage.ts <mac|win|linux> <x64|arm64>... [--signed]

const { values, positionals } = parseArgs({ options: { signed: { type: "boolean", default: false } }, allowPositionals: true })
const [platform, ...archs] = positionals

if (!isFeedPlatform(platform) || archs.length === 0 || archs.some(arch => arch !== "x64" && arch !== "arm64")) {
	console.error("usage: node scripts/checkPackage.ts <mac|win|linux> <x64|arm64>... [--signed]")
	process.exit(1)
}

const { default: config } = await import("../electron-builder.ts")
const publish = Array.isArray(config.publish) ? config.publish[0] : config.publish
const feedUrl = typeof publish === "object" && publish !== null && "url" in publish ? publish.url : undefined
const winConfig = config.win
const publisher = typeof winConfig === "object" && winConfig !== null ? winConfig.azureSignOptions?.publisherName : undefined
const failures: string[] = []

if (typeof feedUrl !== "string") {
	throw new Error("electron-builder.ts has no generic publish url")
}

const normalise = (url: string) => url.replace(/\/+$/, "")
const workflowFeed = process.env["DESKTOP_FEED_URL"]

if (workflowFeed !== undefined && normalise(workflowFeed) !== normalise(feedUrl)) {
	failures.push(`DESKTOP_FEED_URL ${workflowFeed} differs from the builder config's ${feedUrl}`)
}

// Problems with a Mach-O's Developer ID signature; `entitlements`, when given, is the plist it must carry exactly,
// along with the hardened runtime and a secure timestamp.
function macSignatureProblems(file: string, entitlements?: string): string[] {
	const problems: string[] = []
	const verify = spawnSync("codesign", ["--verify", "--strict", file], { encoding: "utf8" })
	const details = spawnSync("codesign", ["-dv", file], { encoding: "utf8" })

	if (verify.status !== 0) {
		problems.push(`${file}: signature does not verify: ${verify.stderr.trim()}`)
	}

	if (!new RegExp(`^TeamIdentifier=${MAC_TEAM}$`, "m").test(details.stderr)) {
		problems.push(`${file}: not signed by team ${MAC_TEAM}`)
	}

	if (entitlements === undefined) {
		return problems
	}

	if (!/^CodeDirectory .*flags=0x[0-9a-f]+\([^)]*\bruntime\b/m.test(details.stderr)) {
		problems.push(`${file}: no hardened runtime`)
	}

	if (!/^Timestamp=/m.test(details.stderr)) {
		problems.push(`${file}: no secure timestamp`)
	}

	const keys = (plist: string) =>
		[...plist.matchAll(/<key>([^<]+)<\/key>/g)]
			.map(match => match[1])
			.sort()
			.join(",")
	const carried = spawnSync("codesign", ["-d", "--entitlements", "-", "--xml", file], { encoding: "utf8" })

	if (keys(carried.stdout) !== keys(readFileSync(entitlements, "utf8"))) {
		problems.push(`${file}: entitlements [${keys(carried.stdout)}] differ from ${entitlements}`)
	}

	return problems
}

// Status and signer subject of a file's Authenticode signature (Windows).
function authenticode(file: string): { status: string; subject: string } {
	const result = spawnSync(
		"powershell.exe",
		[
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			"$s = Get-AuthenticodeSignature -LiteralPath $env:CHECK_FILE; $s.Status; $s.SignerCertificate.Subject"
		],
		{ encoding: "utf8", env: { ...process.env, CHECK_FILE: file } }
	)
	const [status = "", subject = ""] = result.stdout.trim().split(/\r?\n/)

	return { status: status.trim(), subject: subject.trim() }
}

const rcloneDigests: Partial<Record<string, string>> =
	platform === "linux" && existsSync(path.join("build", "rclone", "manifest.json"))
		? (JSON.parse(readFileSync(path.join("build", "rclone", "manifest.json"), "utf8")) as Partial<Record<string, string>>)
		: {}

function resourcesOf(arch: string): { app: string; resources: string; executable: string } {
	const suffix = arch === "x64" ? "" : `-${arch}`

	switch (platform) {
		case "mac": {
			const app = path.join("release", `mac${suffix}`, "Filen.app")

			return { app, resources: path.join(app, "Contents", "Resources"), executable: path.join(app, "Contents", "MacOS", "Filen") }
		}
		case "win": {
			const app = path.join("release", `win${suffix}-unpacked`)

			return { app, resources: path.join(app, "resources"), executable: path.join(app, "Filen.exe") }
		}
		default: {
			const app = path.join("release", `linux${suffix}-unpacked`)

			return { app, resources: path.join(app, "resources"), executable: path.join(app, "Filen") }
		}
	}
}

for (const arch of archs) {
	const { app, resources, executable } = resourcesOf(arch)
	const required = [
		executable,
		path.join(resources, "app.asar"),
		path.join(resources, "web", "index.html"),
		path.join(resources, "web", "_headers")
	]

	if (platform === "win") {
		// packElevateHelper: the per-machine installer elevates through it during silent updates.
		required.push(path.join(resources, "elevate.exe"))
	}

	for (const file of required) {
		if (!existsSync(file)) {
			failures.push(`${app}: ${file} is missing`)
		}
	}

	const addon = path.join(resources, "native", "sdk-rs.node")

	if (existsSync(addon)) {
		const found = nativeArchOf(addon)

		if (found !== arch) {
			failures.push(`${addon}: built for ${found ?? "an unknown architecture"}, not ${arch}`)
		}

		if (values.signed && platform === "mac") {
			failures.push(...macSignatureProblems(addon))
		}
	} else {
		failures.push(`${app}: ${addon} is missing`)
	}

	const rclone = path.join(resources, "rclone", platform === "win" ? "rclone.exe" : "rclone")

	if (existsSync(rclone)) {
		const found = nativeArchOf(rclone)

		if (found !== arch) {
			failures.push(`${rclone}: built for ${found ?? "an unknown architecture"}, not ${arch}`)
		}

		if (platform === "linux") {
			const sha256 = createHash("sha256").update(readFileSync(rclone)).digest("hex")

			if (rcloneDigests[arch] !== sha256) {
				failures.push(`${rclone}: sha256 ${sha256} is not the staged one (build/rclone/manifest.json)`)
			} else if (!readFileSync(path.join("dist", "main.js"), "utf8").includes(sha256)) {
				failures.push(`${rclone}: its sha256 is not baked into dist/main.js`)
			}
		}

		if (values.signed && platform === "mac") {
			failures.push(...macSignatureProblems(rclone, path.join("build", "entitlements.rclone.plist")))
		}

		if (values.signed && platform === "win") {
			const { status, subject } = authenticode(rclone)

			if (status !== "Valid" || publisher === undefined || !subject.includes(publisher.replace(/ \(.*$/, ""))) {
				failures.push(`${rclone}: Authenticode status ${status}, signed by ${subject || "nobody"}`)
			}
		}
	} else {
		failures.push(`${app}: ${rclone} is missing`)
	}

	if (platform === "win" && !existsSync(path.join(resources, "deps", "winfsp.msi"))) {
		failures.push(`${app}: deps\\winfsp.msi is missing`)
	}

	const tray = path.join(resources, "tray")

	if (!existsSync(tray) || readdirSync(tray).length === 0) {
		failures.push(`${app}: no tray assets`)
	}

	const updateYml = path.join(resources, "app-update.yml")

	if (!existsSync(updateYml)) {
		failures.push(`${app}: app-update.yml is missing`)

		continue
	}

	const text = readFileSync(updateYml, "utf8")
	const url = /^url:\s*(\S+)\s*$/m.exec(text)?.[1]

	if (!/^provider:\s*generic\s*$/m.test(text)) {
		failures.push(`${updateYml}: provider is not generic`)
	}

	if (url === undefined || normalise(url) !== normalise(feedUrl)) {
		failures.push(`${updateYml}: url is ${url ?? "missing"}, expected ${feedUrl}`)
	}

	if (/^channel:/m.test(text)) {
		failures.push(`${updateYml}: names a channel, which renames the manifests clients poll`)
	}

	if (values.signed && platform === "win" && (publisher === undefined || !text.includes(publisher))) {
		failures.push(`${updateYml}: publisherName is not ${publisher ?? "configured (AZURE_SIGNING_* unset)"}`)
	}

	console.log(`${app}: checked`)
}

if (failures.length > 0) {
	for (const failure of failures) {
		console.error(`::error::${failure}`)
	}

	process.exit(1)
}

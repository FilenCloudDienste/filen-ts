import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { type } from "arktype"
import { unzipSync } from "fflate"
import { nativeArch, type NativeArch } from "./nativeArch.ts"

// Stages the official rclone of both architectures for this OS at build/rclone/<os>-<arch>/rclone[.exe], where
// electron-builder picks it up per arch (extraResources) and rclonePath finds it in development; on Windows also the
// WinFsp installer at build/deps/win/winfsp.msi, which the NSIS installer and the app run. On Linux it writes
// build/rclone/manifest.json ({ arch: sha256 } of the extracted binaries), which build.ts bakes into the main bundle:
// nothing re-signs the binary there, so the app checks it against that digest.
//
// build/rclone/versions.json pins every download. The rclone zips' sha256 come from the release's SHA256SUMS
// (https://downloads.rclone.org/v<version>/SHA256SUMS, PGP-signed by the rclone release key
// FBF737ECE9F8AB18604BD2AC93935E02FF3B54FA, identical on the GitHub release); WinFsp publishes none, so its MSI's is
// the GitHub release asset's digest. Downloads are cached in node_modules/.cache/filen-rclone and reused only while
// they match.
//
//   node scripts/stageRclone.ts

const packageDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const cacheDir = path.join(packageDir, "node_modules", ".cache", "filen-rclone")
const ARCHS: NativeArch[] = ["x64", "arm64"]
// electron-builder's ${os} and rclone's name for the same OS.
const OS: Partial<Record<NodeJS.Platform, { builder: "mac" | "win" | "linux"; rclone: string }>> = {
	darwin: { builder: "mac", rclone: "osx" },
	win32: { builder: "win", rclone: "windows" },
	linux: { builder: "linux", rclone: "linux" }
}
const RCLONE_ARCH: Record<NativeArch, string> = { x64: "amd64", arm64: "arm64" }

const sha256Schema = type(/^[0-9a-f]{64}$/)
const versionsSchema = type({
	rclone: /^\d+\.\d+\.\d+$/,
	rcloneSha256: {
		"mac-x64": sha256Schema,
		"mac-arm64": sha256Schema,
		"win-x64": sha256Schema,
		"win-arm64": sha256Schema,
		"linux-x64": sha256Schema,
		"linux-arm64": sha256Schema
	},
	winfsp: /^\d+\.\d+\.\d+$/,
	winfspUrl: /^https:\/\/github\.com\/winfsp\/winfsp\/releases\/download\//,
	winfspSha256: sha256Schema
})

export type RcloneVersions = typeof versionsSchema.infer

export function readVersions(file = path.join(packageDir, "build", "rclone", "versions.json")): RcloneVersions {
	const parsed = versionsSchema(JSON.parse(readFileSync(file, "utf8")))

	if (parsed instanceof type.errors) {
		throw new Error(`${file}: ${parsed.summary}`)
	}

	return parsed
}

export function sha256Hex(data: Uint8Array): string {
	return createHash("sha256").update(data).digest("hex")
}

// The bytes when they hash to the pinned value; anything else is refused, never staged.
export function pinned(data: Uint8Array, sha256: string, what: string): Uint8Array {
	const actual = sha256Hex(data)

	if (actual !== sha256) {
		throw new Error(`${what}: sha256 ${actual} does not match the pinned ${sha256}`)
	}

	return data
}

// The rclone binary out of an official release zip (its single <zip name>/rclone[.exe] entry), refused unless it is
// built for `arch`.
export function rcloneFromZip(zip: Uint8Array, entry: string, arch: NativeArch): Uint8Array {
	const binary = unzipSync(zip, { filter: file => file.name === entry })[entry]

	if (binary === undefined) {
		throw new Error(`the zip has no ${entry}`)
	}

	const found = nativeArch(Buffer.from(binary.buffer, binary.byteOffset, Math.min(binary.byteLength, 4096)))

	if (found !== arch) {
		throw new Error(`${entry} is built for ${found ?? "an unknown architecture"}, not ${arch}`)
	}

	return binary
}

function writeAtomic(file: string, data: Uint8Array, mode = 0o644): void {
	const part = `${file}.part`

	mkdirSync(path.dirname(file), { recursive: true })
	writeFileSync(part, data, { mode })
	renameSync(part, file)
}

// A pinned download, from the cache when the cached copy still matches.
async function download(url: string, sha256: string): Promise<Uint8Array> {
	const cached = path.join(cacheDir, path.basename(new URL(url).pathname))

	if (existsSync(cached)) {
		const data = readFileSync(cached)

		if (sha256Hex(data) === sha256) {
			return data
		}
	}

	console.log(`stageRclone: downloading ${url}`)

	const response = await fetch(url)

	if (!response.ok) {
		throw new Error(`${url}: HTTP ${String(response.status)}`)
	}

	const data = pinned(new Uint8Array(await response.arrayBuffer()), sha256, url)

	writeAtomic(cached, data)

	return data
}

export async function stageRclone(): Promise<void> {
	const os = OS[process.platform]

	if (os === undefined) {
		throw new Error(`No rclone for ${process.platform}`)
	}

	const versions = readVersions()
	const executable = os.builder === "win" ? "rclone.exe" : "rclone"
	const digests: Partial<Record<NativeArch, string>> = {}

	for (const arch of ARCHS) {
		const name = `rclone-v${versions.rclone}-${os.rclone}-${RCLONE_ARCH[arch]}`
		const zip = await download(
			`https://downloads.rclone.org/v${versions.rclone}/${name}.zip`,
			versions.rcloneSha256[`${os.builder}-${arch}`]
		)
		const binary = rcloneFromZip(zip, `${name}/${executable}`, arch)
		const target = path.join(packageDir, "build", "rclone", `${os.builder}-${arch}`)

		// A stale copy must not outlive the release it came from.
		rmSync(target, { recursive: true, force: true })
		writeAtomic(path.join(target, executable), binary, 0o755)
		digests[arch] = sha256Hex(binary)
		console.log(`stageRclone: ${arch} rclone ${versions.rclone}`)
	}

	const manifest = path.join(packageDir, "build", "rclone", "manifest.json")

	if (os.builder === "linux") {
		writeAtomic(manifest, Buffer.from(`${JSON.stringify(digests)}\n`))
	} else {
		rmSync(manifest, { force: true })
	}

	const deps = path.join(packageDir, "build", "deps")

	rmSync(deps, { recursive: true, force: true })

	if (os.builder === "win") {
		writeAtomic(path.join(deps, "win", "winfsp.msi"), await download(versions.winfspUrl, versions.winfspSha256))
		console.log(`stageRclone: WinFsp ${versions.winfsp}`)
	}
}

if (import.meta.main) {
	await stageRclone()
}

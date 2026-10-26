import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { feedManifests, hashFile, isFeedPlatform, parseFeed, type FeedPlatform } from "./feed.ts"

// The feed contract the installed 3.x clients depend on, checked on one platform's release output before anything is
// published. Every name here is frozen: the installed apps poll exactly these manifests and download exactly these
// files. A wrong hash or size fails their download, a missing entry strands a whole install format, and a bad
// minimumSystemVersion either offers old Macs a build they cannot run or (unparseable) passes every Mac.
//
//   node scripts/checkFeed.ts <mac|win|linux> [dir]   (dir defaults to release)

const platform = process.argv[2]

if (!isFeedPlatform(platform)) {
	console.error("usage: node scripts/checkFeed.ts <mac|win|linux> [dir]")
	process.exit(1)
}

const dir = process.argv[3] ?? "release"

interface ManifestContract {
	// The files[] urls, in any order.
	files: string[]
	// Pre-6.8 electron-updater on Windows downloads files[0] whatever its architecture.
	first?: string
	minimumSystemVersion?: string
	adminRights?: boolean
}

// Published beside the manifests without being listed in them.
const extras: Record<FeedPlatform, string[]> = {
	mac: [],
	win: ["Filen_win.exe.blockmap", "Filen_win_x64.zip", "Filen_win_arm64.zip"],
	linux: ["Filen_linux_x64.zip", "Filen_linux_arm64.zip"]
}

async function contracts(): Promise<Record<string, ManifestContract>> {
	switch (platform) {
		case "mac": {
			// Loaded only here: the builder config refuses to load without a web build, which the Mac job has.
			const { macMinimum } = await import("../electron-builder.ts")

			return {
				"latest-mac.yml": {
					files: ["Filen_mac_x64.zip", "Filen_mac_arm64.zip", "Filen_mac_x64.dmg", "Filen_mac_arm64.dmg"],
					minimumSystemVersion: macMinimum.darwin
				}
			}
		}
		case "win":
			return { "latest.yml": { files: ["Filen_win.exe"], first: "Filen_win.exe", adminRights: true } }
		case "linux":
			return {
				"latest-linux.yml": { files: ["Filen_linux_x86_64.AppImage", "Filen_linux_amd64.deb", "Filen_linux_x86_64.rpm"] },
				"latest-linux-arm64.yml": { files: ["Filen_linux_arm64.AppImage", "Filen_linux_arm64.deb", "Filen_linux_aarch64.rpm"] }
			}
		default:
			throw new Error(`unknown platform ${String(platform)}`)
	}
}

const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
const expected = await contracts()
const failures: string[] = []
const entries = await readdir(dir)

// A channel (or any stray manifest) renames what clients poll; only the known manifests may exist.
const manifestsOnDisk = entries.filter(name => name.endsWith(".yml") && name !== "builder-debug.yml").sort()
const manifestsExpected = [...feedManifests[platform]].sort()

if (manifestsOnDisk.join() !== manifestsExpected.join()) {
	failures.push(`manifests in ${dir} are [${manifestsOnDisk.join(", ")}], expected [${manifestsExpected.join(", ")}]`)
}

for (const [manifest, contract] of Object.entries(expected)) {
	const text = await readFile(path.join(dir, manifest), "utf8").catch(() => null)

	if (text === null) {
		failures.push(`${manifest} is missing`)

		continue
	}

	const feed = parseFeed(text, manifest)
	const urls = feed.files.map(file => file.url)

	if (feed.top.get("version") !== version) {
		failures.push(`${manifest}: version ${feed.top.get("version") ?? "missing"}, expected ${version}`)
	}

	if ([...urls].sort().join() !== [...contract.files].sort().join()) {
		failures.push(`${manifest}: files are [${urls.join(", ")}], expected [${contract.files.join(", ")}]`)
	}

	if (contract.first !== undefined && urls[0] !== contract.first) {
		failures.push(`${manifest}: files[0] is ${urls[0] ?? "missing"}, expected ${contract.first} (older clients take the first entry)`)
	}

	const first = feed.files[0]

	if (first && (feed.top.get("path") !== first.url || feed.top.get("sha512") !== first.sha512)) {
		failures.push(`${manifest}: root path/sha512 do not match files[0]`)
	}

	if (contract.minimumSystemVersion !== feed.top.get("minimumSystemVersion")) {
		failures.push(
			`${manifest}: minimumSystemVersion is ${feed.top.get("minimumSystemVersion") ?? "missing"}, expected ${contract.minimumSystemVersion ?? "none"}`
		)
	}

	if (contract.adminRights) {
		for (const file of feed.files) {
			if (file.url.endsWith(".exe") && !file.isAdminRightsRequired) {
				failures.push(`${manifest}: ${file.url} lacks isAdminRightsRequired: true`)
			}
		}
	}

	for (const file of feed.files) {
		const actual = await hashFile(path.join(dir, file.url))

		if (!actual) {
			failures.push(`${manifest}: ${file.url} is not in ${dir}`)
		} else if (actual.size !== file.size || actual.sha512 !== file.sha512) {
			failures.push(`${manifest}: ${file.url} does not match its sha512/size`)
		} else {
			console.log(`${manifest}: ${file.url} OK (${actual.size} bytes)`)
		}
	}
}

for (const extra of extras[platform]) {
	if (!entries.includes(extra)) {
		failures.push(`${extra} is missing from ${dir}`)
	}
}

if (failures.length > 0) {
	for (const failure of failures) {
		console.error(`::error::${failure}`)
	}

	process.exit(1)
}

console.log(`${platform} feed OK for ${version}`)

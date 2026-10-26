import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { parseArgs } from "node:util"
import { isFeedPlatform } from "./feed.ts"

// Checks the unpacked apps electron-builder leaves in release/: the web build and tray assets made it in, and the
// app-update.yml baked into each app polls the frozen feed with no channel. With --signed, the Windows one must also
// pin the publisher, which is what makes the updater verify an update's signature.
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

import { randomBytes } from "node:crypto"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import type { DesktopDragState } from "@filen/shared/desktop"
import type { Locator } from "playwright-core"
import { errorMessage, fail, powershellBounded, psQuote, runBounded, startXvfb, waitFor } from "../../support.ts"
import type { Arch, Platform, Target } from "../../targets.ts"
import { APP_ORIGIN, clearDialogs, putOffKeysReminder, signOut } from "../app.ts"
import { dragDesktopFor, type DragDesktop } from "../dragDesktop.ts"
import { type Calibration, dropPoint, gesture, type Point, type Rect, sideBySide, toScreen } from "../dragInput.ts"
import { seedSession } from "../seed.ts"
import { diffSnapshots, localSnapshot, type Snapshot, snapshotText } from "../snapshot.ts"
import { installFrom, START_TIMEOUT_MS, tail } from "../update.ts"
import { inventory, json, openChain, pidsOf, SETUP_TIMEOUT_MS } from "./common.ts"

// Chain D (plan 2026-11-11 native transfers and drag-out, task X11): drag-out against the packaged app N, with real OS
// input. N is installed on its own (no update), seeded with the run's handed session (no login), and shown the drive
// directory the chain seeds in the cloud (rclone). The app's window and a file manager's (Explorer, Finder, Thunar
// under Xvfb) are placed side by side; every drag is the OS's own pointer (dragDesktop.ts), never the page's.
//
//   D0  installed, seeded, the fixtures listed, both windows placed, a real pointer move seen by the page (on macOS a
//       runner that grants no Accessibility is recorded and the drags are skipped, never failed)
//   D1  a file and a directory (selected together) dragged out of the window and dropped in the file manager: every
//       dropped file's sha256 is the cloud's, the tree (its empty directory too) is the cloud's; the OS drag ended
//       dropped (Linux: ended, startDrag cannot tell); on Windows the release lands under the shell's drag image (our
//       process's window) and must still count as a drop onto Explorer, not as over our own window
//   D1q the dropped files carry the download mark: com.apple.quarantine on macOS; on Windows the Zone.Identifier
//       stream is recorded only (Explorer writes those files from our streams; the plan leaves them unmarked)
//   D1t the drag's downloads are in the page's transfers feed with origin "drag", every one settled done
//   D2  Escape during the OS drag over the file manager: cancelled (Linux: ended), nothing written there
//   D3  the OS drag brought back over our own window and released: cancelled (Linux: ended), nothing written, nothing
//       uploaded (no upload transfer, the cloud directory as it was)
//   D4  an in-app drag of a file onto a directory row still moves it (the pointer engine), and prepares no drag-out
//   D5  the transfers screen lists the drag's rows
// Wayland stays a manual release-checklist row. Screens, the app's logs and each target's inventory are artifacts.

export interface DragOutOptions {
	target: Target
	platform: Platform
	arch: Arch
	nextDir: string
	nextVersion: string
	signed: boolean
	work: string
	artifacts: string
}

const NAME = "dragout"
const FILE = "alpha.bin"
const DIR = "tree"
const MOVED = "move-me.txt"
const DEST = "dest"
// The fixture tree: what D1 drags (FILE and DIR), what D4 moves (MOVED into DEST).
const FIXTURES: readonly { path: string; bytes: number | null }[] = [
	{ path: FILE, bytes: 300 * 1024 },
	{ path: `${DIR}/one.txt`, bytes: 64 },
	{ path: `${DIR}/sub/two.bin`, bytes: 1536 * 1024 },
	{ path: `${DIR}/empty`, bytes: null },
	{ path: MOVED, bytes: 32 },
	{ path: DEST, bytes: null }
]
// What a file manager may write into a directory it shows.
const JUNK = new Set([".DS_Store", "desktop.ini", "Thumbs.db"])
// After the drop: Explorer and Finder pull the bytes after the OS drag returned.
const FILES_TIMEOUT_MS = 3 * 60 * 1000
const ENDED_TIMEOUT_MS = 60_000
// How long nothing may appear after a cancelled drag.
const NOTHING_MS = 15_000
// The OS drag starts once main prepared the items (Linux: staged copies first); until then the button stays held.
const HAND_OFF_TIMEOUT_MS = { win: 0, mac: 30_000, linux: 120_000 } as const
// Windows' DoDragDrop stops main's JS, and CDP with it, so its hand-off is waited out with the button held over the
// target instead of polled.
const WINDOWS_HOLD_MS = 8000
// The app's minimum width (src/main/window.ts) in CSS px.
const APP_MIN_WIDTH = 800

// The page side: drag states, the transfers feed and the last pointer event, recorded from the window.desktop
// contract and the DOM (no secret crosses: names, ids, kinds and outcomes only).
const RECORDER = `(() => {
	if (globalThis.__filenE2eDrag) return true
	const record = { states: [], added: [], settled: [], pointer: null }
	globalThis.__filenE2eDrag = record
	window.desktop.drag.onState(state => record.states.push({ id: state.id, state: state.state, outcome: state.outcome ?? null, at: Date.now() }))
	window.desktop.transfers.onEvents(event => {
		if (event.t === "snapshot" || event.t === "added") {
			for (const t of event.transfers) record.added.push({ id: t.id, direction: t.direction, kind: t.kind, origin: t.origin, name: t.name, at: Date.now() })
		} else if (event.t === "settled") {
			record.settled.push({ id: event.id, outcome: event.outcome, code: event.error?.code ?? null, at: Date.now() })
		}
	})
	addEventListener("pointermove", event => {
		record.pointer = { screenX: event.screenX, screenY: event.screenY, clientX: event.clientX, clientY: event.clientY, buttons: event.buttons, type: event.pointerType, at: Date.now() }
	}, { capture: true, passive: true })
	return true
})()`

interface Recorded {
	states: { id: string; state: DesktopDragState["state"]; outcome: string | null; at: number }[]
	added: { id: string; direction: string; kind: string; origin: string; name: string; at: number }[]
	settled: { id: string; outcome: string; code: string | null; at: number }[]
	pointer: { screenX: number; screenY: number; clientX: number; clientY: number; buttons: number; type: string; at: number } | null
}

// The pointer engine handed the drag to the OS: its chip hidden, the drag still on (pointerDrag.ts handOff).
const HANDED_OFF = `document.body.classList.contains("pointer-drag") && [...document.body.children].some(node => node.tagName === "CANVAS" && node.style.display === "none")`

function writeFixtures(root: string): void {
	for (const fixture of FIXTURES) {
		const full = path.join(root, ...fixture.path.split("/"))

		if (fixture.bytes === null) {
			mkdirSync(full, { recursive: true })
		} else {
			mkdirSync(path.dirname(full), { recursive: true })
			writeFileSync(full, randomBytes(fixture.bytes))
		}
	}
}

// What a file manager has written below `dir` so far; its own files left out.
async function dropped(dir: string): Promise<Snapshot> {
	return localSnapshot(dir, { skip: relPath => JUNK.has(path.posix.basename(relPath)) })
}

// A page call that must not hold the chain: Windows' drag loop stalls CDP.
async function bounded<T>(what: string, run: Promise<T>, timeoutMs = 10_000): Promise<T> {
	let timer: NodeJS.Timeout | undefined

	try {
		return await Promise.race([
			run,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(`${what}: no answer in ${String(timeoutMs / 1000)} s`)), timeoutMs)
			})
		])
	} finally {
		clearTimeout(timer)
	}
}

export async function runDragOut(options: DragOutOptions): Promise<void> {
	const { target, platform, work, artifacts } = options
	const chain = await openChain(NAME, options, artifacts)
	const { findings, cloud, os, cloudDir } = chain
	const desktop: DragDesktop = dragDesktopFor(platform, work)
	const page = () => chain.page()
	const drops = path.join(work, "drops")
	const seen = new Set<string>()
	let expected: Snapshot = new Map()
	let calibration: Calibration | null = null
	let layout: { app: Rect; target: Rect } | null = null
	let shots = 0

	const shot = async (label: string) => {
		shots++
		await os.screenDump(path.join(artifacts, `${NAME}-${String(shots).padStart(2, "0")}-${label}.png`)).catch(() => undefined)
	}

	const recorded = async (): Promise<Recorded> =>
		(JSON.parse(
			String(await bounded("read the recorder", page().evaluate("JSON.stringify(globalThis.__filenE2eDrag ?? null)")))
		) as Recorded | null) ?? fail("the page has no recorder")

	const appPid = () => target.mainProcesses()[0]?.pid ?? fail("no main process of the app")

	const row = (name: string): Locator =>
		page()
			.getByRole("option")
			.filter({ has: page().getByText(name, { exact: true }) })
			.first()

	// A row's centre on the screen, in OS units.
	const rowPoint = async (name: string): Promise<Point> => {
		const box = (await row(name).boundingBox()) ?? fail(`the ${name} row has no box`)

		return toScreen(calibration ?? fail("not calibrated"), { x: box.x + Math.min(box.width / 2, 120), y: box.y + box.height / 2 })
	}

	const viewport = async (): Promise<{ width: number; height: number }> =>
		JSON.parse(String(await page().evaluate("JSON.stringify({ width: innerWidth, height: innerHeight })"))) as {
			width: number
			height: number
		}

	const toastText = async (): Promise<string> =>
		String(
			await bounded(
				"read the toasts",
				page().evaluate(
					`[...document.querySelectorAll("[data-sonner-toast]")].map(node => node.innerText.replace(/\\s+/g, " ")).join(" | ")`
				)
			).catch(errorMessage)
		)

	// A fresh empty directory in a fresh file manager window.
	const freshTarget = async (label: string): Promise<{ dir: string; rect: Rect }> => {
		const dir = path.join(drops, `filen-drop-${label}-${randomBytes(3).toString("hex")}`)

		mkdirSync(dir, { recursive: true })

		const rect = await desktop.openTarget(dir, (layout ?? fail("no layout")).target)

		await desktop.focusApp(appPid())

		return { dir, rect }
	}

	type Ending = "drop" | "escape" | "back"

	// One drag out of the window with the real pointer: press on `from`, leave the window over the file manager, wait
	// for the OS drag (or hold through it on Windows), then end it. Returns the OS drag's end as main told the page, the
	// hand-off, and on Windows what was under the pointer before the release.
	const dragOut = async (from: string, into: Rect, ending: Ending, label: string) => {
		const pid = appPid()

		await clearDialogs(page(), findings, seen)
		await desktop.focusApp(pid)

		const since = Date.now()
		const size = await viewport()
		const cal = calibration ?? fail("not calibrated")
		const box = (await row(from).boundingBox()) ?? fail(`the ${from} row has no box`)
		const start = toScreen(cal, { x: box.x + Math.min(box.width / 2, 120), y: box.y + box.height / 2 })
		// Past the window's right edge on the row's line, then over the file manager.
		const exit = toScreen(cal, { x: size.width + 12, y: box.y + box.height / 2 })
		const drop = dropPoint(into)
		const back = toScreen(cal, { x: size.width * 0.55, y: size.height - 48 })
		const windows = platform === "win"
		let handedOff: boolean | null = null
		let under = ""

		try {
			await desktop.perform(
				gesture(start)
					.at(start)
					.wait(250)
					.press()
					.wait(150)
					.glide({ x: start.x + 40, y: start.y }, 160)
					.glide(exit, 400)
					.glide(drop, 450)
					.hold(windows ? WINDOWS_HOLD_MS : 600)
					.primitives()
			)

			if (windows) {
				under = await desktop.underPointer().catch(errorMessage)
			} else {
				handedOff = await waitFor(
					"the hand-off to the OS drag",
					HAND_OFF_TIMEOUT_MS[platform],
					async () =>
						(await bounded("read the hand-off", page().evaluate(HANDED_OFF)).catch(() => false)) === true ? true : null,
					500
				).catch(() => false)
			}

			const end = gesture(drop).hold(1500)

			if (ending === "drop") {
				end.release()
			} else if (ending === "escape") {
				end.escape().wait(500).release()
			} else {
				end.glide(back, 700).hold(1500).release()
			}

			await desktop.perform(end.primitives())
		} catch (error) {
			// The button never stays down for the next step.
			await desktop.perform(gesture(drop).release().primitives()).catch(() => undefined)

			throw error
		}

		await shot(`${label}-released`)

		const ended = await waitFor(
			"the OS drag's end",
			ENDED_TIMEOUT_MS,
			async () => {
				const states = (await recorded().catch(() => null))?.states ?? []

				return states.find(state => state.state === "ended" && state.at >= since) ?? null
			},
			1000
		).catch(() => null)

		return { since, outcome: ended?.outcome ?? null, handedOff, under }
	}

	const expectOutcome = async (outcome: string | null, wanted: string, handedOff: boolean | null): Promise<string> => {
		if (outcome === null) {
			fail(
				`no OS drag ended${handedOff === false ? " (the page never handed the drag to the OS)" : ""}; toasts: ${await toastText()}`
			)
		}

		if (outcome !== wanted) {
			fail(`the OS drag ended ${outcome}, expected ${wanted}`)
		}

		return `ended ${outcome}`
	}

	const nothingIn = async (dir: string): Promise<string> => {
		await sleep(NOTHING_MS)

		const left = [...(await dropped(dir)).keys()]

		if (left.length > 0) {
			fail(`written: ${left.join(", ")}`)
		}

		return `nothing in ${path.basename(dir)} ${String(NOTHING_MS / 1000)} s later`
	}

	const xvfb = platform === "linux" ? await startXvfb() : null
	let wrapped = false

	const wrapUp = async (): Promise<void> => {
		if (wrapped) {
			return
		}

		wrapped = true
		findings.attach(`${NAME}-main.log`, tail(chain.userData("logs", "main.log"), 3000))
		findings.attach(`${NAME}-output.log`, tail(chain.appOutput, 3000))
		findings.attach(`${NAME}-drops.txt`, inventory(drops))
		await shot("last")

		for (const cleanup of [
			async () => chain.renderer?.browser.close(),
			() => desktop.stop(),
			async () => os.forceKill(pidsOf(await os.appProcesses(target))),
			async () => target.reset(),
			() => cloud.purge(cloudDir),
			async () => rmSync(drops, { recursive: true, force: true })
		]) {
			try {
				await cleanup()
			} catch (error) {
				console.log(`cleanup: ${errorMessage(error)}`)
			}
		}

		xvfb?.kill()
	}

	const budgetMinutes = Number(process.env["E2E_CHAIN_BUDGET_MINUTES"] ?? "") || 0
	const watchdog =
		budgetMinutes > 0
			? setTimeout(() => {
					void (async () => {
						console.error(`::error::${NAME}: the chain's ${String(budgetMinutes)}-minute budget ran out`)
						await findings.check(`the chain finished within its ${String(budgetMinutes)}-minute budget`, () =>
							fail("it did not")
						)
						await wrapUp().catch((error: unknown) => console.log(`cleanup: ${errorMessage(error)}`))

						try {
							findings.finish()
						} finally {
							process.exit(1)
						}
					})()
				}, budgetMinutes * 60_000)
			: undefined

	const setUp = async (): Promise<boolean> => {
		await findings.must("D0 N installed on its own", async () => {
			installFrom(target, path.join(options.nextDir, target.installer), options.nextVersion, options.signed)

			return `${target.installedVersion()} at ${target.executable}`
		})
		await findings.must(`D0 the drag desktop (${desktop.fileManager})`, () => desktop.prepare())
		await findings.must("D0 fixtures in the cloud", async () => {
			const seed = path.join(work, "dragout-seed")

			rmSync(seed, { recursive: true, force: true })
			writeFixtures(seed)
			await cloud.upload(seed, cloudDir)

			const listed = (await cloud.list(cloudDir)) ?? fail(`${cloudDir} is not in the cloud`)
			const dragged = listed.filter(entry => entry.path === FILE || entry.path === DIR || entry.path.startsWith(`${DIR}/`))

			expected = new Map()

			for (const entry of dragged) {
				expected.set(entry.path, {
					kind: entry.isDir ? "dir" : "file",
					size: entry.size,
					sha256: entry.isDir ? null : await cloud.sha256Of(`${cloudDir}/${entry.path}`),
					identity: null
				})
			}

			findings.attach(`${NAME}-expected.jsonl`, snapshotText(expected))

			return `${String(listed.length)} entries in ${cloudDir}; ${String(expected.size)} dragged, hashed through rclone`
		})

		await chain.connect()
		await findings.must("D0 signed in with the handed session (seeded, no login)", async () => {
			chain.signedIn = true

			return seedSession(page(), chain.client, START_TIMEOUT_MS)
		})
		findings.info(
			"D0 the master-key reminder after sign-in",
			await putOffKeysReminder(page(), 20_000).then(
				shown => (shown ? "shown; put off" : "not shown within 20 s"),
				(error: unknown) => `shown, not put off: ${errorMessage(error)}`
			)
		)

		await findings.must("D0 the drive directory lists the fixtures", async () => {
			const parts = cloudDir.split("/")
			const uuids: string[] = []

			for (let depth = 1; depth <= parts.length; depth++) {
				uuids.push(await cloud.dirId(parts.slice(0, depth).join("/")))
			}

			await page().goto(`${APP_ORIGIN}/drive/${uuids.join("/")}`, { timeout: 60_000 })
			await putOffKeysReminder(page(), 5000).catch(() => false)

			for (const name of [FILE, DIR, MOVED, DEST]) {
				await row(name).waitFor({ state: "visible", timeout: SETUP_TIMEOUT_MS })
			}

			await page().evaluate(RECORDER)

			return `${FILE}, ${DIR}, ${MOVED}, ${DEST} listed (${String(uuids.length)} directories deep)`
		})

		await findings.must(`D0 the app's window and ${desktop.fileManager}'s side by side`, async () => {
			const screen = await desktop.screen()
			const dpr = Number(await page().evaluate("devicePixelRatio"))
			const scale = desktop.pixels ? dpr : 1
			const planned =
				sideBySide(screen, Math.ceil(APP_MIN_WIDTH * scale), desktop.insets) ?? fail(`the screen ${json(screen)} is too narrow`)
			const app = await desktop.placeApp(appPid(), planned.app)

			layout = { app, target: planned.target }

			return `screen ${json(screen)}, devicePixelRatio ${String(dpr)}; app at ${json(app)}, ${desktop.fileManager} planned at ${json(planned.target)}`
		})

		const blocked = await desktop.inputBlocked()

		// The page must see the real pointer: its event's screen and client positions place the page on the screen.
		const calibrate = async (): Promise<string> => {
			const app = (layout ?? fail("no layout")).app
			const centre = { x: app.x + Math.round(app.width / 2), y: app.y + Math.round(app.height / 2) }
			const dpr = Number(await page().evaluate("devicePixelRatio"))
			const uncovered = await desktop.uncover(appPid(), centre)

			await desktop.focusApp(appPid())
			await page().evaluate("globalThis.__filenE2eDrag.pointer = null")
			await desktop.perform(
				gesture(centre)
					.at(centre)
					.wait(100)
					.glide({ x: centre.x + 6, y: centre.y + 4 }, 100)
					.wait(300)
					.primitives()
			)

			const pointer =
				(await recorded()).pointer ??
				fail(`no pointermove reached the page; under the pointer: ${await desktop.underPointer().catch(errorMessage)}`)
			const scale = desktop.pixels ? dpr : 1
			const landed = { x: Math.round(pointer.screenX * scale), y: Math.round(pointer.screenY * scale) }
			const sent = { x: centre.x + 6, y: centre.y + 4 }

			// The event must be where the helper put the pointer, else every later press lands elsewhere.
			if (Math.abs(landed.x - sent.x) > 3 || Math.abs(landed.y - sent.y) > 3) {
				fail(`the page saw the pointer at ${json(landed)} OS units; it was sent to ${json(sent)}`)
			}

			calibration = {
				offset: { x: pointer.screenX - pointer.clientX, y: pointer.screenY - pointer.clientY },
				scale
			}

			return `${pointer.type} at client ${String(pointer.clientX)},${String(pointer.clientY)}, screen ${String(pointer.screenX)},${String(pointer.screenY)}; offset ${json(calibration.offset)}, ${String(calibration.scale)} OS units per CSS px${uncovered === null ? "" : `; ${uncovered}`}${blocked === null ? "" : `; the system reported ${blocked}`}`
		}
		const reaches = "D0 a real pointer move reaches the page"
		const calibrated = await calibrate().then(
			detail => ({ detail, error: null }),
			(error: unknown) => ({ detail: "", error: errorMessage(error) })
		)

		if (calibrated.error === null) {
			await findings.check(reaches, () => calibrated.detail)
		} else if (platform === "mac" && blocked !== null) {
			// A hosted runner that grants no Accessibility: recorded, the drags skipped (not a failure of the app).
			findings.info(reaches, `not on this runner: ${blocked} (${calibrated.error}); D1-D4 not run`)

			return false
		} else {
			await findings.must(reaches, () => fail(calibrated.error))
		}

		await shot("placed")

		return true
	}

	const dropFileAndDirectory = async (): Promise<void> => {
		const { dir, rect } = await freshTarget("d1")

		await findings.must(`D1 ${FILE} and ${DIR} selected together`, async () => {
			await row(FILE).click({ timeout: 30_000 })
			await row(DIR).click({ modifiers: ["ControlOrMeta"], timeout: 30_000 })

			const selected = await page().locator('[role="option"][aria-selected="true"]').count()

			if (selected !== 2) {
				fail(`${String(selected)} rows selected`)
			}

			return `${desktop.fileManager} at ${json(rect)}`
		})

		const drag = await dragOut(DIR, rect, "drop", "d1")

		findings.attach(`${NAME}-d1-recorded.json`, JSON.stringify(await recorded().catch(() => null), null, "\t"))
		await findings.check(`D1 the OS drag dropped onto ${desktop.fileManager}`, () =>
			expectOutcome(drag.outcome, platform === "linux" ? "ended" : "dropped", drag.handedOff)
		)

		if (platform === "win") {
			await findings.check(
				"D1w the release under the shell's drag image counts as a drop onto Explorer, not as over our window",
				() => {
					if (drag.outcome !== "dropped") {
						fail(`ended ${String(drag.outcome)}; under the pointer before the release: ${drag.under}`)
					}

					return `dropped; under the pointer before the release: ${drag.under}`
				}
			)
		}

		await findings.check(`D1 the dropped file and directory are the cloud's, byte for byte (sha256)`, async () => {
			let differences: string[] = []

			await waitFor(
				"the dropped tree",
				FILES_TIMEOUT_MS,
				async () => {
					differences = diffSnapshots(expected, await dropped(dir), { identity: false })

					return differences.length === 0 ? true : null
				},
				2000
			).catch(() => fail(differences.join("; ")))

			return `${String(expected.size)} entries in ${path.basename(dir)}, every file's sha256 the cloud's, ${DIR}/empty present`
		})
		findings.attach(`${NAME}-d1-dropped.jsonl`, snapshotText(await dropped(dir)))
		await shot("d1-dropped")

		const files = [...expected].filter(([, node]) => node.kind === "file").map(([relPath]) => path.join(dir, ...relPath.split("/")))

		if (platform === "mac") {
			await findings.check("D1q every dropped file carries com.apple.quarantine", async () => {
				const missing: string[] = []

				for (const file of files) {
					const result = await runBounded("xattr", ["-p", "com.apple.quarantine", file], 30_000)

					if (result.status !== 0) {
						missing.push(path.relative(dir, file))
					}
				}

				if (missing.length > 0) {
					fail(`no quarantine on ${missing.join(", ")}`)
				}

				return `${String(files.length)} files quarantined`
			})
		} else if (platform === "win") {
			const result = await powershellBounded(
				files
					.map(
						file =>
							`$z = Get-Content -LiteralPath ${psQuote(file)} -Stream Zone.Identifier -ErrorAction SilentlyContinue; "${path.relative(dir, file).replaceAll("\\", "/")}: $(if ($z) { ($z -join ' ') } else { 'none' })"`
					)
					.join("\n"),
				60_000
			)

			findings.info(
				"D1q Zone.Identifier on the files Explorer wrote (information: Explorer writes them from our streams)",
				result.status === 0 ? result.stdout.trim().replace(/\r?\n/g, "; ") : `not read: ${result.stderr.trim().slice(-300)}`
			)
		} else {
			findings.info("D1q download mark", "none on Linux")
		}

		await findings.check(`D1t the drag's downloads are in the transfers feed with origin "drag", each settled done`, async () => {
			const record = await recorded()
			const transfers = record.added.filter(item => item.origin === "drag" && item.at >= drag.since)
			// A row may name an entry by its path in the drag (Explorer asks for each file of the tree).
			const names = new Set(transfers.map(item => path.posix.basename(item.name.replaceAll("\\", "/"))))

			if (transfers.length === 0) {
				fail("no drag transfer was added")
			}

			// A transfer settles a moment after its last bytes are on disk.
			const open = (settled: Recorded["settled"]) =>
				transfers.filter(item => !settled.some(entry => entry.id === item.id && entry.outcome === "done"))
			const settled = await waitFor(
				"the drag transfers to settle",
				30_000,
				async () => {
					const now = (await recorded()).settled

					return open(now).length === 0 ? now : null
				},
				1000
			).catch(() => record.settled)
			const unsettled = open(settled)

			if (!names.has(FILE) || !(names.has(DIR) || (names.has("one.txt") && names.has("two.bin")))) {
				fail(`the drag transfers are ${[...names].join(", ")}`)
			}

			if (unsettled.length > 0) {
				fail(
					`not settled done: ${unsettled.map(item => `${item.name} ${json(settled.filter(entry => entry.id === item.id))}`).join(", ")}`
				)
			}

			return `${String(transfers.length)} drag transfers (${[...names].join(", ")}), every one done`
		})
		await desktop.closeTarget()
	}

	const cancelled = async (ending: "escape" | "back"): Promise<void> => {
		const label = ending === "escape" ? "d2" : "d3"
		const { dir, rect } = await freshTarget(label)
		const before = (await cloud.list(cloudDir)) ?? []
		const drag = await dragOut(FILE, rect, ending, label)
		const wanted = platform === "linux" ? "ended" : "cancelled"

		if (ending === "escape") {
			await findings.check(`D2 Escape during the OS drag over ${desktop.fileManager} cancels it and writes nothing`, async () => {
				const outcome = await expectOutcome(drag.outcome, wanted, drag.handedOff)

				return `${outcome}; ${await nothingIn(dir)}`
			})
		} else {
			await findings.check(
				"D3 the OS drag released back over our own window is ignored: nothing written, nothing uploaded",
				async () => {
					const outcome = await expectOutcome(drag.outcome, wanted, drag.handedOff)
					const nothing = await nothingIn(dir)
					const uploads = (await recorded()).added.filter(item => item.direction === "upload" && item.at >= drag.since)
					const after = (await cloud.list(cloudDir)) ?? []
					const key = (entries: typeof before) =>
						entries
							.map(entry => `${entry.path} ${entry.id}`)
							.sort()
							.join("\n")

					if (uploads.length > 0) {
						fail(`uploads started: ${uploads.map(item => item.name).join(", ")}`)
					}

					if (key(before) !== key(after)) {
						fail(`the cloud directory changed: ${after.map(entry => entry.path).join(", ")}`)
					}

					return `${outcome}; ${nothing}; no upload; the cloud directory as it was (${String(after.length)} entries)`
				}
			)
		}

		await shot(`${label}-after`)
		await desktop.closeTarget()
	}

	const moveInApp = async (): Promise<void> => {
		await findings.check(`D4 an in-app drag moves ${MOVED} into ${DEST}, preparing no drag-out`, async () => {
			await clearDialogs(page(), findings, seen)
			await desktop.focusApp(appPid())

			const since = Date.now()
			const from = await rowPoint(MOVED)
			const onto = await rowPoint(DEST)

			try {
				await desktop.perform(
					gesture(from)
						.at(from)
						.wait(250)
						.press()
						.wait(150)
						.glide({ x: from.x + 30, y: from.y }, 160)
						.glide(onto, 500)
						.hold(300)
						.release()
						.primitives()
				)
			} catch (error) {
				await desktop.perform(gesture(onto).release().primitives()).catch(() => undefined)

				throw error
			}

			await waitFor(
				`${MOVED} in ${DEST} in the cloud`,
				90_000,
				async () => {
					const listed = (await cloud.list(cloudDir)) ?? []

					return listed.some(entry => entry.path === `${DEST}/${MOVED}`) && !listed.some(entry => entry.path === MOVED)
						? true
						: null
				},
				3000
			)

			const prepared = (await recorded()).states.filter(state => state.at >= since)

			if (prepared.length > 0) {
				fail(`the in-app drag prepared a drag-out: ${json(prepared)}`)
			}

			return `${DEST}/${MOVED} in the cloud, ${MOVED} gone from the top; no drag state`
		})
		await shot("d4-moved")
	}

	const transfersScreen = async (): Promise<void> => {
		await findings.check("D5 the transfers screen lists the drag's rows", async () => {
			// In-app navigation: main drops a row once it settled, so only this page's store still holds the finished
			// drag rows; a reload (goto) would show an empty list.
			await clearDialogs(page(), findings, seen)
			await page().locator('a[href="/transfers"]').first().click({ timeout: 30_000 })

			const rows = page().locator("[data-transfer-id]")

			await rows.first().waitFor({ state: "visible", timeout: 60_000 })

			const names = JSON.parse(
				String(
					await page().evaluate(
						`JSON.stringify([...document.querySelectorAll("[data-transfer-id]")].map(node => node.getAttribute("aria-label") ?? ""))`
					)
				)
			) as string[]

			await page()
				.screenshot({ path: path.join(artifacts, `${NAME}-transfers.png`) })
				.catch(() => undefined)

			if (!names.includes(FILE)) {
				fail(`the rows are ${names.join(", ")}`)
			}

			return `${String(names.length)} rows: ${names.join(", ")}`
		})
	}

	try {
		if (platform === "linux") {
			findings.info("D Wayland", "GNOME and KDE Wayland stay manual release-checklist rows; this run is X11 under Xvfb")
		}

		await chain.signedOutOnFailure(async () => {
			if (await setUp()) {
				await dropFileAndDirectory()
				await cancelled("escape")
				await cancelled("back")
				await moveInApp()
				await transfersScreen()
			}
		})

		await findings.check("D sign out", () => signOut(page(), findings, chain.credentials.email, artifacts, NAME))
		await chain.quit("the app")
	} catch (error) {
		await findings.check("the chain ran to the end", () => fail(errorMessage(error)))
	} finally {
		clearTimeout(watchdog)
		await wrapUp()
	}

	findings.finish()
}

import { existsSync, mkdirSync, rmSync, statfsSync, writeFileSync } from "node:fs"
import { userInfo } from "node:os"
import path from "node:path"
import { fail, powershellBounded, runBounded, type BoundedResult } from "../support.ts"
import type { Platform } from "../targets.ts"

// A small volume of its own for the local-disk-full check (chains/diskFullCheck.ts), so filling it fills nothing else:
// Linux a tmpfs mounted with sudo, macOS an APFS volume with a quota in the boot disk's container (diskutil apfs
// addVolume -quota: no disk image, nothing partitioned, the container's other volumes untouched), Windows a VHDX
// attached and formatted by diskpart. remove() takes it away again and is safe to call twice or after a failed create.
// Every tool runs bounded.

export const SMALL_VOLUME_MIB = 64
const TOOL_TIMEOUT_MS = 2 * 60 * 1000
const LINUX_POINT = "/mnt/filen-e2e-small"
const MAC_NAME = "FilenE2ESmall"
const WINDOWS_VHD = "C:\\filen-e2e-small.vhdx"

export interface SmallVolume {
	// Where it is mounted: a directory, or a drive letter's root.
	readonly root: string
	readonly description: string
	// Bytes a user may still write there.
	free(): number
	// Whether it is still mounted.
	mounted(): Promise<boolean>
	remove(): Promise<string>
}

function output(result: BoundedResult): string {
	const status = result.timedOut ? "timed out" : `exit ${String(result.status)}`

	return `${status} ${result.stdout.trim()} ${result.stderr.trim()}`.trim()
}

async function must(command: string, args: readonly string[]): Promise<string> {
	const result = await runBounded(command, args, TOOL_TIMEOUT_MS)

	if (result.status !== 0) {
		fail(`${command} ${args.join(" ")}: ${output(result)}`)
	}

	return result.stdout
}

export function freeBytes(root: string): number {
	const stat = statfsSync(root)

	return stat.bavail * stat.bsize
}

// The APFS container (diskN) of the boot volume, from `diskutil info -plist /`.
export function apfsContainerOf(plist: string): string | null {
	return /<key>APFSContainerReference<\/key>\s*<string>(disk\d+)<\/string>/.exec(plist)?.[1] ?? null
}

// The volume diskutil apfs addVolume created ("Disk from APFS operation: disk3s7").
export function addedVolumeOf(output: string): string | null {
	return /Disk from APFS operation:\s*(disk\d+s\d+)/.exec(output)?.[1] ?? null
}

// A drive letter no volume uses, from the end of the alphabet; null when every one is taken.
export function freeDriveLetter(used: readonly string[]): string | null {
	const taken = new Set(used.map(letter => letter.trim().slice(0, 1).toUpperCase()))

	return [..."RSTUVWXYQPONMLKJIHGFED"].find(letter => !taken.has(letter)) ?? null
}

export function diskpartCreate(vhd: string, sizeMiB: number, letter: string): string {
	return [
		`create vdisk file="${vhd}" maximum=${String(sizeMiB)} type=expandable`,
		`select vdisk file="${vhd}"`,
		"attach vdisk",
		"convert mbr",
		"create partition primary",
		"format fs=ntfs quick label=FilenE2E",
		`assign letter=${letter}`,
		""
	].join("\r\n")
}

export function diskpartRemove(vhd: string): string {
	return [`select vdisk file="${vhd}"`, "detach vdisk", ""].join("\r\n")
}

async function linuxVolume(sizeMiB: number): Promise<SmallVolume> {
	const { uid, gid } = userInfo()
	const mounted = async () =>
		(await runBounded("findmnt", ["--noheadings", "--mountpoint", LINUX_POINT], TOOL_TIMEOUT_MS)).stdout.trim() !== ""

	await must("sudo", ["mkdir", "-p", LINUX_POINT])
	await must("sudo", [
		"mount",
		"-t",
		"tmpfs",
		"-o",
		`size=${String(sizeMiB)}m,uid=${String(uid)},gid=${String(gid)},mode=0700`,
		"filen-e2e-small",
		LINUX_POINT
	])

	return {
		root: LINUX_POINT,
		description: `tmpfs of ${String(sizeMiB)} MiB at ${LINUX_POINT}`,
		free: () => freeBytes(LINUX_POINT),
		mounted,
		async remove() {
			if (await mounted()) {
				// A process still holding a file there (the app's watcher) keeps a plain unmount busy; lazy detaches it.
				const plain = await runBounded("sudo", ["umount", LINUX_POINT], TOOL_TIMEOUT_MS)

				if (plain.status !== 0) {
					await must("sudo", ["umount", "--lazy", LINUX_POINT])
				}
			}

			await runBounded("sudo", ["rmdir", LINUX_POINT], TOOL_TIMEOUT_MS)

			return `${LINUX_POINT} unmounted`
		}
	}
}

async function macVolume(sizeMiB: number): Promise<SmallVolume> {
	const container = apfsContainerOf(await must("diskutil", ["info", "-plist", "/"])) ?? fail("no APFS container for /")
	const added = await must("sudo", ["diskutil", "apfs", "addVolume", container, "APFS", MAC_NAME, "-quota", `${String(sizeMiB)}m`])
	const device = addedVolumeOf(added) ?? fail(`diskutil apfs addVolume named no volume: ${added.trim()}`)
	const root = `/Volumes/${MAC_NAME}`
	const mounted = async () => (await runBounded("mount", [], TOOL_TIMEOUT_MS)).stdout.includes(` on ${root} (`)

	try {
		await must("sudo", ["chown", userInfo().username, root])
		// Spotlight would index (and write to) the volume while the check fills it.
		await runBounded("sudo", ["mdutil", "-i", "off", root], TOOL_TIMEOUT_MS)
	} catch (error) {
		await runBounded("sudo", ["diskutil", "apfs", "deleteVolume", device], TOOL_TIMEOUT_MS)

		throw error
	}

	return {
		root,
		description: `APFS volume ${device} in ${container} with a ${String(sizeMiB)} MiB quota at ${root}`,
		free: () => freeBytes(root),
		mounted,
		async remove() {
			if (await mounted()) {
				await runBounded("sudo", ["diskutil", "unmount", "force", root], TOOL_TIMEOUT_MS)
			}

			await must("sudo", ["diskutil", "apfs", "deleteVolume", device])

			return `${device} deleted`
		}
	}
}

async function windowsVolume(sizeMiB: number, work: string): Promise<SmallVolume> {
	const used = await powershellBounded("[IO.DriveInfo]::GetDrives() | ForEach-Object { $_.Name }", TOOL_TIMEOUT_MS)
	const letter = freeDriveLetter(used.stdout.split(/\r?\n/).filter(line => line.trim() !== "")) ?? fail("no free drive letter")
	const root = `${letter}:\\`
	const diskpart = async (name: string, script: string): Promise<BoundedResult> => {
		const file = path.join(work, `diskpart-${name}.txt`)

		mkdirSync(work, { recursive: true })
		writeFileSync(file, script)

		return runBounded("diskpart.exe", ["/s", file], TOOL_TIMEOUT_MS)
	}
	const mounted = async () => existsSync(root)
	const remove = async (): Promise<string> => {
		if (existsSync(WINDOWS_VHD)) {
			const detached = await diskpart("remove", diskpartRemove(WINDOWS_VHD))

			rmSync(WINDOWS_VHD, { force: true })

			if (existsSync(WINDOWS_VHD)) {
				fail(`${WINDOWS_VHD} not deleted (detach: ${output(detached)})`)
			}
		}

		return `${WINDOWS_VHD} detached and deleted`
	}

	// A VHDX a crashed run left behind would refuse `create vdisk`.
	await remove()

	const created = await diskpart("create", diskpartCreate(WINDOWS_VHD, sizeMiB, letter))

	if (created.status !== 0 || !existsSync(root)) {
		await remove().catch(() => undefined)
		fail(`diskpart: ${output(created)}`)
	}

	return {
		root,
		description: `VHDX ${WINDOWS_VHD} of ${String(sizeMiB)} MiB, NTFS at ${root}`,
		free: () => freeBytes(root),
		mounted,
		remove
	}
}

export async function createSmallVolume(platform: Platform, work: string, sizeMiB = SMALL_VOLUME_MIB): Promise<SmallVolume> {
	switch (platform) {
		case "linux":
			return linuxVolume(sizeMiB)
		case "mac":
			return macVolume(sizeMiB)
		case "win":
			return windowsVolume(sizeMiB, work)
	}
}

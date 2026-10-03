import type { CompressFormat } from "@filen/sdk-rs"
import { sdkApi } from "@/lib/sdk/client"
import type { ArchiveFormatInfo, ArchiveNameInfo } from "@/workers/sdk.worker"

// The SDK's archive helpers need wasm, which only the worker loads: each is a worker call, so their
// answers are kept here. Calls made in one tick (a menu or dialog asking about every format or name at
// once) go over as one call.

// Resolves each input of one tick's batch from a single call.
function microBatched<I, O>(call: (inputs: I[]) => Promise<O[]>): (input: I) => Promise<O> {
	let pending: { input: I; resolve: (output: O) => void; reject: (reason: unknown) => void }[] = []

	const flush = (): void => {
		const batch = pending

		pending = []

		void call(batch.map(entry => entry.input)).then(
			outputs => {
				for (const [index, entry] of batch.entries()) {
					const output = outputs[index]

					if (output === undefined) {
						entry.reject(new Error("archive helper answered fewer inputs than it was asked"))
					} else {
						entry.resolve(output)
					}
				}
			},
			(reason: unknown) => {
				for (const entry of batch) {
					entry.reject(reason)
				}
			}
		)
	}

	return input =>
		new Promise<O>((resolve, reject) => {
			if (pending.length === 0) {
				queueMicrotask(flush)
			}

			pending.push({ input, resolve, reject })
		})
}

let budget: Promise<number> | undefined

// The client reads its budget once, at load, so one answer holds for the page.
export function archiveCodecMemBudget(): Promise<number> {
	if (budget !== undefined) {
		return budget
	}

	const asked = sdkApi.archiveCodecMemBudget()

	budget = asked

	asked.catch(() => {
		if (budget === asked) {
			budget = undefined
		}
	})

	return asked
}

function keyPart(value: string | number | undefined): string {
	return value === undefined ? "" : String(value)
}

// Every field in a fixed order, so two equal formats built in another key order share an entry.
export function compressFormatKey(format: CompressFormat): string {
	switch (format.type) {
		case "tar":
			return `tar:${keyPart(format.compression?.codec)}:${keyPart(format.compression?.level)}`
		case "single":
			return `single:${format.compression.codec}:${keyPart(format.compression.level)}`
		case "zip":
			return `zip:${format.method.type}:${keyPart("level" in format.method ? format.method.level : undefined)}:${keyPart(format.encryption)}`
		case "sevenZ":
			return `7z:${format.method.type}:${keyPart("level" in format.method ? format.method.level : undefined)}:${format.solid ? "solid" : ""}:${keyPart(format.encryption)}`
	}
}

const askFormatInfo = microBatched((formats: CompressFormat[]) => sdkApi.archiveFormatInfo(formats))
// A handful of formats and levels in all: kept for the page.
const formatInfos = new Map<string, Promise<ArchiveFormatInfo>>()

export function archiveFormatInfo(format: CompressFormat): Promise<ArchiveFormatInfo> {
	const key = compressFormatKey(format)
	const known = formatInfos.get(key)

	if (known !== undefined) {
		return known
	}

	const asked = askFormatInfo(format)

	formatInfos.set(key, asked)

	asked.catch(() => {
		if (formatInfos.get(key) === asked) {
			formatInfos.delete(key)
		}
	})

	return asked
}

export function archiveFormatInfos(formats: readonly CompressFormat[]): Promise<ArchiveFormatInfo[]> {
	return Promise.all(formats.map(archiveFormatInfo))
}

const askNameInfo = microBatched((names: string[]) => sdkApi.archiveNameInfo(names))
// File names are unbounded, so only the most recent are kept.
const NAME_INFO_CAP = 512
const nameInfos = new Map<string, ArchiveNameInfo>()
const askedNames = new Map<string, Promise<ArchiveNameInfo>>()

function rememberNameInfo(name: string, info: ArchiveNameInfo): void {
	nameInfos.delete(name)
	nameInfos.set(name, info)

	if (nameInfos.size > NAME_INFO_CAP) {
		const oldest = nameInfos.keys().next()

		if (oldest.done !== true) {
			nameInfos.delete(oldest.value)
		}
	}
}

// For a menu opened again: what an earlier ask already answered, without waiting a tick.
export function cachedArchiveNameInfo(name: string): ArchiveNameInfo | undefined {
	const info = nameInfos.get(name)

	if (info !== undefined) {
		rememberNameInfo(name, info)
	}

	return info
}

export function archiveNameInfo(name: string): Promise<ArchiveNameInfo> {
	const known = cachedArchiveNameInfo(name)

	if (known !== undefined) {
		return Promise.resolve(known)
	}

	const pending = askedNames.get(name)

	if (pending !== undefined) {
		return pending
	}

	const asked = askNameInfo(name).then(info => {
		rememberNameInfo(name, info)

		return info
	})

	askedNames.set(name, asked)

	asked
		.finally(() => {
			askedNames.delete(name)
		})
		.catch(() => undefined)

	return asked
}

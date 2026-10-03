import type { CompressFormat } from "@filen/sdk-rs"
import { sdkApi } from "@/lib/sdk/client"
import type { ArchiveFormatInfo } from "@/workers/sdk.worker"

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

// File names are unbounded, so only the most recent answers are kept.
const NAME_ANSWER_CAP = 512

interface NameMemo<O> {
	// What an earlier ask already answered, without waiting a tick.
	cached: (name: string) => O | undefined
	ask: (name: string) => Promise<O>
}

// One name answer per name, asked once while in flight and remembered after.
function nameMemo<O>(call: (names: string[]) => Promise<O[]>): NameMemo<O> {
	const askBatched = microBatched(call)
	// Boxed, since an answer may itself be null.
	const answers = new Map<string, { answer: O }>()
	const asked = new Map<string, Promise<O>>()

	function remember(name: string, box: { answer: O }): void {
		answers.delete(name)
		answers.set(name, box)

		if (answers.size > NAME_ANSWER_CAP) {
			const oldest = answers.keys().next()

			if (oldest.done !== true) {
				answers.delete(oldest.value)
			}
		}
	}

	function known(name: string): { answer: O } | undefined {
		const box = answers.get(name)

		if (box !== undefined) {
			remember(name, box)
		}

		return box
	}

	function ask(name: string): Promise<O> {
		const box = known(name)

		if (box !== undefined) {
			return Promise.resolve(box.answer)
		}

		const pending = asked.get(name)

		if (pending !== undefined) {
			return pending
		}

		const asking = askBatched(name).then(answer => {
			remember(name, { answer })

			return answer
		})

		asked.set(name, asking)

		asking
			.finally(() => {
				asked.delete(name)
			})
			.catch(() => undefined)

		return asking
	}

	return { cached: name => known(name)?.answer, ask }
}

const nameInfos = nameMemo((names: string[]) => sdkApi.archiveNameInfo(names))

// For a menu opened again: answered at once when an earlier ask already did.
export const cachedArchiveNameInfo = nameInfos.cached
export const archiveNameInfo = nameInfos.ask

const nameErrors = nameMemo((names: string[]) => sdkApi.itemNameErrors(names))

// Why the SDK refuses `name` for an item, null when it takes it: the SDK's own rules, asked rather
// than copied.
export const cachedItemNameError = nameErrors.cached
export const itemNameError = nameErrors.ask

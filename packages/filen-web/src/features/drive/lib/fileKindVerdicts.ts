import { boundedVerdicts, VERDICT_MAX_RECORDS, type ContentVerdict, type FileVerdict, type StoredVerdict } from "@filen/shared"
import { createListenerSet } from "@/lib/listenerSet"
import { log } from "@/lib/log"

// What reads of a file's content already said about its kind (resolveFileKind's verdict): a `.ts` that is a
// transport stream, a `.webm` holding audio alone. Written only by reads that happen anyway (a preview's or
// thumbnail's probe), never by a read made to classify, and kept only where it changes what the file
// resolves to (contentVerdicts.ts). Per file uuid (a content change rotates it), the newest
// VERDICT_MAX_RECORDS kept. Read synchronously from memory; the page attaches kv at boot
// (fileKindVerdictStorage.ts), which fills it once and keeps every write. The SDK worker classifies with
// this module too and never attaches: it holds no verdicts. Components read a file's verdict through
// useFileKindVerdict (hooks/useFileKindVerdict.ts) so they follow it.

export interface FileKindVerdictStorage {
	load: () => Promise<(readonly [string, StoredVerdict])[]>
	save: (uuid: string, value: StoredVerdict) => Promise<void>
	remove: (uuid: string) => Promise<void>
}

// A verdict as memory holds it: a document verdict (a `.dot` read as a Word template or not, a `.pot` as a
// PowerPoint one or not) as well as the media ones kv keeps.
interface HeldVerdict {
	v: FileVerdict
	at: number
}

function isContentVerdict(verdict: FileVerdict): verdict is ContentVerdict {
	switch (verdict) {
		case "wordBinary":
		case "notWordBinary":
		case "presentationBinary":
		case "notPresentationBinary":
			return false
		default:
			return true
	}
}

// Most recently written last.
const verdicts = new Map<string, HeldVerdict>()
// Held in memory only (a public link's file, read without a session): nothing of it reaches kv.
const unsaved = new Set<string>()
// Each change names the files it concerns; null for any (a load, a reset).
const changes = createListenerSet<readonly string[] | null>("file-kind-verdicts")
let storage: FileKindVerdictStorage | null = null
let epoch = 0

function changed(uuids: readonly string[] | null): void {
	changes.emit(uuids)
}

function persist(write: (storage: FileKindVerdictStorage) => Promise<void>): void {
	if (storage !== null) {
		write(storage).catch((error: unknown) => {
			log.warn("file-kind", "verdict not saved", error)
		})
	}
}

// Fills memory from `target` once, merged with what this session already wrote, and keeps every later write.
export function attachFileKindVerdictStorage(target: FileKindVerdictStorage): void {
	if (storage !== null) {
		return
	}

	storage = target

	const started = epoch

	target
		.load()
		.then(entries => {
			if (started !== epoch) {
				return
			}

			const { keep, drop } = boundedVerdicts(entries, [...verdicts.entries()], VERDICT_MAX_RECORDS)

			verdicts.clear()

			for (const [uuid, value] of keep) {
				verdicts.set(uuid, value)
			}

			for (const uuid of drop) {
				if (!unsaved.delete(uuid)) {
					persist(kv => kv.remove(uuid))
				}
			}

			if (keep.length > 0) {
				changed(null)
			}
		})
		.catch((error: unknown) => {
			log.warn("file-kind", "verdicts not read", error)
		})
}

export function fileKindVerdict(uuid: string): FileVerdict | undefined {
	return verdicts.get(uuid)?.v
}

// `memoryOnly` keeps the verdict for this session alone: what an anonymous visitor's reads said is never left
// in kv for whoever signs in on the browser next. A later persistent record of the same verdict saves it. Document
// verdicts stay in memory: the viewer that reads a `.dot` reads it anyway, so a later session tells again.
export function recordFileKindVerdict(uuid: string, verdict: FileVerdict, options: { memoryOnly?: boolean } = {}): void {
	const at = Date.now()
	// What kv may keep: a media verdict not asked to stay in memory.
	const stored: StoredVerdict | undefined = options.memoryOnly !== true && isContentVerdict(verdict) ? { v: verdict, at } : undefined

	if (verdicts.get(uuid)?.v === verdict && (stored === undefined || !unsaved.has(uuid))) {
		return
	}

	verdicts.delete(uuid)
	verdicts.set(uuid, { v: verdict, at })

	if (stored === undefined) {
		unsaved.add(uuid)
	} else {
		unsaved.delete(uuid)
		persist(kv => kv.save(uuid, stored))
	}

	const oldest = verdicts.size > VERDICT_MAX_RECORDS ? verdicts.keys().next().value : undefined

	if (oldest !== undefined) {
		verdicts.delete(oldest)

		if (!unsaved.delete(oldest)) {
			persist(kv => kv.remove(oldest))
		}
	}

	changed(oldest === undefined ? [uuid] : [uuid, oldest])
}

export function subscribeFileKindVerdicts(listener: (uuids: readonly string[] | null) => void): () => void {
	return changes.subscribe(listener)
}

// The files holding `verdict`, at most VERDICT_MAX_RECORDS.
export function filesWithVerdict(verdict: FileVerdict): string[] {
	const uuids: string[] = []

	for (const [uuid, value] of verdicts) {
		if (value.v === verdict) {
			uuids.push(uuid)
		}
	}

	return uuids
}

// Logout: the kv rows go with the kv wipe; this forgets what memory holds. Storage stays attached.
export function resetFileKindVerdicts(): void {
	epoch++
	verdicts.clear()
	unsaved.clear()
	changed(null)
}

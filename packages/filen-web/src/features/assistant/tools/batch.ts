import { DRIVE_NAME_RULES, driveItemName, estimateCaptureTimestamp } from "@filen/shared"
import {
	batchOrganizeCount,
	planBatchRename,
	planOrganizeByDate,
	type BatchDateField,
	type BatchItem,
	type BatchOrganizeBy,
	type BatchOrganizePlan,
	type BatchRenamePlan,
	type BatchRenameScheme,
	type BatchSkip
} from "@filen/shared/assistant"
import type { BulkOutcome } from "@/lib/actions/bulk"
import { runBulkActivity } from "@/lib/activity/activity"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { asDirectoryOrFile, isDirectoryItem, lastModifiedOf, type DriveItem } from "@/features/drive/lib/item"
import { createDirectory, moveItems, renameItems } from "@/features/drive/lib/actions"
import { driveActivity, DRIVE_RENAME, DRIVE_SORT_BY_DATE } from "@/features/drive/lib/activity"
import { takenNamesInDirectory } from "@/features/drive/lib/nameTaken"
import { findOwnedListingItem } from "@/features/drive/queries/drive"
import { matchesKind } from "@/features/assistant/tools/drive"
import {
	driveName,
	optionalString,
	readDriveListing,
	requiredString,
	rootDirUuid,
	type ToolAdapter,
	type ToolScope
} from "@/features/assistant/tools/entities"
import { AssistantToolError, throwIfStopped } from "@/features/assistant/tools/format"
import { destinationOf, destinationPath, driveItemsOf, handleList, type Destination } from "@/features/assistant/tools/writes"
import type { AssistantBatchPlan } from "@/features/assistant/types"

// rename_by_pattern and organize_by_date: the model picks a scheme and a scope, @filen/shared's planner works out
// every name and destination from the listings the app holds, and the card lists the plan. The plan is kept from the
// check to the run (one at a time), so what the user confirmed is what runs; files that changed meanwhile are
// skipped, never renamed or moved by a stale plan.

type BatchTool = "rename_by_pattern" | "organize_by_date"

const DATE_SCHEMES: ReadonlySet<string> = new Set(["date_prefix", "date_name"])
const TEXT_SCHEMES: ReadonlySet<string> = new Set(["number", "add_prefix", "add_suffix", "replace_text"])

interface PlanBase {
	key: string
	// Every file of the plan, by uuid, as it was when planned.
	items: ReadonlyMap<string, DriveItem>
	// Files the plan leaves as they are, and why.
	skipped: BatchSkip[]
}

interface RenamePlan extends PlanBase {
	tool: "rename_by_pattern"
	plan: BatchRenamePlan
}

interface OrganizePlan extends PlanBase {
	tool: "organize_by_date"
	// The directory sorted (the toast and the result name it).
	scope: Destination
	plan: BatchOrganizePlan
}

type Plan = RenamePlan | OrganizePlan

let held: Plan | null = null

// A new conversation: its cards are gone, and so is their plan.
export function clearBatchPlan(): void {
	held = null
}

function planKey(tool: BatchTool, args: Record<string, unknown>): string {
	return `${tool}:${JSON.stringify(args)}`
}

function listingUuid(uuid: string | null): string | null {
	return uuid === rootDirUuid() ? null : uuid
}

function instant(value: bigint | number | undefined): number | undefined {
	return value === undefined ? undefined : Number(value)
}

// A file as the planner sees it: a photo's or video's capture date as the Photos timeline estimates it.
function batchItem(item: DriveItem): BatchItem {
	const meta = asDirectoryOrFile(item).data.decryptedMeta
	const uploaded = Number(item.data.timestamp)
	const created = instant(meta?.created ?? undefined)
	const media = !isDirectoryItem(item) && (matchesKind(item, "image") || matchesKind(item, "video"))

	return {
		id: item.data.uuid,
		name: driveItemName(item),
		parent: listingUuid(item.data.parent) ?? "",
		uploaded,
		...(media ? { taken: estimateCaptureTimestamp(uploaded, meta?.created ?? undefined, lastModifiedOf(item)) } : {}),
		...(created === undefined ? {} : { created }),
		modified: Number(lastModifiedOf(item))
	}
}

// The files of a directory a batch acts on: its own files of the kind, that decrypt.
async function directoryFiles(uuid: string | null, kind: string | undefined): Promise<{ files: DriveItem[]; listing: DriveItem[] }> {
	const listing = await readDriveListing(uuid)

	return {
		listing,
		files: listing.filter(item => !isDirectoryItem(item) && !item.data.undecryptable && matchesKind(item, kind))
	}
}

// The arguments a batch call runs with, cut to what its scheme uses: the card shows those, and an argument a small
// model filled in for nothing never reaches the guard as text the user did not type.
export const BATCH_WRITE_ARGS: Readonly<
	Record<BatchTool, (scope: ToolScope, input: Record<string, unknown>) => Promise<Record<string, unknown>>>
> = {
	rename_by_pattern: (_scope, input) => {
		const handles = handleList(input, "handles")
		const scheme = requiredString(input, "scheme")
		const kind = optionalString(input, "kind")
		const target = optionalString(input, "scope")

		if (handles.length === 0 && target === undefined) {
			return Promise.reject(new AssistantToolError("Pass scope (a directory) or handles (the files)", { invalid: true }))
		}

		return Promise.resolve({
			...(handles.length > 0 ? { handles } : { scope: target, ...(kind === undefined || kind === "any" ? {} : { kind }) }),
			scheme,
			...(DATE_SCHEMES.has(scheme) && input["date"] !== undefined ? { date: input["date"] } : {}),
			...(TEXT_SCHEMES.has(scheme) && input["text"] !== undefined ? { text: input["text"] } : {}),
			...(scheme === "replace_text" && input["find"] !== undefined ? { find: input["find"] } : {})
		})
	},
	organize_by_date: (_scope, input) => {
		const kind = optionalString(input, "kind")

		return Promise.resolve({
			scope: requiredString(input, "scope"),
			...(kind === undefined || kind === "any" ? {} : { kind }),
			by: requiredString(input, "by"),
			...(input["date"] === undefined ? {} : { date: input["date"] })
		})
	}
}

async function planRename(scope: ToolScope, args: Record<string, unknown>, key: string): Promise<RenamePlan> {
	const handles = handleList(args, "handles")
	let files: DriveItem[]
	const taken = new Map<string, readonly string[]>()

	if (handles.length > 0) {
		files = (await driveItemsOf(scope, handles)).filter(item => !item.data.undecryptable)

		for (const parent of new Set(files.map(item => listingUuid(item.data.parent)))) {
			taken.set(parent ?? "", [...(await takenNamesInDirectory(parent))])
		}
	} else {
		const directory = await destinationOf(scope, requiredString(args, "scope"))
		const read = await directoryFiles(directory.uuid, optionalString(args, "kind"))

		files = read.files
		taken.set(directory.uuid ?? "", read.listing.map(driveItemName))
	}

	const result = planBatchRename({
		names: DRIVE_NAME_RULES,
		items: files.map(batchItem),
		taken,
		scheme: requiredString(args, "scheme") as BatchRenameScheme,
		date: optionalString(args, "date") as BatchDateField | undefined,
		text: optionalString(args, "text"),
		find: optionalString(args, "find"),
		timeZone: scope.calendar.timeZone
	})

	if (!result.ok) {
		throw new AssistantToolError(result.error, { invalid: true })
	}

	return {
		tool: "rename_by_pattern",
		key,
		items: new Map(files.map(item => [item.data.uuid, item])),
		skipped: result.plan.skipped,
		plan: result.plan
	}
}

async function planOrganize(scope: ToolScope, args: Record<string, unknown>, key: string): Promise<OrganizePlan> {
	const directory = await destinationOf(scope, requiredString(args, "scope"))
	const { files, listing } = await directoryFiles(directory.uuid, optionalString(args, "kind"))
	const request = {
		names: DRIVE_NAME_RULES,
		items: files.map(batchItem),
		children: listing.map(item => ({ id: item.data.uuid, name: driveItemName(item), directory: isDirectoryItem(item) })),
		by: requiredString(args, "by") as BatchOrganizeBy,
		date: optionalString(args, "date") as BatchDateField | undefined,
		timeZone: scope.calendar.timeZone
	}
	// Planned twice: first to learn which existing subdirectories are reused, then with the names those hold.
	const first = planOrganizeByDate({ ...request, destinationNames: new Map() })

	if (!first.ok) {
		throw new AssistantToolError(first.error, { invalid: true })
	}

	const destinationNames = new Map<string, readonly string[]>()

	for (const group of first.plan.groups) {
		if (group.existing !== undefined) {
			destinationNames.set(group.existing, [...(await takenNamesInDirectory(group.existing))])
		}
	}

	const result = destinationNames.size === 0 ? first : planOrganizeByDate({ ...request, destinationNames })

	if (!result.ok) {
		throw new AssistantToolError(result.error, { invalid: true })
	}

	return {
		tool: "organize_by_date",
		key,
		scope: directory,
		items: new Map(files.map(item => [item.data.uuid, item])),
		skipped: result.plan.skipped,
		plan: result.plan
	}
}

// The plan for these arguments: the one held when it matches, else worked out now and held.
async function planFor(tool: BatchTool, scope: ToolScope, args: Record<string, unknown>): Promise<Plan> {
	const key = planKey(tool, args)

	if (held?.key === key) {
		return held
	}

	const plan = tool === "rename_by_pattern" ? await planRename(scope, args, key) : await planOrganize(scope, args, key)

	held = plan

	return plan
}

function changeCount(plan: Plan): number {
	return plan.tool === "rename_by_pattern" ? plan.plan.changes.length : batchOrganizeCount(plan.plan)
}

// Refused before a card when nothing would change.
export const BATCH_PRECHECKS: Readonly<Record<BatchTool, (scope: ToolScope, input: Record<string, unknown>) => Promise<string | null>>> = {
	rename_by_pattern: async (scope, input) => {
		const plan = await planFor("rename_by_pattern", scope, input)

		return changeCount(plan) > 0 ? null : "No file would get a new name; nothing to rename"
	},
	organize_by_date: async (scope, input) => {
		const plan = await planFor("organize_by_date", scope, input)

		return changeCount(plan) > 0 ? null : "No file to sort into a subdirectory; nothing to move"
	}
}

export function isBatchTool(name: string): name is BatchTool {
	return name === "rename_by_pattern" || name === "organize_by_date"
}

// What the card lists.
export async function batchPreview(tool: BatchTool, scope: ToolScope, args: Record<string, unknown>): Promise<AssistantBatchPlan> {
	const plan = await planFor(tool, scope, args)
	const rule = Object.fromEntries(
		(["scheme", "by", "date"] as const).flatMap(key => (typeof args[key] === "string" ? [[key, args[key]]] : []))
	)
	const skipped = plan.skipped.map(({ name, reason }) => ({ name, reason }))

	if (plan.tool === "rename_by_pattern") {
		return { rule, changes: plan.plan.changes.map(({ from, to, suffixed }) => ({ from, to, suffixed })), skipped }
	}

	return {
		rule,
		groups: plan.plan.groups.map(group => ({
			directory: group.directory,
			isNew: group.existing === undefined,
			items: group.items.map(({ from, to }) => ({ from, ...(to === undefined ? {} : { to }) }))
		})),
		skipped
	}
}

function isPlanOf<Tool extends BatchTool>(plan: Plan, tool: Tool): plan is Extract<Plan, { tool: Tool }> {
	return plan.tool === tool
}

// The plan the card showed, taken for its run: a later call plans afresh.
function takePlan<Tool extends BatchTool>(tool: Tool, args: Record<string, unknown>): Extract<Plan, { tool: Tool }> {
	const plan = held

	if (plan?.key !== planKey(tool, args) || !isPlanOf(plan, tool)) {
		throw new AssistantToolError("The plan this card showed is no longer held; ask again to plan it anew")
	}

	held = null

	return plan
}

// A file as it is now, or why it is left out: one renamed, moved or gone since the card showed it is not touched.
function stillAsPlanned(planned: DriveItem): DriveItem | null {
	const live = findOwnedListingItem(planned.data.uuid)?.item

	return live !== undefined && driveItemName(live) === driveItemName(planned) && live.data.parent === planned.data.parent ? live : null
}

function failures(outcome: BulkOutcome<DriveItem>): { failed?: { name: string; error: string }[] } {
	return outcome.failed.length === 0
		? {}
		: { failed: outcome.failed.map(failure => ({ name: driveName(failure.item), error: errorLabel(failure.error) })) }
}

function skippedField(skipped: readonly { name: string; reason: string }[]): { skipped?: { name: string; reason: string }[] } {
	return skipped.length === 0 ? {} : { skipped: [...skipped] }
}

export const renameByPatternTool: ToolAdapter = async (input, scope) => {
	const plan = takePlan("rename_by_pattern", input)

	const skipped: { name: string; reason: string }[] = plan.skipped.map(({ name, reason }) => ({ name, reason }))
	const items: DriveItem[] = []
	const names = new Map<string, string>()

	for (const change of plan.plan.changes) {
		const planned = plan.items.get(change.id)
		const live = planned === undefined ? null : stillAsPlanned(planned)

		if (live === null) {
			skipped.push({ name: change.from, reason: "changed since the card showed it" })
		} else {
			items.push(live)
			names.set(change.id, change.to)
		}
	}

	if (items.length === 0) {
		throw new AssistantToolError("Every file changed since the card showed it; nothing was renamed")
	}

	throwIfStopped(scope)

	const outcome = await runBulkActivity(
		driveActivity(items, DRIVE_RENAME, (targets, onSettled) => renameItems(targets, names, onSettled))
	)

	if (outcome.succeeded.length === 0) {
		throw new AssistantToolError(errorLabel(outcome.failed[0]?.error))
	}

	return { value: { renamed: outcome.succeeded.length, ...skippedField(skipped), ...failures(outcome) } }
}

export const organizeByDateTool: ToolAdapter = async (input, scope) => {
	const plan = takePlan("organize_by_date", input)

	const skipped: { name: string; reason: string }[] = plan.skipped.map(({ name, reason }) => ({ name, reason }))
	// Where each file goes, and the name it takes there when its own is taken.
	const destinations = new Map<string, { group: string; to?: string }>()
	const items: DriveItem[] = []

	for (const group of plan.plan.groups) {
		for (const move of group.items) {
			const planned = plan.items.get(move.id)
			const live = planned === undefined ? null : stillAsPlanned(planned)

			if (live === null) {
				skipped.push({ name: move.from, reason: "changed since the card showed it" })
			} else {
				items.push(live)
				destinations.set(move.id, { group: group.directory, ...(move.to === undefined ? {} : { to: move.to }) })
			}
		}
	}

	if (items.length === 0) {
		throw new AssistantToolError("Every file changed since the card showed it; nothing was moved")
	}

	const groups = new Map(plan.plan.groups.map(group => [group.directory, group]))
	// Each subdirectory created once, a Try again's run reusing it.
	const directories = new Map<string, Promise<string>>()
	let created = 0

	function directoryUuid(name: string): Promise<string> {
		let pending = directories.get(name)

		if (pending === undefined) {
			const existing = groups.get(name)?.existing

			pending =
				existing !== undefined
					? Promise.resolve(existing)
					: createDirectory(plan.scope.uuid, name).then(outcome => {
							if (outcome.status === "error") {
								directories.delete(name)

								throw new AssistantToolError(errorLabel(outcome.dto))
							}

							created++

							return outcome.item.data.uuid
						})
			directories.set(name, pending)
		}

		return pending
	}

	throwIfStopped(scope)

	// One toast for the card: the subdirectories, the renames that avoid a clash, then one move per subdirectory.
	const run = async (targets: DriveItem[], onSettled: (settled: number, total: number) => void): Promise<BulkOutcome<DriveItem>> => {
		let settled = 0
		const tick = () => {
			settled++
			onSettled(settled, targets.length)
		}
		const outcome: BulkOutcome<DriveItem> = { succeeded: [], failed: [] }
		// A Try again finds the renames that went through done already.
		const renames = new Map(
			targets.flatMap(item => {
				const to = destinations.get(item.data.uuid)?.to
				const live = findOwnedListingItem(item.data.uuid)?.item ?? item

				return to === undefined || driveItemName(live) === to ? [] : [[item.data.uuid, to] as const]
			})
		)
		const renamed =
			renames.size === 0
				? { succeeded: [], failed: [] }
				: await renameItems(
						targets.filter(item => renames.has(item.data.uuid)),
						renames
					)

		for (const failure of renamed.failed) {
			outcome.failed.push(failure)
			tick()
		}

		const failedRenames = new Set(renamed.failed.map(failure => failure.item.data.uuid))
		const byGroup = new Map<string, DriveItem[]>()

		for (const item of targets) {
			const group = destinations.get(item.data.uuid)?.group

			if (group === undefined || failedRenames.has(item.data.uuid)) {
				continue
			}

			let moving = byGroup.get(group)

			if (moving === undefined) {
				moving = []
				byGroup.set(group, moving)
			}

			// After its rename, as the listing now holds it.
			moving.push(findOwnedListingItem(item.data.uuid)?.item ?? item)
		}

		await Promise.all(
			[...byGroup].map(async ([group, moving]) => {
				let uuid: string

				try {
					uuid = await directoryUuid(group)
				} catch (error) {
					for (const item of moving) {
						outcome.failed.push({ item, error })
						tick()
					}

					return
				}

				const moved = await moveItems(moving, uuid, tick)

				outcome.succeeded.push(...moved.succeeded)
				outcome.failed.push(...moved.failed)
			})
		)

		return outcome
	}

	const outcome = await runBulkActivity(driveActivity(items, DRIVE_SORT_BY_DATE, run, { values: { destination: plan.scope.name } }))

	if (outcome.succeeded.length === 0) {
		throw new AssistantToolError(errorLabel(outcome.failed[0]?.error))
	}

	const path = await destinationPath(plan.scope.entity)

	return {
		value: { moved: outcome.succeeded.length, created, in: path ?? plan.scope.name, ...skippedField(skipped), ...failures(outcome) }
	}
}

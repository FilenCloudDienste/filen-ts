import { type, type Type } from "arktype"
import { kvGetJson, kvSetJson } from "@/lib/storage/adapter"
import { normalizeRailOrder, type RailEntryId } from "@/features/shell/lib/railOrder.logic"

// Stored in this browser only, like the other shell layout preferences.
const RAIL_ORDER_KV_KEY = "shell.railOrder.v1"

const railOrderSchema: Type<string[]> = type("string[]")

export async function getRailOrder(): Promise<RailEntryId[]> {
	return normalizeRailOrder(await kvGetJson(RAIL_ORDER_KV_KEY, railOrderSchema))
}

export async function setRailOrder(next: readonly RailEntryId[]): Promise<void> {
	await kvSetJson(RAIL_ORDER_KV_KEY, [...next])
}

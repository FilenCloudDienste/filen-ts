import { type } from "arktype"

// The pair detail's tabs, carried in the `tab` search param so a tab is deep-linkable.
export const syncTab = type("'activity' | 'issues' | 'ignored' | 'settings'")

export type SyncTab = typeof syncTab.infer

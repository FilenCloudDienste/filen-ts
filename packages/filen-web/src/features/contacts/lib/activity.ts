import { activityKeys } from "@/lib/activity/activity.logic"

// The contacts' actions in the words their activity toasts use (locales/en/contacts.ts, "Activity toasts").
export const CONTACTS_ACCEPT = activityKeys("contacts:contactsAccept")

export const CONTACTS_DENY = activityKeys("contacts:contactsDeny")

export const CONTACTS_CANCEL_REQUEST = activityKeys("contacts:contactsCancelRequest")

export const CONTACTS_REMOVE = activityKeys("contacts:contactsRemove")

export const CONTACTS_BLOCK = activityKeys("contacts:contactsBlock")

export const CONTACTS_UNBLOCK = activityKeys("contacts:contactsUnblock")

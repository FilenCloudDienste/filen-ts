// Whether an account is Pro (paid features: public links, chat attachments, the "Pro" label), decided exactly as
// filen-backend's isUserPro does when it allows or refuses those features: any activated subscription. A cancelled
// one still counts until its paid period ends and the backend deactivates it.
//
// Never `isPremium` from the account API: that is users.is_premium, which the backend sets only on one-off purchases
// (never for subscriptions) and never resets, so it calls subscribers Free and refunded lifetime buyers Pro forever.
export const isProAccount = (subs: readonly { readonly activated: boolean }[]): boolean => subs.some(sub => sub.activated)

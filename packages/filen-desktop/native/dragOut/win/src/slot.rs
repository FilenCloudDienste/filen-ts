//! Tickets: one per `FileContents` request. A stream waits on its ticket's [`Slot`] until JS reports the entry's temp
//! file (`complete`), its failure (`fail`) or an abort (`EndOperation`, quit). Waits are bounded: each step re-checks
//! whether the caller cancelled the COM call, so a blocked `Read` never outlives Explorer's interest in it.

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError, Weak};
use std::time::Duration;

/// How long one wait lasts before the caller's cancellation is checked again.
pub const WAIT_STEP: Duration = Duration::from_millis(250);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WaitError {
    /// JS could not provide the file.
    Failed,
    /// The operation ended or the app quits.
    Aborted,
    /// The COM caller cancelled the call.
    Cancelled,
}

#[derive(Debug)]
enum State {
    Waiting,
    Ready(PathBuf),
    Failed,
    Aborted,
}

/// One ticket's answer, shared by the stream and its clones.
#[derive(Debug)]
pub struct Slot {
    state: Mutex<State>,
    changed: Condvar,
}

// No code here panics while holding a lock; a poisoned lock still holds a consistent state.
pub(crate) fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Slot {
    fn new() -> Self {
        Self {
            state: Mutex::new(State::Waiting),
            changed: Condvar::new(),
        }
    }

    /// The temp file is whole. Only a waiting slot takes it.
    pub fn complete(&self, path: PathBuf) -> bool {
        self.answer(State::Ready(path))
    }

    /// Only a waiting slot fails.
    pub fn fail(&self) -> bool {
        self.answer(State::Failed)
    }

    fn answer(&self, answer: State) -> bool {
        let mut state = lock(&self.state);

        if !matches!(*state, State::Waiting) {
            return false;
        }

        *state = answer;
        self.changed.notify_all();
        true
    }

    /// Every later read fails, a ready slot's included.
    pub fn abort(&self) {
        *lock(&self.state) = State::Aborted;
        self.changed.notify_all();
    }

    /// Blocks until the slot is answered; `cancelled` is checked before the first wait and after every `step`.
    ///
    /// # Errors
    /// The slot failed or was aborted, or `cancelled` returned true.
    pub fn wait(&self, step: Duration, cancelled: impl Fn() -> bool) -> Result<PathBuf, WaitError> {
        let mut state = lock(&self.state);

        loop {
            match &*state {
                State::Ready(path) => return Ok(path.clone()),
                State::Failed => return Err(WaitError::Failed),
                State::Aborted => return Err(WaitError::Aborted),
                State::Waiting => {}
            }

            if cancelled() {
                return Err(WaitError::Cancelled);
            }

            state = self
                .changed
                .wait_timeout(state, step)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
    }
}

#[derive(Debug)]
struct Open {
    session: u64,
    slot: Weak<Slot>,
}

#[derive(Debug)]
struct Inner {
    next_ticket: u32,
    next_session: u64,
    aborted: bool,
    open: BTreeMap<u32, Open>,
    // Sessions whose operation ended: they open no ticket (forgotten when the session goes).
    ended: BTreeSet<u64>,
}

/// Every open ticket of the process, so `complete`/`fail` from JS find their slot and an abort reaches them all.
#[derive(Debug)]
pub struct Registry {
    inner: Mutex<Inner>,
}

impl Default for Registry {
    fn default() -> Self {
        Self::new()
    }
}

impl Registry {
    #[must_use]
    pub const fn new() -> Self {
        Self {
            inner: Mutex::new(Inner {
                next_ticket: 1,
                next_session: 1,
                aborted: false,
                open: BTreeMap::new(),
                ended: BTreeSet::new(),
            }),
        }
    }

    /// A new drag's id, grouping its tickets.
    pub fn session(&self) -> u64 {
        let mut inner = lock(&self.inner);
        let session = inner.next_session;

        inner.next_session += 1;
        session
    }

    /// A new waiting ticket of `session`; None once [`Registry::abort_all`] ran or the session ended. Checked under
    /// the lock [`Registry::abort_session`] takes, so a ticket opened while the session ends is aborted with it.
    pub fn open(&self, session: u64) -> Option<(u32, Arc<Slot>)> {
        let mut inner = lock(&self.inner);

        if inner.aborted || inner.ended.contains(&session) {
            return None;
        }

        // Skips 0 and, after a wrap, tickets still open.
        let mut ticket = inner.next_ticket;
        while ticket == 0 || inner.open.contains_key(&ticket) {
            ticket = ticket.wrapping_add(1);
        }
        inner.next_ticket = ticket.wrapping_add(1);

        let slot = Arc::new(Slot::new());
        inner.open.insert(
            ticket,
            Open {
                session,
                slot: Arc::downgrade(&slot),
            },
        );
        Some((ticket, slot))
    }

    fn slot(&self, ticket: u32) -> Option<Arc<Slot>> {
        let mut inner = lock(&self.inner);
        let slot = inner.open.get(&ticket)?.slot.upgrade();

        if slot.is_none() {
            inner.open.remove(&ticket);
        }
        slot
    }

    /// False for an unknown, closed or answered ticket.
    pub fn complete(&self, ticket: u32, path: PathBuf) -> bool {
        self.slot(ticket).is_some_and(|slot| slot.complete(path))
    }

    pub fn fail(&self, ticket: u32) -> bool {
        self.slot(ticket).is_some_and(|slot| slot.fail())
    }

    /// Every stream of the ticket is gone.
    pub fn close(&self, ticket: u32) {
        lock(&self.inner).open.remove(&ticket);
    }

    /// The session's operation ended: its tickets fail and it opens no new one.
    pub fn abort_session(&self, session: u64) {
        self.abort_where(
            |inner| {
                inner.ended.insert(session);
            },
            |open| open.session == session,
        );
    }

    /// The session is gone; its id is never reused.
    pub fn forget_session(&self, session: u64) {
        lock(&self.inner).ended.remove(&session);
    }

    /// Quit: every ticket fails and no new one opens.
    pub fn abort_all(&self) {
        self.abort_where(
            |inner| {
                inner.aborted = true;
            },
            |_| true,
        );
    }

    // `mark` and the collection share one lock, so no ticket opens between them. Slots are aborted outside the
    // registry lock, so the two locks are never held together.
    fn abort_where(&self, mark: impl FnOnce(&mut Inner), matches: impl Fn(&Open) -> bool) {
        let slots: Vec<Arc<Slot>> = {
            let mut inner = lock(&self.inner);

            mark(&mut inner);
            inner
                .open
                .values()
                .filter(|open| matches(open))
                .filter_map(|open| open.slot.upgrade())
                .collect()
        };

        for slot in slots {
            slot.abort();
        }
    }

    #[must_use]
    pub fn aborted(&self) -> bool {
        lock(&self.inner).aborted
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Origin {
    Start,
    Current,
    End,
}

/// `IStream::Seek`'s new position; None when it would leave `0..=size`.
#[must_use]
pub fn seek(position: u64, size: u64, origin: Origin, offset: i64) -> Option<u64> {
    let base = match origin {
        Origin::Start => 0,
        Origin::Current => position,
        Origin::End => size,
    };

    base.checked_add_signed(offset)
        .filter(|target| *target <= size)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::thread;
    use std::time::Instant;

    const STEP: Duration = Duration::from_millis(20);

    fn never() -> bool {
        false
    }

    #[test]
    fn a_completed_slot_hands_out_its_path_to_every_wait() {
        let registry = Registry::new();
        let session = registry.session();
        let (ticket, slot) = registry.open(session).expect("open");

        assert!(registry.complete(ticket, PathBuf::from("C:\\t\\a")));
        assert_eq!(slot.wait(STEP, never), Ok(PathBuf::from("C:\\t\\a")));
        assert_eq!(slot.wait(STEP, never), Ok(PathBuf::from("C:\\t\\a")));
        assert!(!registry.complete(ticket, PathBuf::from("C:\\t\\b")));
        assert!(!registry.fail(ticket));
    }

    #[test]
    fn complete_wakes_a_waiting_read() {
        let registry = Arc::new(Registry::new());
        let (ticket, slot) = registry.open(registry.session()).expect("open");
        let waiter = thread::spawn(move || slot.wait(Duration::from_secs(10), never));
        thread::sleep(STEP);

        let started = Instant::now();
        assert!(registry.complete(ticket, PathBuf::from("a")));
        assert_eq!(waiter.join().expect("join"), Ok(PathBuf::from("a")));
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn a_failed_slot_fails_its_reads() {
        let registry = Registry::new();
        let (ticket, slot) = registry.open(registry.session()).expect("open");

        assert!(registry.fail(ticket));
        assert_eq!(slot.wait(STEP, never), Err(WaitError::Failed));
        assert!(!registry.complete(ticket, PathBuf::from("a")));
    }

    #[test]
    fn a_waiting_read_notices_cancellation_within_one_wait() {
        let registry = Registry::new();
        let (_, slot) = registry.open(registry.session()).expect("open");
        let cancelled = Arc::new(AtomicBool::new(false));
        let flag = cancelled.clone();
        let waiter = thread::spawn(move || {
            let started = Instant::now();
            let result = slot.wait(STEP, || flag.load(Ordering::SeqCst));
            (result, started.elapsed())
        });
        thread::sleep(STEP * 3);

        // Nothing wakes the slot: the bounded wait finds the flag on its own.
        let flipped = Instant::now();
        cancelled.store(true, Ordering::SeqCst);
        let (result, _) = waiter.join().expect("join");
        assert_eq!(result, Err(WaitError::Cancelled));
        assert!(flipped.elapsed() < STEP * 10);
    }

    #[test]
    fn a_cancelled_call_does_not_wait_at_all() {
        let registry = Registry::new();
        let (_, slot) = registry.open(registry.session()).expect("open");

        assert_eq!(
            slot.wait(Duration::from_secs(60), || true),
            Err(WaitError::Cancelled)
        );
    }

    #[test]
    fn end_operation_abort_unblocks_a_waiting_read() {
        let registry = Arc::new(Registry::new());
        let ended = registry.session();
        let other = registry.session();
        let (_, waiting) = registry.open(ended).expect("open");
        let (ready_ticket, ready) = registry.open(ended).expect("open");
        let (other_ticket, untouched) = registry.open(other).expect("open");
        assert!(registry.complete(ready_ticket, PathBuf::from("a")));
        let waiter = thread::spawn(move || waiting.wait(Duration::from_secs(10), never));
        thread::sleep(STEP);

        let started = Instant::now();
        registry.abort_session(ended);
        assert_eq!(waiter.join().expect("join"), Err(WaitError::Aborted));
        assert!(started.elapsed() < Duration::from_secs(5));
        assert_eq!(ready.wait(STEP, never), Err(WaitError::Aborted));

        assert!(registry.complete(other_ticket, PathBuf::from("b")));
        assert_eq!(untouched.wait(STEP, never), Ok(PathBuf::from("b")));
    }

    #[test]
    fn an_ended_session_opens_no_ticket_until_forgotten() {
        let registry = Registry::new();
        let ended = registry.session();
        let other = registry.session();

        registry.abort_session(ended);
        assert!(registry.open(ended).is_none());
        assert!(registry.open(other).is_some());

        registry.forget_session(ended);
        assert!(registry.open(ended).is_some());
    }

    #[test]
    fn a_ticket_opened_while_its_session_ends_never_stays_waiting() {
        let registry = Arc::new(Registry::new());

        for _ in 0..200 {
            let session = registry.session();
            let opener = {
                let registry = registry.clone();
                thread::spawn(move || registry.open(session))
            };
            registry.abort_session(session);

            // Either refused, or opened before the end and aborted with it.
            if let Some((_, slot)) = opener.join().expect("join") {
                assert_eq!(slot.wait(STEP, never), Err(WaitError::Aborted));
            }
            assert!(registry.open(session).is_none());
            registry.forget_session(session);
        }
    }

    #[test]
    fn abort_all_fails_every_ticket_and_opens_no_new_one() {
        let registry = Registry::new();
        let (_, first) = registry.open(registry.session()).expect("open");
        let (_, second) = registry.open(registry.session()).expect("open");

        assert!(!registry.aborted());
        registry.abort_all();
        assert!(registry.aborted());
        assert_eq!(first.wait(STEP, never), Err(WaitError::Aborted));
        assert_eq!(second.wait(STEP, never), Err(WaitError::Aborted));
        assert!(registry.open(registry.session()).is_none());
    }

    #[test]
    fn a_closed_ticket_is_forgotten() {
        let registry = Registry::new();
        let (ticket, _slot) = registry.open(registry.session()).expect("open");

        registry.close(ticket);
        assert!(!registry.complete(ticket, PathBuf::from("a")));
    }

    #[test]
    fn a_ticket_whose_slot_is_gone_is_forgotten() {
        let registry = Registry::new();
        let (ticket, slot) = registry.open(registry.session()).expect("open");

        drop(slot);
        assert!(!registry.complete(ticket, PathBuf::from("a")));
    }

    #[test]
    fn tickets_and_sessions_are_unique() {
        let registry = Registry::new();
        let session = registry.session();
        let (a, _a) = registry.open(session).expect("open");
        let (b, _b) = registry.open(session).expect("open");

        assert_ne!(a, b);
        assert_ne!(a, 0);
        assert_ne!(session, registry.session());
    }

    #[test]
    fn seek_stays_within_the_stream() {
        assert_eq!(seek(5, 10, Origin::Start, 3), Some(3));
        assert_eq!(seek(5, 10, Origin::Current, -5), Some(0));
        assert_eq!(seek(5, 10, Origin::Current, 5), Some(10));
        assert_eq!(seek(5, 10, Origin::End, -4), Some(6));
        assert_eq!(seek(5, 10, Origin::End, 0), Some(10));
        assert_eq!(seek(5, 10, Origin::Current, -6), None);
        assert_eq!(seek(5, 10, Origin::End, 1), None);
        assert_eq!(seek(5, 10, Origin::Start, -1), None);
        assert_eq!(seek(u64::MAX, u64::MAX, Origin::Current, i64::MAX), None);
        assert_eq!(seek(0, u64::MAX, Origin::Start, i64::MIN), None);
    }
}

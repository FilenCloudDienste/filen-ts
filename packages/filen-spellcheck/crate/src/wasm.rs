//! The C ABI the web worker calls: thin forwards to the module's one `Boundary`, which owns the I/O
//! buffers and the dictionaries and checks every length and id (see boundary.rs). No pointer from the
//! caller is ever dereferenced; the only addresses that cross are the module's own regions, returned for
//! the caller to write into (scratch) and read from (output). The exports carry `no_mangle`, an unsafe
//! attribute only because of symbol collisions, which a cdylib with these unique names does not have.

#![allow(unsafe_code)]

use crate::boundary::Boundary;
use core::cell::RefCell;

std::thread_local! {
    // wasm32-unknown-unknown has one thread: this is the module's state.
    static BOUNDARY: RefCell<Boundary> = RefCell::new(Boundary::default());
}

fn with<T>(f: impl FnOnce(&mut Boundary) -> T) -> T {
    BOUNDARY.with(|boundary| f(&mut boundary.borrow_mut()))
}

fn address(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(0)
}

/// The scratch region's address with room for `min_len` bytes (write input there); 0 when over the cap or
/// out of memory. Ask again before every write: the region moves when it grows or is released.
#[unsafe(no_mangle)]
pub extern "C" fn fs_buffer(min_len: u32) -> u32 {
    with(|boundary| boundary.buffer(min_len).map_or(0, address))
}

/// The output region's address, valid until the next call.
#[unsafe(no_mangle)]
pub extern "C" fn fs_output() -> u32 {
    with(|boundary| address(boundary.output()))
}

/// A dictionary from scratch `[0, aff_len)` and `[aff_len, aff_len + dic_len)`: its id (> 0) or an
/// error.
#[unsafe(no_mangle)]
pub extern "C" fn fs_new(aff_len: u32, dic_len: u32) -> i32 {
    with(|boundary| boundary.create(aff_len, dic_len))
}

#[unsafe(no_mangle)]
pub extern "C" fn fs_drop(id: u32) -> i32 {
    with(|boundary| boundary.drop_speller(id))
}

/// Verdicts for the `\n`-separated words in scratch `[0, len)`, one byte each in the output region; returns
/// their count or an error.
#[unsafe(no_mangle)]
pub extern "C" fn fs_check(id: u32, len: u32) -> i32 {
    with(|boundary| boundary.check(id, len))
}

/// Suggestions for the word in scratch `[0, len)`, `\n`-separated in the output region; returns their byte
/// length or an error.
#[unsafe(no_mangle)]
pub extern "C" fn fs_suggest(id: u32, len: u32, ngram: u32) -> i32 {
    with(|boundary| boundary.suggest(id, len, ngram))
}

/// Accepts the word in scratch `[0, len)`: 1 added, 0 not, or an error.
#[unsafe(no_mangle)]
pub extern "C" fn fs_add(id: u32, len: u32) -> i32 {
    with(|boundary| boundary.add(id, len))
}

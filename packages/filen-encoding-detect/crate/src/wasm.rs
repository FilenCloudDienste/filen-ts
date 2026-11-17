//! The C ABI the page calls: thin forwards to the module's one `Boundary`, which owns the I/O buffers and
//! checks every length (see boundary.rs). No pointer from the caller is ever dereferenced; the only
//! addresses that cross are the module's own regions, returned for the caller to write into (scratch) and
//! read from (output). The exports carry `no_mangle`, an unsafe attribute only because of symbol
//! collisions, which a cdylib with these unique names does not have.

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
/// out of memory. Ask again before every write: the region moves when it grows.
#[unsafe(no_mangle)]
pub extern "C" fn ed_buffer(min_len: u32) -> u32 {
    with(|boundary| boundary.buffer(min_len).map_or(0, address))
}

/// The output region's address, valid until the next call.
#[unsafe(no_mangle)]
pub extern "C" fn ed_output() -> u32 {
    with(|boundary| address(boundary.output()))
}

/// The encoding of scratch `[0, len)` (`last` non-zero: the whole file), its name in the output region;
/// returns the name's byte length or an error.
#[unsafe(no_mangle)]
pub extern "C" fn ed_guess(len: u32, last: u32) -> i32 {
    with(|boundary| boundary.guess(len, last != 0))
}

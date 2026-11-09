// test/helpers/head-done.mjs — `listed(h)`: a session's head (or its answer) was written from the full row list. One written while the
// worker's boot pass still builds that list says so (`index-pending`, level 'state', 3.5 §行表先读) and is rewritten once the pass ends,
// so a test that takes a head at its end as done, then stops the worker or compares its bytes, waits for this too.
export const listed = (h) => !!h && !(h.errors || []).some((e) => e.code === 'index-pending')

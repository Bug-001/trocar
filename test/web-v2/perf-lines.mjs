// test/web-v2/perf-lines.mjs — the board's performance lines in ms (D64 ①②③): the only place the numbers live (D64⑥). A run that
// misses a line reports it; it never edits these values to turn green.
export const BOARD_LINES = Object.freeze({ sessionOpen: 500, stepClick: 50, button: 500 })

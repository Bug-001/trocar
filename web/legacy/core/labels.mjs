// core/labels.mjs — the aggregator: every label table of the board is read through here, so a screen imports one name
// and a table can move between files in labels/ without touching the screens (1.5 §数据规则 · label tables).
export * from '../labels/common.mjs'
export * from '../labels/shell.mjs'

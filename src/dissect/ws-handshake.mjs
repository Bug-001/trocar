// src/dissect/ws-handshake.mjs — the HTTP upgrade itself (a 101, or a refusal such as 426): a transport
// event, not a logical call (4.6 §传输与帧级记录; gate G6). Its own module so a WebSocket dissector can use
// it without importing the registry (which will register that dissector). Leaf module.
import { headerOf } from './harnesses.mjs';

export function isWsHandshake(rec) {
  if (!rec || rec.transport === 'ws') return false; // a logical WebSocket call, not its handshake
  if (((rec.resp || rec.response) || {}).status === 101) return true;
  return String(headerOf(rec, 'upgrade') || '').toLowerCase() === 'websocket';
}

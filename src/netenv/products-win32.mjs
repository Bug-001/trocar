// products-win32.mjs — the proxy / VPN software asight knows on Windows, as data (RFC 4.7 §6; acceptance N10). Only Clash Verge Rev is written to (4.7 §1: the named writes of §3.4, in
// src/netenv/adapters/clash-verge-rev.mjs); every other product is read only, and nothing in src/netenv has a write for one. `images` are the image names (compared without case) that tell the product is
// running; `imagePatterns` the one family named by a pattern (Clash Party's mihomo*.exe). `tunAdapters` are names of the virtual adapter the product's TUN creates (compared to the adapter list's name or
// description). A name two products share (sing-box.exe is GUI.for.SingBox's core and v2rayN's) is `shared`: it alone does not say which one runs. Nothing here is read from the machine.

export const PRODUCTS_WIN32 = Object.freeze([
  { id: 'clash-verge-rev', name: 'Clash Verge Rev', writable: true, images: ['clash-verge.exe', 'verge-mihomo.exe', 'verge-mihomo-alpha.exe', 'clash-verge-service.exe'], imagePatterns: [], shared: [], tunAdapters: ['Meta', 'Meta Tunnel'], dataDir: String.raw`%APPDATA%\io.github.clash-verge-rev.clash-verge-rev` },
  { id: 'clash-party', name: 'Clash Party', writable: false, images: ['mihomo-party.exe'], imagePatterns: ['^mihomo[^\\\\/]*\\.exe$'], shared: [], tunAdapters: ['Meta', 'Meta Tunnel'] },
  { id: 'flclash', name: 'FlClash', writable: false, images: ['FlClash.exe', 'FlClashCore.exe'], imagePatterns: [], shared: [], tunAdapters: ['FlClash', 'Meta'] },
  { id: 'gui-for-singbox', name: 'GUI.for.SingBox', writable: false, images: ['GUI.for.SingBox.exe'], imagePatterns: [], shared: ['sing-box.exe'], tunAdapters: ['sing-box', 'sing-tun'] },
  { id: 'v2rayn', name: 'v2rayN', writable: false, images: ['v2rayN.exe', 'xray.exe'], imagePatterns: [], shared: ['sing-box.exe'], tunAdapters: ['singbox_tun', 'xray_tun', 'sing-tun'] },
].map((p) => Object.freeze({ ...p, images: Object.freeze([...p.images]), imagePatterns: Object.freeze([...p.imagePatterns]), shared: Object.freeze([...p.shared]), tunAdapters: Object.freeze([...p.tunAdapters]) })))

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase()

/** The products an image name belongs to: `{ own: [ids that list it as their own], shared: [ids that share it] }`. */
export function productsOfImage(image, products = PRODUCTS_WIN32) {
  const own = products.filter((p) => p.images.some((i) => same(i, image)) || p.imagePatterns.some((re) => new RegExp(re, 'i').test(String(image)))).map((p) => p.id)
  return { own, shared: products.filter((p) => p.shared.some((i) => same(i, image))).map((p) => p.id) }
}

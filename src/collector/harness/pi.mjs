// pi.mjs — pi (@earendil-works/pi-coding-agent; RFC 4.6 §身份与信任 pi rows, 4.11 §2.3, D37). Facts: pi 1.4.0 on a Windows test machine
// (the managed install, npm's shims, the Bun binary, rpc mode) and the pi source. The managed install starts a launcher node
// (…/bin/pi-launcher.js) that only waits for its child node, which runs …/@earendil-works/pi-coding-agent/dist/bundle/cli.js and holds every
// connection; npm's shim runs that cli.js in one node (its %dp0% can double a separator); the Bun build is one pi(.exe). pi's tool
// subprocesses (Git bash on Windows) inherit its whole environment, PI_CODING_AGENT / AI_AGENT included, so those never name the agent.
// Agent dir: $PI_CODING_AGENT_DIR (a leading ~ expanded), else ~/.pi/agent; pi imports every file in its extensions/ at start, unless
// started with --no-extensions or its settings leave the file out. Proxy: the proxy names from the environment, and settings.json
// `httpProxy` filling what the environment lacks; no OS proxy.
// Trust: on Linux, trocar's extension <agent dir>/extensions/trocar-ca.js appends the trocar CA to Node's default roots and writes the
// per-pid marker (the dsh plugin's body, 4.6); on macOS / Windows the P9 template pi-extension adds the root and reads the switch file once.
import path from 'node:path'
import { expandHome, parseJsonc } from '../core/config-read.mjs'
import { MARKER_VAR } from '../core/trust/confirm.mjs'
import { envProxies, urlHostsDeep } from './_common.mjs'
import { renderPlugin } from './_plugins.mjs'

const agentDir = (get, home) => expandHome(get('PI_CODING_AGENT_DIR'), home) || path.join(home, '.pi', 'agent')

// The hosts <agent dir>/models.json names (pi's models docs): a provider's `baseUrl` replaces the built-in one, a custom provider needs one, a model
// may carry its own. pi reads the file as JSON with comments; one trocar cannot parse is reported (D38) and names no host.
function configHosts(ctx) {
  const file = path.join(agentDir((k) => ctx.env.get(k), ctx.home), 'models.json')
  const text = ctx.readText(file)
  if (text == null) return []
  const { data, errors } = parseJsonc(text)
  if (errors && ctx.unparsable) ctx.unparsable(file)
  return data && typeof data === 'object' ? urlHostsDeep(data.providers, /^baseUrl$/) : []
}

function inject(ctx) {
  return {
    owned: [{
      path: path.join(agentDir((k) => ctx.env.get(k), ctx.home), 'extensions', 'trocar-ca.js'), role: 'plugin', mode: 0o644,
      data: renderPlugin('pi/trocar-ca.js', { caFile: ctx.caPem, markerDir: path.join(ctx.collectorDir, 'run', 'trust') }),
    }],
    notes: [{ code: 'harness-note', text: "a pi started with --no-extensions, or whose settings leave trocar's extension out, does not load it and is not captured" }],
  }
}

// How pi reads a proxy (RFC 1.6 §9.7): HTTPS_PROXY / HTTP_PROXY from its environment at start; settings.json `httpProxy` fills only what
// the environment lacks; no OS proxy. A SOCKS proxy makes the request fail.
const proxy = {
  env: ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'],
  files: [{ path: ({ home, env }) => path.join(agentDir((k) => env[k], home), 'settings.json'), format: 'json', keys: [['httpProxy']] }],
  systemProxy: { http: false, ws: false },
  schemes: ['http', 'https'],
  unsupported: { socks5: 'fails' },
  branches: ['all'],
  measured: { win32: 'lab', linux: 'inferred', darwin: 'inferred' }, // Windows: a test machine; elsewhere inferred from it, until measured
  restart: { hint: 'Quit pi (and the program running pi --mode rpc), then start it again (it reads the switch once, at start)', processes: 'pi' },
}

// Proxy mode, macOS and Windows (spec 4.11 §2.3): data only. The install-time extension in pi's extensions dir carries the root and reads
// the switch file once at import (so a pi started while on is a holder, P12); every form has it.
const PI = (p) => ({ base: 'home', dir: '.pi/agent', env: 'PI_CODING_AGENT_DIR', path: p })
const NOT_MEASURED = { reason: 'not-measured' }
const form = (id, present, verified = NOT_MEASURED) => ({ id, os: ['darwin', 'win32'], route: 'switch', cert: 'ext', trust: 'node', present, verified: { darwin: verified, win32: verified } })
const proxyMode = {
  forms: [
    form('pi.cli', [PI('bin'), { command: 'pi' }]),
    form('pi.npm', [{ command: 'pi' }]),
    form('pi.rpc', [{ command: 'pi' }]),
    form('pi.bin', [{ command: 'pi' }], { reason: 'out-of-scope' }),
  ],
  routes: {
    switch: { kind: 'switch-file', absent: 'create', takesEffect: 'takes effect for the next pi you start' },
  },
  certs: {
    ext: { kind: 'plugin', template: 'pi-extension', dir: PI('extensions') },
  },
  trusts: {
    // the extension carries the trocar root in process; pi is Node, so the files its own NODE_EXTRA_CA_CERTS names are in its set too
    node: { base: 'node', sources: [{ from: { env: 'NODE_EXTRA_CA_CERTS' }, semantics: 'add' }] },
  },
  userCertFiles: [],
  blockers: [],
}

export default {
  name: 'pi',
  runtime: 'node',
  // Which processes are pi (D51 preset, every OS): the Bun binary pi, and node whose entry is pi's bin (…/pi) or the package's bundled cli.js
  // (separators may repeat); the managed launcher node (…/pi-launcher.js) only waits for its child and is not it.
  processes: {
    names: [{ name: 'pi' }, { name: 'node', entry: '((^|/)pi|/+@earendil-works/+pi-coding-agent/+dist/+bundle/+cli\\.js)$' }],
    exclude: [{ name: 'node', args: 'pi-launcher\\.js' }],
    longLived: [{ args: '(^| )--mode( |=)rpc( |$)' }],
  },
  // The fixed default base URL of each provider built into pi-ai (its provider catalog, plus pi's own radius gateway). A host made from the user's
  // region or account (Vertex `{location}-aiplatform`, Azure, other Bedrock regions) is in the set only when models.json names it (configHosts).
  hosts: [
    'api.anthropic.com', 'api.openai.com', 'chatgpt.com', 'generativelanguage.googleapis.com', 'api.mistral.ai', 'openrouter.ai', 'us.openrouter.ai', 'radius.pi.dev',
    'api.individual.githubcopilot.com', 'api.kimi.com', 'api.moonshot.ai', 'api.moonshot.cn', 'api.x.ai', 'api.z.ai', 'open.bigmodel.cn', 'api.minimax.io', 'api.minimaxi.com',
    'api.deepseek.com', 'api.groq.com', 'api.cerebras.ai', 'api.fireworks.ai', 'api.together.ai', 'router.huggingface.co', 'inference.baseten.co', 'integrate.api.nvidia.com',
    'api.meta.ai', 'api.ant-ling.com', 'api.typesafe.ai', 'opencode.ai', 'ai-gateway.vercel.sh', 'gateway.ai.cloudflare.com', 'api.cloudflare.com',
    'api.xiaomimimo.com', 'token-plan-ams.xiaomimimo.com', 'token-plan-cn.xiaomimimo.com', 'token-plan-sgp.xiaomimimo.com',
    'token-plan.ap-southeast-1.maas.aliyuncs.com', 'token-plan.cn-beijing.maas.aliyuncs.com', 'bedrock-runtime.us-east-1.amazonaws.com', 'bedrock-runtime.eu-central-1.amazonaws.com',
  ],
  configHosts,
  proxy,
  proxyMode,
  proxies: (ctx) => envProxies(ctx.env, proxy.env),
  inject,
  trust: {
    // the marker first: when it is there, a failure names it, not a CA file the user exported for pi
    chain: [{ var: MARKER_VAR, semantic: 'append' }, { var: 'NODE_EXTRA_CA_CERTS', semantic: 'append' }],
    refine: (r) => (r.var === MARKER_VAR || !['var-missing', 'ca-not-in-file', 'file-unreadable'].includes(r.reason) ? null : 'no-marker'),
    hints: {
      'no-marker': "trocar's extension did not report trust for this pi: its file is gone, pi ran with --no-extensions or settings that leave it out, it runs on a Node older than 22.19, or it started before install; restart it once",
    },
  },
}

// fixtures/eighth.mjs — CM27's eighth harness (spec 4.11 §2.4, plan A.5): a harness that exists only as data. No import, no function anywhere: it must load
// and validate through the real loader (src/collector/harness/index.mjs) with zero code of its own. It uses every route kind, every cert kind, a trust with
// a precedence and a condition, a policy blocker and an effect, and a plugin cert both with a loader and without one (the host finds the hook in its
// folder), so the validation sees every axis. The flow half and the static guard are T25.
export default {
  name: 'eighth',
  runtime: 'node',
  processes: { names: [{ name: 'eighth' }] },
  hosts: ['api.eighth.example'],
  proxy: {
    env: ['HTTPS_PROXY', 'https_proxy'],
    files: [],
    systemProxy: { http: false, ws: false },
    schemes: ['http'],
    unsupported: {},
    branches: ['all'],
    measured: { win32: 'inferred', linux: 'inferred', darwin: 'inferred' },
    restart: { hint: '重新启动 eighth', processes: 'eighth' },
  },
  proxyMode: {
    forms: [
      { id: 'eighth.cli', os: ['darwin', 'win32'], route: 'settings', cert: 'bundle', trust: 'node', present: [{ command: 'eighth' }, { base: 'home', path: '.eighth' }], verified: { darwin: true, win32: { reason: 'not-measured' } } },
      { id: 'eighth.desktop', os: ['darwin', 'win32'], route: 'library', cert: 'root', trust: 'root', present: [{ perOs: { darwin: { base: 'abs', path: '/Applications/Eighth.app' }, win32: { base: 'localAppData', path: 'Programs/Eighth' } } }], verified: { darwin: true, win32: true }, forwardOnlyHosts: ['login.eighth.example'] },
      { id: 'eighth.editor', os: ['darwin', 'win32'], route: 'editor', cert: 'root', trust: 'root', present: [{ base: 'home', path: '.vscode/extensions', glob: 'eighth.eighth-*' }], verified: { darwin: true, win32: true }, hostTree: true, hosts: { processes: ['eighth-editor'] } },
      { id: 'eighth.env', os: ['darwin'], route: 'dotenv', cert: 'root', trust: 'root', present: [{ base: 'home', dir: '.eighth-env', env: 'EIGHTH_ENV_HOME' }], verified: { darwin: true } },
      { id: 'eighth.native', os: ['darwin', 'win32'], route: 'switch', cert: 'wrap', trust: 'node', present: [{ base: 'home', path: '.eighth/bin/eighth' }], verified: { darwin: true, win32: true } },
      { id: 'eighth.plugin', os: ['win32'], route: 'switch', cert: 'hook', trust: 'root', present: [{ base: 'home', path: '.eighth/plugins' }], verified: { win32: true } },
      { id: 'eighth.ext', os: ['darwin', 'win32'], route: 'switch', cert: 'ext', trust: 'node', present: [{ base: 'home', path: '.eighth/extensions' }], verified: { darwin: true, win32: true } },
      { id: 'eighth.folder', os: ['darwin', 'win32'], route: 'folder', cert: 'root', trust: 'root', present: [{ base: 'appSupport', path: 'eighth-host' }], verified: { darwin: true, win32: true } },
    ],
    routes: {
      settings: { kind: 'json-key', file: { base: 'home', dir: '.eighth', env: 'EIGHTH_HOME', path: 'settings.json' }, format: 'json', proxyKeys: [['env', 'HTTPS_PROXY'], ['env', 'https_proxy']], noProxyKeys: [['env', 'NO_PROXY'], ['env', 'no_proxy']], value: 'door-url', absent: 'create', takesEffect: '下次启动 eighth 时生效' },
      library: { kind: 'json-key', select: { dir: { perOs: { darwin: { base: 'appSupport', path: 'Eighth/library' }, win32: { base: 'localAppData', path: 'Eighth/library' } } }, meta: '_meta.json', idKey: 'appliedId', createIfNone: true }, format: 'json', proxyKeys: [['egressPacUrl']], value: 'pac-url', auth: false, absent: 'create', takesEffect: '下次启动 Eighth 桌面版时生效' },
      editor: { kind: 'json-key', file: { base: 'appSupport', path: 'Code/User/settings.json' }, format: 'jsonc', proxyKeys: [['http.proxy']], arrayItems: [{ keys: ['settingsSync.ignoredSettings'], value: 'http.proxy' }], value: 'door-url', absent: 'create', takesEffect: '重新加载编辑器窗口后生效' },
      dotenv: { kind: 'dotenv-block', file: { base: 'home', dir: '.eighth', env: 'EIGHTH_HOME', path: '.env' }, proxyKeys: ['HTTPS_PROXY', 'https_proxy'], noProxyKeys: ['NO_PROXY', 'no_proxy'], value: 'door-url', absent: 'not-routed', takesEffect: '重新启动 eighth 后生效' },
      switch: { kind: 'switch-file', absent: 'create', takesEffect: '下一个请求生效' },
      folder: { kind: 'plugin-file', dir: { base: 'appSupport', path: 'eighth-host/plugins' }, template: 'opencode-plugin', rereads: true, absent: 'create', takesEffect: '下一个实例生效' },
    },
    certs: {
      bundle: { kind: 'config-key', file: { base: 'home', dir: '.eighth', env: 'EIGHTH_HOME', path: 'settings.json' }, format: 'json', keys: ['env', 'EXTRA_CA'], semantics: 'add', when: { src: [{ file: { base: 'cwd', path: '.eighth/settings.json' }, format: 'json', keys: ['env', 'CERT_STORE'] }, { env: 'CERT_STORE' }], equals: 'bundled' } },
      wrap: { kind: 'wrapper', command: 'eighth', binDir: { base: 'home', path: '.eighth/bin' }, certVar: 'NODE_EXTRA_CA_CERTS', layout: 'native-binary' },
      ext: { kind: 'plugin', template: 'pi-extension', dir: { base: 'home', path: '.eighth/extensions' } },
      hook: { kind: 'plugin', template: 'cordis-plugin', dir: { base: 'home', path: '.eighth/plugins' }, loader: { file: { base: 'home', path: '.eighth/plugins.yml' }, format: 'yaml', keys: ['*', 'insert'] } },
    },
    trusts: {
      node: { base: 'node', sources: [{ from: { file: { base: 'cwd', path: '.eighth/settings.json' }, format: 'json', keys: ['env', 'EXTRA_CA'] }, semantics: 'add' }, { from: { env: 'NODE_EXTRA_CA_CERTS' }, semantics: 'add', required: true }], when: { src: { env: 'CERT_STORE' }, equals: 'bundled' } },
    },
    userCertFiles: [{ env: 'NODE_EXTRA_CA_CERTS' }, { file: { base: 'home', path: '.eighth/config.yaml' }, format: 'yaml', keys: ['routes', '*', 'ca'] }],
    blockers: [
      { at: { env: 'EIGHTH_PROXY' } },
      { at: { file: { perOs: { darwin: { base: 'abs', path: '/Library/Eighth/managed.json' }, win32: { base: 'abs', path: 'C:/ProgramData/Eighth/managed.json' } } }, format: 'json', keys: ['proxy'] } },
      { at: { policy: { darwin: { domain: 'com.eighth.desktop', key: 'egressPacUrl' }, win32: { key: 'SOFTWARE\\Policies\\Eighth', value: 'egressPacUrl' } } }, forms: ['eighth.desktop'] },
    ],
    effects: [{ id: 'eighth-residue', paths: [{ base: 'appSupport', path: 'eighth-host/node_modules' }], when: '第一次带插件运行时 eighth 在配置目录装依赖;off 不删' }],
  },
}

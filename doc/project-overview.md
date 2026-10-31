# Jitsi Meet: project overview for new contributors

A source-backed orientation to this repository: what it is, how it is laid out, how it boots, builds, is tested and packaged. It should take 10 to 15 minutes to read.

- **Snapshot:** fork `Eztaroz/jitsi-meet` (`git remote -v`), branch `claude/friendly-dijkstra-qlmzqv`, HEAD `da51f16`, read on 2026-10-31. The clone is shallow (50 commits), so history-based claims are limited.
- **Citations:** `path:line` is relative to the repo root. Handbook pages are cited by their published URL plus the source file in the official `jitsi/handbook` repo. `jitsi.github.io` could not be reached from the research environment, so the Handbook text was read from that repo's Markdown sources (`raw.githubusercontent.com/jitsi/handbook/master/docs/...`). Line numbers given for Handbook pages refer to those source files.
- Counts (files, keys, specs) were taken from the filesystem at the snapshot above and will drift over time.

---

## 1. What it is

- **Jitsi Meet** is the WebRTC video-conferencing client: a browser app plus React Native mobile apps and SDKs. The license is Apache-2.0 (`package.json:202`, `LICENSE`). `package.json` still describes it as "A sample app for the Jitsi Videobridge" (`package.json:4`) and points `repository` at upstream `git://github.com/jitsi/jitsi-meet` (`package.json:6-9`).
- **Where it sits in the stack.** The Handbook lists the components as follows ([architecture](https://jitsi.github.io/handbook/docs/architecture), source `docs/architecture.md:12-19`):
  - Jitsi Meet: "WebRTC compatible JavaScript application that uses Jitsi Videobridge…"
  - JVB: routes video streams between participants.
  - Jicofo: the "server-side focus component" that manages media sessions.
  - Jigasi: SIP gateway.
  - Jibri: recording and streaming.
  - Prosody: the "XMPP server used for signalling".
- **How the client connects, as the repo shows it:**
  - `config.js` names the XMPP domain and MUC, plus a BOSH URL (`/http-bind`) and a WebSocket URL (`/xmpp-websocket`) (`config.js:31-52`).
  - The shipped nginx template proxies both of those paths to Prosody (`doc/debian/jitsi-meet/jitsi-meet.example:8,145-146,154-155`). It includes a commented-out example for the JVB `colibri-ws` WebSocket (`:164-165`).
  - It also proxies `/conference-request/v1` to `127.0.0.1:8888` (`:187-188`). `config.js:63` describes that endpoint as sending "conference requests to jicofo over http".
  - Only the web client, its nginx/Prosody config and the Prosody plugins are built here. JVB, Jicofo and the `jitsi-meet` apt meta-package are not defined in this repo (see §10).
- **`lib-jitsi-meet` (LJM)** is the low-level conferencing library (XMPP signalling plus WebRTC):
  - **Pinned to a GitHub release tarball, not an npm version:** `https://github.com/jitsi/lib-jitsi-meet/releases/download/v2240.0.0+134a48af/lib-jitsi-meet.tgz` (`package.json:79`).
  - The lockfile records `version: "0.0.0"` with a sha512 integrity hash for that URL (`package-lock.json:14408-14411`).
  - `resources/update-ljm.sh:22-24` bumps the pin to the latest release.
  - **Web:** LJM is *not* bundled into the app. `make deploy` copies its UMD build into `libs/` (`Makefile:76-79`). `index.html` then loads it as its own `<script>` before the app bundle (`index.html:202`), and the code reads it from the global `JitsiMeetJS` (`react/features/base/lib-jitsi-meet/_.web.ts:1-3`).
  - **Native:** it is imported as a normal module (`react/features/base/lib-jitsi-meet/_.native.ts:6-7`).

Key framework versions:

| Dependency | Version | Source |
|---|---|---|
| react / react-dom | 19.2.3 | `package.json:86-87` |
| react-native | 0.85.2 | `package.json:92` |
| react-native-webrtc | 155.0.1 | `package.json:114` |
| redux / react-redux / redux-thunk | 4.0.4 / 7.2.9 / 2.4.1 | `package.json:123,118,124` |
| typescript | 5.7.2 | `package.json:191` |
| webpack / webpack-cli / webpack-dev-server | 5.105.0 / 5.1.4 / 5.2.6 | `package.json:193-196` |
| @types/react (pinned via `resolutions`) | 17.0.14 | `package.json:160,220-223` |
| Node / npm engines | `>=24` / `>=11` (`.nvmrc` = 24) | `package.json:198-201`, `.nvmrc:1` |

`.npmrc` sets `legacy-peer-deps=true`, with a FIXME saying it is pending an RN upgrade (`.npmrc:2-3`).

## 2. Repo layout

| Path | What lives there |
|---|---|
| `react/` | Almost all app code. Holds the entry files (`index.web.js`, `index.native.js`, `bootstrap.native.js`) and `features/`, with 88 feature folders (§4). |
| `modules/` | Older plain-JS modules: `API/` (in-app iframe API plus `external/` for the embedder library), `UI/`, `transport/`, `translation/`, `devices/`, `recorder/`, `screenshare-cast/`, `util/`. |
| `conference.js`, `app.js` | Web bootstrap and the legacy conference controller (§3). |
| `config.js`, `interface_config.js` | Default deployment config, shipped as templates (§5). |
| `index.html`, `base.html`, `head.html`, `body.html`, `fonts.html`, `title.html`, `plugin.head.html` | Main page plus server-side-include fragments (`index.html:3,8,12,198-214`). |
| `css/` | SCSS. `css/main.scss` compiles to `css/all.css` (`Makefile:17-19,133-136`). |
| `lang/` | i18next translations: `main.json` plus 60 `main-<lang>.json`. `languages.json` lists 61 languages. Includes the `update-translation.js` helper. |
| `static/` | Standalone HTML pages (close, prejoin, whiteboard, secondScreen, oauth, …) and `close3.js`. |
| `images/`, `fonts/`, `sounds/` | Static assets, installed by the Debian package (`debian/jitsi-meet-web.install`). |
| `resources/` | Deployment tooling, including `prosody-plugins/` (73 `mod_*.lua` Prosody modules), shell scripts (Let's Encrypt, coturn, JaaS registration, LJM/SDK version bumps) and `jenkins/run-grid-tests.sh`. |
| `android/`, `ios/` | Native apps and native SDKs (§9). |
| `react-native-sdk/` | Packaging for the `@jitsi/react-native-sdk` npm package (§9). |
| `twa/` | Android Trusted Web Activity wrapper for `meet.jit.si` (`twa/app/build.gradle:21-24`). |
| `metadata/` | Store listing text (`en-US`, `ru`). |
| `debian/` | Debian packaging (§10). |
| `doc/` | Mostly pointers to the Handbook (`doc/README.md`, `doc/api.md`, `doc/quick-install.md`). Also holds the files the Debian packages install (`doc/debian/`, `doc/jaas/`) and an iframe example (`doc/examples/api.html`). ESLint ignores this folder (`.eslintignore:8`). |
| `tests/` | WebdriverIO e2e suite, Prosody plugin tests and the Malleus load tester, each with its own `package.json` (§8). |
| `patches/` | `patch-package` patches applied on `postinstall` (`package.json:212`). |
| `.github/workflows/` | CI (§7). |
| `.eloqnt/`, `inlang.config.js` | i18n tooling config (`lint:i18n` runs `eloqnt lint`, `package.json:208`). |
| `.devcontainer/` | Codespaces/devcontainer definition. |
| `libs/`, `build/` | Not committed (`.gitignore:4,23`). `build/` holds webpack output and `libs/` the deploy output (§7). |

## 3. Entry points and bundles

### Web boot sequence

1. **`index.html`.** The server inlines `config.js` and `interface_config.js` with SSI (`index.html:198-199`). The page then loads, in order, `libs/preload.min.js`, `libs/lib-jitsi-meet.min.js` and `libs/app.bundle.min.js` (`index.html:201-203`).
2. **`preload` bundle** (`react/features/preload/preload.web.ts`). It starts fetching `config.js` (when not inlined), dynamic-branding data and custom icons while the app bundle is still downloading, and publishes them on `window.JitsiMeetPreload` (`preload.web.ts:13-27`). Web `loadConfig` reuses a preloaded result when the URL matches (`react/features/base/lib-jitsi-meet/functions.web.ts:15-28`).
3. **`app.js`**, the `app.bundle` entry (`webpack.config.js:370-371`):
   - exposes jQuery globally, with a FIXME to remove "this requirement from torture tests" (`app.js:3-7`), loads Olm for E2EE (`app.js:9,50-55`) and sets up jitsi-local-storage early (`app.js:43`);
   - builds `window.APP = { API, conference, translation, UI }` (`app.js:57-62`);
   - imports `./react` (`app.js:70`), which resolves to `react/index.web.js` because webpack tries `.web.js` first (`webpack.config.js:287-290`);
   - eagerly imports `custom.js`, a hook for forks (`app.js:72-74`).
4. **`react/index.web.js`** registers the React entry points `APP`, `PREJOIN`, `DIALIN` and `WHITEBOARD`. It exposes `renderEntryPoint`, which mounts them with `createRoot` (`react/index.web.js:68-93`).
5. **`conference.js`** (2,478 lines) is the legacy imperative controller (`export default {` at `conference.js:378`). Among its methods are `createInitialLocalTracks` (`:410`), `startConference` (`:486`), `init` (`:540`), `hangup` (`:2170`) and `leaveRoom` (`:2231`). It is started from Redux via `APP.conference.init(...)` (`react/features/conference/actions.web.ts:83`).

### Webpack bundles

`webpack.config.js:354-519` exports one config per bundle. Production output goes to `build/[name].min.js` and lazy chunks go to `build/chunks/` (`webpack.config.js:259-264`). The "size limit" column is the per-bundle webpack `performance` budget (§7).

| Bundle | Entry | Size limit | Notes |
|---|---|---|---|
| `app.bundle` | `./app.js` | 3.6 MiB | Carries the dev server config (`:369-393`) |
| `alwaysontop` | `./react/features/always-on-top/index.tsx` | 800 KiB | `:394-402` |
| `documentpip` | `./react/features/always-on-top/document-pip-index.tsx` | 800 KiB | `:416-424` |
| `close3` | `./static/close3.js` | 128 KiB | `:425-433` |
| `external_api` | `./modules/API/external/index.js` | 110 KiB | UMD library `JitsiMeetExternalAPI` (`:435-446`) |
| `preload` | `./react/features/preload/preload.web.ts` | 30 KiB | Built without core-js polyfills (`:56-90,447-457`) |
| `face-landmarks-worker` | `./react/features/face-landmarks/faceLandmarksWorker.ts` | 2 MiB | `:458-466` |
| `vb-inference-worker` | `./react/features/stream-effects/virtual-background/workers/VBInferenceWorker.ts` | 2 MiB | `:467-476` |
| `noise-suppressor-worklet` | `./react/features/stream-effects/noise-suppression/NoiseSuppressorWorklet.ts` | 2 MiB | `globalObject: 'AudioWorkletGlobalScope'` (`:477-507`) |
| `screenshot-capture-worker` | `./react/features/screenshot-capture/worker.ts` | 30 KiB | `:509-517` |
| `load-test-participant` | `./react/features/load-test/loadTestParticipant.ts` | 400 KiB | Built only when `BUILD_LOAD_TEST` is set (`npm run build:load-test`) (`:404-415`, `package.json:214`) |

`make deploy` copies every `.min.js` and `.map` above except the load-test one into `libs/` (`Makefile:49-74`). It also copies the wasm and model assets (Olm, TF wasm, RNNoise, TFLite, MediaPipe, face models, Excalidraw fonts) (`Makefile:76-131`).

### Native entry points

- `index.android.js` and `index.ios.js` each contain only `import './react/index.native'`.
- `react/index.native.js` imports `./bootstrap.native` first; that file loads polyfills and `react-native-gesture-handler` (`react/bootstrap.native.js:1-7`). It then registers the root component with `AppRegistry.registerComponent('App', …)` (`react/index.native.js:1-2,35`).
- The Android SDK bundles `--entry-file index.android.js` (`android/sdk/build.gradle:177`) and loads `assets://index.android.bundle` (`android/sdk/src/main/java/org/jitsi/meet/sdk/ReactHostHolder.java:233-236`). The iOS SDK asks for bundle root `index` (`ios/sdk/src/JitsiReactFactoryDelegate.m:28`).
- CI builds both platform bundles from `react/index.native.js` (`.github/workflows/ci.yml:75,114`).

## 4. Application architecture

### Feature folders

- `react/features/` has **88** top-level folders. Two of them are umbrella folders:
  - `base/` holds 42 shared sub-features: `redux`, `config`, `conference`, `tracks`, `participants`, `lib-jitsi-meet`, `i18n`, `ui`, …
  - `mobile/` holds 11 native-only ones: `audio-mode`, `call-integration`, `navigation`, `react-native-sdk`, …
- The code is almost all TypeScript: 1,969 `.ts`/`.tsx` files vs 18 `.js` files under `react/`.
- A typical feature (for example `react/features/chat/`) has `actionTypes.ts`, `actions.{any,web,native}.ts`, `reducer.ts`, `middleware.ts`, `functions.ts`, `constants.ts`, `logger.ts`, `types.ts` and a `components/` folder.

### Redux registry pattern

Features never import one another's reducers or middleware into a central store file. Each feature registers itself with a singleton registry as a side effect of being imported:

| Registry | Defined at | `register` | Used when the store is built |
|---|---|---|---|
| `ReducerRegistry` | `react/features/base/redux/ReducerRegistry.ts:13` (singleton `:62`) | `:54` (name → reducer) | `combineReducers()` `:37` |
| `MiddlewareRegistry` | `react/features/base/redux/MiddlewareRegistry.ts:9` (singleton `:53`) | `:45` | `applyMiddleware(...)` `:33` |
| `StateListenerRegistry` | `react/features/base/redux/StateListenerRegistry.ts:81` (singleton `:186`) | `:138` (selector + listener) | `subscribe(store)` `:159` |
| `PersistenceRegistry` | `react/features/base/redux/PersistenceRegistry.ts:25` (singleton `:241`) | `:101` (subtree → localStorage/AsyncStorage) | `getPersistedState()` `:38`. Writes are throttled to 2 s (`react/features/base/redux/middleware.ts:11,16`) |

- **Store creation:** `BaseApp._createStore()` combines all registered reducers. It applies every registered middleware plus redux-thunk, seeds the store from persisted state and subscribes state listeners (`react/features/base/app/components/BaseApp.tsx:245-260`).
- **Example registrations:** `ReducerRegistry.register<IChatState>('features/chat', …)` (`react/features/chat/reducer.ts:89`), `MiddlewareRegistry.register(...)` (`react/features/chat/middleware.ts:110`) and `StateListenerRegistry.register(...)` (`react/features/chat/middleware.ts:533`).
- **Scale:**
  - 88 `ReducerRegistry.register` calls in `.ts` files.
  - 116 files that call `MiddlewareRegistry.register`.
  - 106 `StateListenerRegistry.register` call sites.
  - `IReduxState` declares **89** `'features/…'` slices (`react/features/app/types.ts:95-185`).

### Per-platform aggregation

- The web root component imports `'../middlewares'` and `'../reducers'` (`react/features/app/components/App.web.tsx:13-14`), which resolve to the `.web.ts` files. The native root imports `'../middlewares.native'` and `'../reducers.native'` (`react/features/app/components/App.native.tsx:23-24`).
- Each platform file imports its platform-only features and then the shared list:

| File | Feature imports | Then imports |
|---|---|---|
| `react/features/app/middlewares.any.ts` | 59 | — |
| `react/features/app/middlewares.web.ts` | 30 | `./middlewares.any` (`:32`) |
| `react/features/app/middlewares.native.ts` | 17 | `./middlewares.any` (`:19`) |
| `react/features/app/reducers.any.ts` | 61 | — |
| `react/features/app/reducers.web.ts` | 22 | `./reducers.any` |
| `react/features/app/reducers.native.ts` | 6 | `./reducer.native`, `./reducers.any` |

A feature that is not imported, directly or through these files, never registers and so never runs.

### Platform-specific module resolution

- **Suffix counts under `react/`:** 237 `*.web.*`, 174 `*.native.*`, 75 `*.any.*`, plus 4 `.ios.*`/`.android.*` files (in `base/sounds` and `base/testing`). There are 49 `web/` and 41 `native/` component directories.
- **Webpack (web)** tries `.web.js`, `.web.ts` and `.web.tsx` before the plain extensions (`webpack.config.js:287-299`).
- **TypeScript:**
  - `tsconfig.web.json` uses `moduleSuffixes: [".web", ""]` (`:17`). It excludes `**/mobile/*`, `**/native/*`, `*.native.ts(x)`, `*.ios.ts`, `*.android.ts` and `react/features/share-room` (`:19-28`).
  - `tsconfig.native.json` uses `moduleSuffixes: [".native", ".ios", ".android", ""]` (`:17`). It excludes `**/web/*`, `*.web.ts(x)` and 19 web-only feature folders (always-on-top, e2ee, face-landmarks, virtual-background, whiteboard, …) (`:19-44`).
  - Both are `strict`. Targets differ: web uses `es2024` and native uses `es2020` (`tsconfig.web.json:6`, `tsconfig.native.json:6`).
- **Babel:** webpack runs Babel with `configFile: false`, because "we only use [babel.config.js] for React Native" (`webpack.config.js:158-159`). The RN Babel config is `babel.config.js`; the Metro config (`metro.config.js`) adds the SVG transformer.

## 5. Configuration

- **`config.js`** (2,189 lines) declares `var config = {…}` (`config.js:27`). It starts with nginx SSI `echo` placeholders for `subdir`/`subdomain`, used for multi-tenant paths (`config.js:8-23`). It ends with JaaS defaults gated on `enableJaaS` (`config.js:25,2185-2189`). The header asks contributors to document new options in the Handbook configuration page (`config.js:3-6`).
- **`interface_config.js`** declares `var interfaceConfig = {…}` and calls itself "deprecated. All options will eventually be moved to config.js" (`interface_config.js:4-11`).
- **How config is loaded:**
  - **Web:** nginx serves `/config.js` from `/etc/jitsi/meet/<host>-config.js` with `ssi on` (`doc/debian/jitsi-meet/jitsi-meet.example:88,98,112-113`), and `index.html` inlines it (`index.html:198`). When it has to be fetched instead, it is parsed in a worker (`react/features/base/lib-jitsi-meet/functions.web.ts:30-40`).
  - **Native:** the app downloads `config.js` and evaluates it in a worklet context (`react/features/base/lib-jitsi-meet/functions.native.ts:24-60`).
- **Overrides via URL hash.** `setConfig` calls `setConfigFromURLParams` with the location URL (`react/features/base/config/actions.ts:97-115`). Hash parameters such as `#config.p2p.enabled=false&interfaceConfig.X=…` are turned into nested objects and passed to `overrideConfigJSON` (`react/features/base/config/functions.any.ts:314-350,159-185`). Arrays are replaced rather than merged (`functions.any.ts:176-181`).
- **Whitelisting.** `getWhitelistedJSON` keeps only whitelisted keys, using lodash `pick` (`functions.any.ts:198-213`). In dev builds (`__DEV__`) it **disables** whitelisting and accepts any override (`functions.any.ts:200-204`). The lists are:

| List | Location | Size |
|---|---|---|
| `config` whitelist | `react/features/base/config/configWhitelist.ts:15-272` | about 214 keys. Whitelisting a key also allows its sub-properties (`:6-13`). |
| Deploy-specific extra config keys | `react/features/base/config/extraConfigWhitelist.ts` | empty, meant for forks |
| Extra keys when embedded (iframe or SDK) | `react/features/base/config/isEmbeddedConfigWhitelist.ts` | 4 keys (`customToolbarButtons`, `defaultLogoUrl`, `deploymentUrls`, `liveStreaming`) |
| `interfaceConfig` whitelist | `react/features/base/config/interfaceConfigWhitelist.ts:12-57` | 44 keys, plus `extraInterfaceConfigWhitelist.ts` and `isEmbeddedInterfaceConfigWhitelist.ts` |

  On web, "embedded" means `window.self !== window.top` (`react/features/base/util/embedUtils.web.ts:6-12`).
- **`configOverwrite` from the iframe API uses the same path.** `JitsiMeetExternalAPI` builds the iframe URL with `urlObjectToString(...)` (`modules/API/external/external_api.js:314-327`). That function serializes `configOverwrite`, `interfaceConfigOverwrite`, `devices`, `userInfo` and so on into `#config.*`, `#interfaceConfig.*`, … hash parameters (`react/features/base/util/uri.ts:593-610`). Iframe overrides are therefore subject to the same whitelists.
- **The 🚫 marker.** The Handbook says "Options marked with 🚫 are not overwritable through `configOverwrite`" ([configuration](https://jitsi.github.io/handbook/docs/dev-guide/dev-guide-configuration), source `docs/dev-guide/configuration.md:10`). The marker exists only in the Handbook (no 🚫 appears in `config.js`). In code, whether an option can be overridden is decided by the whitelists above.

## 6. External / iframe API

There are two halves that talk over `postMessage`:

| Side | Code |
|---|---|
| **Embedder library** (runs on the host page; the `external_api` bundle) | `modules/API/external/index.js` re-exports `external_api.js` as UMD `JitsiMeetExternalAPI` (`index.js:1-3`, `webpack.config.js:435-441`). Class at `external_api.js:253`. **75** command mappings (`:30-107`) and **82** event mappings (`:113-196`). |
| **In-app endpoint** (runs inside the iframe; part of `app.bundle`) | `modules/API/API.js` (2,731 lines): `initCommands()` (`:196`), `class API` (`:1358`), singleton (`:2731`). It is exposed as `window.APP.API` (`app.js:57-62`). |

- **Wiring:**
  1. The embedder builds the iframe URL `https://<domain>/#jitsi_meet_external_api_id=<n>` (`external_api.js:327`). It opens a `Transport` over `PostMessageTransportBackend`, using scope `jitsi_meet_external_api_<n>` and the iframe origin as `allowedOrigin` (`external_api.js:332-341`).
  2. Inside the app, `modules/API/constants.js:15-19` reads `jitsi_meet_external_api_id` from the URL. `modules/transport/index.js:19-43` builds a `Transport` with the matching scope. Both sides use `Transport` from `@jitsi/js-utils/transport` (`modules/transport/index.js:3`).
  3. The API only enables itself if that id is present or the URL carries a JWT (`API.js:1288-1297`). It is initialized from `react/features/base/app/actions.ts:27`.
  4. **Commands** (host → app): `transport.on('event', …)` looks up `commands[name]` and calls it (`API.js:1060-1068`). Requests with callbacks are handled by `transport.on('request', …)` (`API.js:1070`).
  5. **Events** (app → host): `API.js` has 84 `notify*` methods. They call `_sendEvent`, which calls `transport.sendEvent` (`API.js:1454-1457`). Redux middleware calls them, for example `APP.API.notifyDominantSpeakerChanged` (`react/features/external-api/middleware.ts:51`).
- **Docs:** `doc/api.md` is a 3-line pointer to the Handbook page [IFrame API](https://jitsi.github.io/handbook/docs/dev-guide/dev-guide-iframe) (`doc/api.md:3`). That page tells embedders to load `https://<your-domain>/external_api.js` and call `new JitsiMeetExternalAPI(domain, options)` with `configOverwrite`/`interfaceConfigOverwrite` (source `docs/dev-guide/iframe.md:29,59,88-90,137`). The nginx template serves `/external_api.js` (`doc/debian/jitsi-meet/jitsi-meet.example:116`). A minimal example is in `doc/examples/api.html:7,18`.
- **Mobile:** the native SDKs have their own bridge in `react/features/mobile/external-api/` (registered in `middlewares.native.ts:8`).
- **Tests:** 16 iframe specs in `tests/specs/iframe/`, with the page object `tests/pageobjects/IframeAPI.ts`.

## 7. Build, dev and quality tooling

### Makefile

`make` with no target runs `all` (the first target).

| Target | What it does |
|---|---|
| `all` | `compile` then `deploy` (`Makefile:28`) |
| `typecheck` | `npm run tsc:web`. Type checking runs once here instead of in ts-loader (`Makefile:30-33`). |
| `compile` | `clean` + `typecheck`, then `webpack` with `--max-old-space-size=4096` (`Makefile:35-37`) |
| `clean` | `rm -fr build` (`Makefile:39-40`) |
| `deploy` | Rebuilds `libs/` from `build/` plus LJM, wasm and models, then compiles CSS. Runs `./deploy-local.sh` if present (`Makefile:43,45-139`). |
| `dev` | Deploys assets and CSS, then runs `webpack serve --mode development` (`Makefile:142-143`). `npm start` is an alias (`package.json:213`). |
| `source-package` | `compile deploy`, then tars the web root into `jitsi-meet.tar.bz2` (`Makefile:145-150`) |

### npm scripts (root `package.json:203-219`)

- **Lint:**
  - `lint` = ESLint plus a bare `tsc --noEmit` (`:206`).
  - `lint:ci` = ESLint with `--max-warnings 0` (`:207`).
  - `lint-fix` (`:211`).
- **Type checking:** `tsc:web`, `tsc:native` and `tsc:ci` (both) (`:215-217`).
- **i18n:** `lint:lang` (jsonlint each `lang/*.json`), `lint:i18n` (`eloqnt lint`) and `lang-sort` (`:208-210`).
- **Other:** `build:load-test` (`:214`) and `validate` (`npm ls`) (`:218`).
- **`postinstall`:** runs `patch-package --error-on-fail`, `jetify`, an Android CMake cache clean and Android autolinking generation (`:212`).
- **There are no `test` scripts in the root `package.json`** (see §8).

ESLint config is just `extends: ['@jitsi/eslint-config']` (`.eslintrc.js:1-5`; version 6.0.4, `package.json:146`). `.eslintignore` skips `build/`, `doc/`, `libs/`, `resources/`, vendor folders, `actionTypes.ts`, `react-native-sdk/` and `*.d.ts`.

### Webpack and the dev server

- **Dev server:**
  - Proxies to `WEBPACK_DEV_SERVER_PROXY_TARGET`, default `https://alpha.jitsi.net` (`webpack.config.js:14-15,330-340`).
  - Serves CSS, fonts, images, lang, sounds, static, wasm and `libs/` locally (`webpack.config.js:101-134`).
  - Uses HTTPS on `localhost` (plain HTTP under Codespaces) with HMR (`webpack.config.js:327-341`).
  - No port is set, so the webpack-dev-server default applies. The e2e dev config assumes `https://localhost:8080` (`tests/wdio.dev.conf.ts:2-3,10`).
- **TypeScript in webpack** uses `ts-loader` with `transpileOnly: true`. Types are checked only by `tsc` (`webpack.config.js:233-246`, `Makefile:30-33`).
- **Babel targets** are Chrome 80, Electron 10, Firefox 68 and Safari 14, with core-js 3.40 "usage" polyfills (`webpack.config.js:173-188`).
- **Environment variables:**
  - `ANALYZE_BUNDLE` writes `build/<name>-stats.json` through webpack-bundle-analyzer (`webpack.config.js:44-53,355`).
  - `DETECT_CIRCULAR_DEPS` enables `circular-dependency-plugin` with `failOnError: false` (`webpack.config.js:267-272,359`).

### Bundle-size enforcement

`getPerformanceHints(options, size)` sets webpack `performance.maxAssetSize` and `maxEntrypointSize` per bundle. Hints are `'error'` in production builds unless `ANALYZE_BUNDLE` is set (`webpack.config.js:27-35`). The limits are inline in each bundle's config (table in §3). Raising a budget means editing `webpack.config.js`.

### CI (`.github/workflows/`)

| Workflow | Trigger | What it runs |
|---|---|---|
| `ci.yml` "Simple CI" | `pull_request` | **lint:** lang checks if `lang/` changed, then `npm run lint:ci && npm run tsc:ci` (`:28-39`). **frontend:** `make` + `node config.js` on macOS and Ubuntu (`:40-60`). RN bundle builds for Android and iOS (`:61-114`). Android SDK `assembleRelease` (`:115-154`). iOS SDK xcframework (`:155-213`). RN SDK dependency sync (`:214-231`). `dpkg-buildpackage` + `make source-package` (`:232-249`). |
| `ci-lua.yml` | `pull_request` | `luacheck` over the Lua code (`.luacheckrc`) |
| `prosody-plugin-tests.yml` | push to master or PR touching `resources/prosody-plugins/**` or `tests/prosody/**` | `npm test` in `tests/prosody` (`:3-42`) |
| `pr-torture-trigger.yml` → `pr-torture.yml` | PR events, "ok to test" / "test this please" comments, manual dispatch | Authorizes against two org teams (`pr-torture-trigger.yml:1-10`). Runs e2e tests on a self-hosted `pr-torture` runner using scripts cloned from `jitsi/jitsi-pr-testing-scripts` (`pr-torture.yml:96-128`). |
| `release-rnsdk.yml` | manual dispatch | `npm publish` of the RN SDK (`:1-64`) |
| `cla.yml`, `stale.yml` | — | Not reviewed for this report |

## 8. Testing

The repo has three separate test suites, each with its own `package.json`. None of them is wired into the root `package.json`.

### WebdriverIO end-to-end suite (`tests/`)

- **Install and scripts.** `tests/package.json` describes itself as a "Standalone WebdriverIO runner… Installing here (npm install, from this directory) only pulls in the wdio-side runtime dependencies" (`tests/package.json:5`). It uses WebdriverIO 9.27.0 with the mocha framework (`:19-38`). Scripts (`:6-17`):
  - `test` and `test-single`;
  - `test-ff` and `test-ff-single` (Firefox);
  - `test-dev` and `test-dev-single` (against local `make dev`);
  - `test-grid` and `test-grid-ff` (Selenium Grid);
  - `malleus`.

  All of them read `tests/.env` (`DOTENV_CONFIG_PATH=.env`). Settings are documented in `tests/env.example`, which has 53 commented variables, for example `BASE_URL`, `GRID_HOST_URL`, `HEADLESS`, JaaS keys and `MAX_INSTANCES`.
- **Config (`tests/wdio.conf.ts`):**
  - Specs come from `specs/**/*.spec.ts` (`:67-68`).
  - The run is multiremote: up to six participant browsers `p1`…`p6` (`:77`). Chrome is the default (`:186`); Firefox comes from `tests/wdio.firefox.conf.ts:43`.
  - `MAX_INSTANCES` defaults to 1 (`:361`) and `BASE_URL` defaults to `https://alpha.jitsi.net/torture/` (`:363`).
  - The mocha timeout is 180 s (`:378-379`). Reporters are JUnit and Allure (`:405-419`).
  - Specs that require JaaS are excluded when JaaS isn't configured (`:164-166`).
- **Specs by area (79 total):**

| Area (`tests/specs/…`) | Spec files |
|---|---|
| `iframe/` | 16 |
| `jaas/` (including `dial/` 3 and `visitors/` 4) | 19 |
| `media/` | 11 |
| `misc/` | 17 |
| `moderation/` | 5 |
| `ui/` | 11 |

  Support code: 23 page objects in `tests/pageobjects/`, 14 helpers in `tests/helpers/`, and shared spec helpers in `tests/specs/helpers/`. Only Chrome and Firefox capabilities are configured; no spec drives the native iOS or Android apps.
- **Grid runs.** `resources/jenkins/run-grid-tests.sh` runs `npm install`, then `npm run test-grid` and `npm run test-grid-ff`, from `tests/` (`:42-58`).

### Prosody plugin tests (`tests/prosody/`)

- 49 JS integration specs (`*_spec.js`) run with mocha + testcontainers against Prosody 13 in Docker (`tests/prosody/README.md:1-25`).
- 14 Lua unit specs run with `busted` (`tests/prosody/lua/`).
- Scripts are `test`, `test:lua`, `test:integration` and `test:one` (`tests/prosody/package.json:6-13`). CI is `prosody-plugin-tests.yml`.

### Malleus load tester (`tests/malleus/`)

- A browser-driven load generator that reuses the wdio setup (`tests/malleus/README.md:1-5`).
- It is run with `npm run malleus` from `tests/`.
- With `--use-load-test` it uses the lightweight `load-test-participant` bundle (`webpack.config.js:404-415`).

## 9. Mobile

- **Shared JS.** The mobile apps run the same `react/features` code through `react/index.native.js` (§3). Native-only features live in `react/features/mobile/`.
- **Android (`android/`).**
  - Gradle modules are `:app` and `:sdk` (`android/settings.gradle:4`).
  - The build requires `node_modules/.jitsi/autolinking.json` from `npm run android-autolinking` (`android/settings.gradle:18-22`, `package.json:204`).
  - `LIBRE_BUILD` excludes non-free RN modules: Amplitude, Giphy and Google Sign-In (`android/settings.gradle:8-13,25`).
  - SDK classes are in `android/sdk/src/main/java/org/jitsi/meet/sdk/` (`JitsiMeetActivity`, `JitsiMeetView`, `JitsiMeetConferenceOptions`, …). The app id is `org.jitsi.meet` (`android/app/build.gradle:21`).
- **iOS (`ios/`).**
  - CocoaPods targets are `JitsiMeet`, `JitsiMeetSDK` and `JitsiMeetSDKLite` (`ios/Podfile:70,77,105`).
  - The workspace is `ios/jitsi-meet.xcworkspace`, and SDK sources are in `ios/sdk/src/`.
  - `react-native.config.js:6-24` turns off iOS autolinking for Giphy, Google Sign-In and calendar-events.
- **Docs.** `android/README.md` and `ios/README.md` only point to the Handbook SDK pages.
- **React Native SDK (`react-native-sdk/`).**
  - It is published as `@jitsi/react-native-sdk` (`react-native-sdk/package.json:2`).
  - It exports a `JitsiMeeting` component (`react-native-sdk/index.tsx:69`) built on the same `App.native` (`index.tsx:19`).
  - Dependency versions are `0.0.0` placeholders. `update_sdk_dependencies.js` fills them from the root `package.json` (`react-native-sdk/update_sdk_dependencies.js:14-19,59`).
  - The `prepare` script (`prepare_sdk.js`) copies `../images`, `../sounds`, `../lang`, `../modules`, `../react` and the Android/iOS SDK sources into the package (`react-native-sdk/prepare_sdk.js:4-9,55-194`).
  - It is released by `release-rnsdk.yml`. The Handbook's consumer instructions say to run `npm i @jitsi/react-native-sdk`, then `update_dependencies.js` ([React Native SDK](https://jitsi.github.io/handbook/docs/dev-guide/dev-guide-react-native-sdk), source `docs/dev-guide/react-native-sdk.md:16-20`).

## 10. Packaging and deployment (Debian)

`debian/control` defines source `jitsi-meet-web` and five binary packages:

| Package | Depends on (abridged) | Installs / configures |
|---|---|---|
| `jitsi-meet-web` | — | The static web root in `/usr/share/jitsi-meet/`: `*.html`, `libs`, `static`, `css/all.css`, `sounds`, `fonts`, `images`, `lang`, `interface_config.js`, `pwa-worker.js`, `manifest.json`, plus `resources/*.sh` as scripts (`debian/jitsi-meet-web.install:1-15`). `debian/rules` also adds per-language `countries-*.json` (`debian/rules:6-31`). |
| `jitsi-meet-web-config` | Pre-Depends on nginx, openresty or apache2; openssl, curl (`debian/control:21-24`) | Ships the `config.js` template and the nginx/apache site templates (`debian/jitsi-meet-web-config.install:1-6`). The postinst copies `config.js` to `/etc/jitsi/meet/<host>-config.js` (`debian/jitsi-meet-web-config.postinst:138-140`). It installs the nginx site into `sites-available` and links it (`:183,200-202`), or the apache site (`:237-242`). It offers a self-signed cert (`:115`) or Let's Encrypt (`:264`). |
| `jitsi-meet-prosody` | prosody ≥ 0.12 or 13.0, lua-sec, lua-cjson, … (`debian/control:35-37`) | `resources/prosody-plugins/` → `/usr/share/jitsi-meet/prosody-plugins` (`debian/jitsi-meet-prosody.install:3`). The postinst writes `/etc/prosody/conf.avail/<host>.cfg.lua` from `prosody.cfg.lua-jvb.example` and links it into `conf.d` (`debian/jitsi-meet-prosody.postinst:111-124`). It sets up the `focus` user on `auth.<host>` (`:47,58`), an internal MUC for jicofo/jvb (`:141-150`) and a TURN secret (`:72-76`). |
| `jitsi-meet-tokens` | jitsi-meet-prosody | Prosody token (JWT) auth setup (`debian/control:49-52`) |
| `jitsi-meet-turnserver` | coturn, jitsi-meet-prosody | coturn config (`debian/jitsi-meet-turnserver.install:1-2`) |

- **Prosody template** (`doc/debian/jitsi-meet-prosody/prosody.cfg.lua-jvb.example`):
  - Sets `plugin_paths` to the installed plugins (`:4`).
  - Virtual hosts: the main domain (`:47`), `auth.` (`:130`) and `recorder.` (`:138`).
  - MUC components: `conference.`, `breakout.`, `internal.auth.` and `lobby.` (`:84,102,117,161`).
  - `focus.` is a `client_proxy` component (`:146`). There are also feature components for speakerstats, end-conference, AV moderation, file sharing, room metadata and polls (`:149-175`).
- **nginx template** (`doc/debian/jitsi-meet/jitsi-meet.example`):
  - Serves the web root with SSI (`:93,98`) and proxies the routes listed in §1.
  - Handles per-tenant paths: `/<tenant>/config.js`, `/<tenant>/http-bind`, … (`:207-249`). HEAD's commit `da51f16` changed this file.
- **What is not here.** The Handbook quickstart installs everything with `sudo apt install jitsi-meet` and uninstalls `jigasi jitsi-meet jitsi-meet-web-config jitsi-meet-prosody jitsi-meet-turnserver jitsi-meet-web jicofo jitsi-videobridge2` ([quickstart](https://jitsi.github.io/handbook/docs/devops-guide/devops-guide-quickstart), source `docs/devops-guide/quickstart.md:180,271`). The `jitsi-meet` meta-package, `jicofo` and `jitsi-videobridge2` are not defined in this repo's `debian/control`.
- **CI** checks that the packages build with `dpkg-buildpackage -A` (`.github/workflows/ci.yml:246-248`).

## 11. Discrepancies

### In `CLAUDE.md`

| CLAUDE.md says | What the code shows |
|---|---|
| Testing: `npm test`, `npm run test-single -- <spec>`, `npm run test-dev`, `npm run test-dev-single` | The root `package.json` has no `test*` scripts (`package.json:203-219`). They exist only in `tests/package.json:7-12`, and you run them from `tests/` after `npm install` there (`tests/package.json:5`; `resources/jenkins/run-grid-tests.sh:42-49`). The same stale "`npm test` from the repo root" wording is in `tests/env.example:4-5`. |
| Bundle list: app, external_api, alwaysontop, close3, face-landmarks-worker, noise-suppressor-worklet, screenshot-capture-worker | Also missing `documentpip`, `preload` and `vb-inference-worker` (all deployed, `Makefile:57-68`), plus the opt-in `load-test-participant` (`webpack.config.js:404-457,467-476`). |
| "Import middleware in `react/features/app/middlewares.{any,native,web}.js`" | The files are `.ts`: `react/features/app/middlewares.{any,web,native}.ts`. |
| "`./modules/external-api` – External API" | No such folder. The code is in `modules/API/external/` (embedder) and `modules/API/API.js` (in-app). The Handbook architecture page has the same stale path (`docs/architecture.md:43-44`). |
| "Strict TypeScript settings with ES2024 target" | True only for web (`tsconfig.web.json:6`). Native targets `es2020` (`tsconfig.native.json:6`). |
| "83+ feature modules" | 88 top-level folders under `react/features/`. |
| "`libs/` – Compiled output directory" | Webpack writes to `build/` (`webpack.config.js:262`). `libs/` is the `make deploy` target (`Makefile:3,45-74`), is gitignored (`.gitignore:4`) and isn't in the checkout. |
| Bundle analysis: `npx webpack -p --analyze-bundle` | The config turns analysis on only through the `ANALYZE_BUNDLE` env var (`webpack.config.js:355`); `argv` is read only for `mode` (`:356`). The command comes from the Handbook contributing page (`docs/dev-guide/contributing.md:189-198`). Whether webpack-cli 5.1.4 accepts `-p` and `--analyze-bundle` was not checked. |
| "Tests run automatically for project member PRs via Jenkins"; "Tests cover peer-to-peer, invites, iOS, Android, and web" | These match the Handbook's description of the **separate** `jitsi-meet-torture` repo (`docs/architecture.md:59-63`). In this repo, PR e2e runs are triggered by the GitHub Actions `PR torture` workflows on a self-hosted runner (§7). The in-repo suite configures only Chrome and Firefox and has no native-app specs (§8). |
| "Options marked 🚫 are not overwritable through `configOverwrite`" | Accurate as a description of the Handbook, but the 🚫 marker isn't in the repo. In code, overridability comes from the whitelists, which are disabled in dev builds (`react/features/base/config/functions.any.ts:198-213`). |
| Conventional Commits with mandatory scopes | This is Handbook policy (`docs/dev-guide/contributing.md:71-76`). Nothing in the repo enforces it: there is no commitlint or husky config. 45 of the last 50 commit subjects follow `type(scope):`. Exceptions include `lang: Update Azerbaijani localization` (`23d4f22`). |

### In `README.md`

Nothing contradicts the code. It is upstream's README: it links upstream assets, meet.jit.si and the app-store listings, and says nothing about this fork. "A comprehensive Docker setup" (`README.md:49`) refers to something outside this repo.

### Other in-repo docs found to be stale

- `react/features/base/redux/README.md:34` points to `react/features/base/storage/middleware.js#PERSIST_STATE_DELAY`. There is no `base/storage` feature; the constant is at `react/features/base/redux/middleware.ts:11`.
- `CONTRIBUTING.md` tells contributors to run `npm run lint`, which ends with a bare `tsc --noEmit` (`package.json:206`). No root `tsconfig.json` is committed (it is gitignored, `.gitignore:101`). The devcontainer creates one by copying `tsconfig.web.json` (`.devcontainer/devcontainer.json:14`). CI uses `lint:ci` + `tsc:ci` instead (`.github/workflows/ci.yml:39`).
- `.devcontainer/devcontainer.json:5-6` installs the Node feature at version `"20"`, but `.nvmrc` is `24` and `engines.node` is `>=24` (`package.json:199`).

## 12. Not verified

- How a bare `tsc --noEmit` behaves without a root `tsconfig.json`, and whether webpack-cli 5.1.4 accepts the Handbook's `-p --analyze-bundle` flags. Nothing was run, per the read-only scope.
- The rendered Handbook site (`jitsi.github.io`) could not be reached. Its content was read from the `jitsi/handbook` Markdown sources on `master` at research time, which may differ slightly from the published site.
- Runtime behaviour (P2P vs JVB, mobile TLS requirements and so on) was not exercised. `CLAUDE.md`'s "Common Issues and Debugging" section was not checked against code and is not repeated here.
- `cla.yml` and `stale.yml` were not read.

## 13. Sources

**Repository files**:
- Root files: `package.json`, `package-lock.json`, `Makefile`, `webpack.config.js`, `tsconfig.web.json`, `tsconfig.native.json`, `babel.config.js`, `metro.config.js`, `react-native.config.js`, `.eslintrc.js`, `.eslintignore`, `.gitignore`, `.nvmrc`, `.npmrc`, `.devcontainer/devcontainer.json`, `README.md`, `CONTRIBUTING.md`, `CLAUDE.md`, `LICENSE`
- Web and native entry files: `app.js`, `index.html`, `conference.js`, `config.js`, `interface_config.js`, `custom.js`, `index.android.js`, `index.ios.js`, `react/index.web.js`, `react/index.native.js`, `react/bootstrap.native.js`
- Redux: `react/features/base/redux/{ReducerRegistry,MiddlewareRegistry,StateListenerRegistry,PersistenceRegistry,middleware}.ts`, `react/features/base/redux/README.md`, `react/features/base/app/components/BaseApp.tsx`, `react/features/base/app/actions.ts`
- App aggregation: `react/features/app/{middlewares.any,middlewares.web,middlewares.native,reducers.any,reducers.web,reducers.native,reducer.native,types}.ts`, `react/features/app/components/App.{web,native}.tsx`
- Feature examples: `react/features/chat/{reducer,middleware}.ts`, `react/features/conference/actions.web.ts`, `react/features/external-api/middleware.ts`, `react/features/preload/preload.web.ts`
- Config and LJM: `react/features/base/config/{actions,functions.any,configWhitelist,extraConfigWhitelist,isEmbeddedConfigWhitelist,interfaceConfigWhitelist,extraInterfaceConfigWhitelist}.ts`, `react/features/base/util/{uri,embedUtils.web}.ts`, `react/features/base/lib-jitsi-meet/{_.web,_.native,functions.web,functions.native}.ts`, `resources/update-ljm.sh`
- iframe API: `modules/API/{API,constants}.js`, `modules/API/external/{index,external_api}.js`, `modules/transport/index.js`
- Docs: `doc/README.md`, `doc/api.md`, `doc/quick-install.md`, `doc/examples/api.html`
- Debian: `debian/{control,rules,changelog,*.install,jitsi-meet-web-config.postinst,jitsi-meet-prosody.postinst}`, `doc/debian/jitsi-meet/jitsi-meet.example`, `doc/debian/jitsi-meet-prosody/prosody.cfg.lua-jvb.example`
- Tests: `tests/{package.json,wdio.conf.ts,wdio.dev.conf.ts,wdio.firefox.conf.ts,wdio.grid.conf.ts,env.example}`, `tests/prosody/{package.json,README.md}`, `tests/malleus/README.md`, `resources/jenkins/run-grid-tests.sh`
- CI: `.github/workflows/{ci,ci-lua,prosody-plugin-tests,pr-torture-trigger,pr-torture,release-rnsdk}.yml`
- Mobile: `android/settings.gradle`, `android/app/build.gradle`, `android/sdk/build.gradle`, `android/sdk/src/main/java/org/jitsi/meet/sdk/ReactHostHolder.java`, `ios/Podfile`, `ios/sdk/src/JitsiReactFactoryDelegate.m`, `android/README.md`, `ios/README.md`, `react-native-sdk/{package.json,index.tsx,prepare_sdk.js,update_sdk_dependencies.js,README.md}`, `twa/app/build.gradle`

**Official Jitsi Handbook** (published URL; source read from `https://raw.githubusercontent.com/jitsi/handbook/master/docs/…`)
- Architecture: https://jitsi.github.io/handbook/docs/architecture (source `docs/architecture.md`)
- IFrame API: https://jitsi.github.io/handbook/docs/dev-guide/dev-guide-iframe (source `docs/dev-guide/iframe.md`)
- Configuration: https://jitsi.github.io/handbook/docs/dev-guide/dev-guide-configuration (source `docs/dev-guide/configuration.md`)
- Self-hosting quickstart: https://jitsi.github.io/handbook/docs/devops-guide/devops-guide-quickstart (source `docs/devops-guide/quickstart.md`)
- Contributing: https://jitsi.github.io/handbook/docs/dev-guide/dev-guide-contributing/ (source `docs/dev-guide/contributing.md`)
- React Native SDK: https://jitsi.github.io/handbook/docs/dev-guide/dev-guide-react-native-sdk (source `docs/dev-guide/react-native-sdk.md`)

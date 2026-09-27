# Hub Frontend

The hub serves `hub/public/index.html`, `hub.js`, and `hub.css` at its central origin. The root shows login, invitation registration, and an authenticated list of the current account's devices. Pairing and invitation secrets remain in page memory only. Failed network mutations are reconciled with a read; the frontend never repeats a mutation automatically.

Each device opens `/devices/:UUID/`. Serve the existing `public/index.html` and its allowed assets under that prefix. Device context helpers are exported by the existing `connection.js` so an active temporary gateway does not need a new asset allowlist. The index and dynamically loaded panel styles use relative asset URLs. Before creating panels or reading browser state, the app authenticates `GET /devices/:UUID/context`, which returns `user.id`, `device.id`, `device.name`, `device.online`, and `mode: "hub"`.

`createDeviceContext` wraps explicit injected fetch and storage dependencies. API requests, file previews, uploads, archives, recovery settings, and receipt checks remain under the immutable device prefix. Browser keys are scoped by authenticated account ID and device ID. Standalone access retains the existing keys and API paths. No global fetch or storage implementation is changed.

Device pages display the device name and a link back to the central device list. Login expiry preserves drafts, blocks mutations, and directs the user to central login. Offline devices reject new mutations while reads can detect a reconnect. Backend denials before delivery should use `DEVICE_OFFLINE`; uncertain transport outcomes must use a different code so existing receipt recovery remains active.

Relevant checks: `test/hub-ui.test.mjs`, `test/device-scope-ui.test.mjs`, and existing UI, upload, file, access, and connection tests. DOM checks do not establish browser visual quality.

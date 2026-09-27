# App-server protocol probe

Probe date: 2026-09-25. Local CLI: `codex-cli 0.156.1`.

## Evidence collected

- `codex app-server --help` advertises `stdio://` (default), `unix://`, `unix://PATH`, `ws://IP:PORT`, and `off` transports. `codex app-server proxy --help` describes a stdio-byte proxy to an already running app-server Unix control socket (`--sock`). The help also exposes daemon management commands, including `start`, `enable-remote-control`, and `disable-remote-control`.
- Generated experimental TypeScript and JSON Schema bundles are in the project's [`work/codex-probe/schema`](../work/codex-probe/schema). They were generated locally with `codex app-server generate-ts --experimental` and `generate-json-schema --experimental`; no app-server was started and no model task was run. These intermediate generated files are not included in the source delivery archive.
- Official documentation, read 2026-09-25: [Codex App Server](https://learn.chatgpt.com/docs/app-server) and its [Markdown form](https://learn.chatgpt.com/docs/app-server.md). It describes app-server as the interface for rich/custom clients, including authentication, conversation history, approvals, and streamed events. This is documentation for the general protocol, not evidence that the desktop's own server is exposed to arbitrary clients.
- The graph service had no project for this newly created bridge directory; its listed projects were unrelated. The generated schema was read directly.

## Findings by capability

| Capability | Protocol evidence | Practical reading |
| --- | --- | --- |
| Read a thread | `thread/read` takes `threadId` and optional `includeTurns`. Docs say it reads stored data without resuming. | Suitable for inspection; it does not itself attach to live execution. Prefer paginated turn/item reads for full histories. |
| Find loaded threads | `thread/loaded/list` returns paginated IDs for sessions currently loaded in memory. | This is the useful discovery call for a thread already live in that app-server process. It is distinct from persisted `thread/list`. |
| Rejoin/resume | `thread/resume` takes `threadId`. Its generated parameter docs say an ID identifying a running thread makes app-server rejoin that thread; for a non-running thread it loads the thread from disk. | The protocol explicitly supports rejoining an in-memory running thread, conditional on reaching the same app-server process. This does not prove the Codex desktop exposes a usable transport to it. |
| Steer a running turn | `turn/steer` takes `threadId`, input, and required `expectedTurnId`; it fails if there is no active turn or the ID does not match. Docs say it adds input to the active turn and does not start a new turn. | Supports adding input to an existing execution when connected to its owning server. It is not a generic append without checking the current active turn ID. |
| Interrupt | `turn/interrupt` takes both `threadId` and `turnId`; docs say success ends the turn with `status: "interrupted"`. | Available in the general protocol. The desktop plugin bridge checked by the parent does not expose a stop tool. |
| Event subscription | No `notifications/subscribe` or `thread/subscribe` method appears in the generated `ClientRequest` union. Docs say `thread/start` automatically subscribes the caller to turn/item events; `thread/unsubscribe` explicitly unsubscribes **this connection**. Each transport connection must independently send `initialize`, then `initialized`. | Notifications are connection-scoped in the documented model; subscription is managed by thread lifecycle, not a standalone subscribe RPC. Exact reconnect/rejoin event delivery should be verified against the target server. |
| Approval | Approval prompts are server-initiated JSON-RPC requests. Generated request parameter types include `threadId`, `turnId`, and `itemId` (some command requests also have an `approvalId`); the client answers the server request with a decision. | The response is correlated by the JSON-RPC request ID on the connection that received it; the protocol shows no separate cross-connection approval endpoint. A second UI should not be assumed able to answer a pending approval unless a broker forwards the original request and response on that connection. |
| Multiple clients | Every connection has its own initialization handshake; unsubscribe is explicitly per connection. Docs show remote clients connecting to an app-server transport. | This supports a multi-connection protocol model, but the local help/docs/schema do not promise that concurrent clients can safely control the same live thread, nor do they define event fan-out semantics for two subscribers. Test this on the actual server before relying on it. |

## Desktop-specific boundary

Per the parent task's independent process/socket check (not re-probed here), the current desktop app-server is stdio-based and its default control socket is absent or unreachable. The desktop's `CODEX_APP_TOOLS_PIPE_PATH` named pipe answered `tools/list` using a 4-byte little-endian length prefix plus JSON-RPC, and the bundled `codex-app-tools` server exposes a limited MCP tool set: thread listing/reading, waiting, and sending a message. It does not expose stop or approval handling. This is a separate internal tools channel; do not treat it as the full app-server transport or infer live streamed event support from it.

Therefore, the general app-server protocol has primitives to rejoin and steer a running thread, but this desktop instance has not been shown to expose those primitives over an attachable socket. The internal plugin pipe provides a narrower route for list/read/wait/send operations only. Sending a message through that pipe should be treated as a live state change and verified separately before using it against a real task.

## Minimal verification plan

Run only against a disposable, clearly named test thread and an explicitly reachable app-server instance. Do not start a model turn in a real desktop conversation for this probe.

1. Open two client connections to the *same* server, initialize both, then compare `thread/loaded/list` and `thread/read` results for one already-running test thread.
2. On client B call `thread/resume` with the test thread ID; confirm it returns the same thread ID and that B receives subsequent `turn/*` and `item/*` notifications. Record whether client A still receives them. Then call `thread/unsubscribe` on B and confirm only B stops receiving thread events.
3. In a disposable test turn, use the observed active `turnId` with `turn/steer` from B and verify the appended input appears in that same turn. Use `turn/interrupt` only if the test turn is still active and confirm its terminal status.
4. Exercise an approval only in an isolated throwaway workspace with a harmless, expected approval prompt. Record which connection receives the server request and whether a response from another connection is rejected; never auto-accept as part of the probe.
5. Separately check whether the actual desktop publishes any supported control socket. If it does not, stop the protocol-attachment test there: the generic RPC behavior cannot establish desktop takeover.

## Limits

- Schema generation describes this installed CLI's protocol surface, including experimental methods/fields; it does not prove a running desktop server implements or exposes every generated method.
- No model task, daemon start, live-thread mutation, config change, credential read, or desktop socket probe was performed in this subtask.
- The official docs are mutable; retain the CLI version and generated schema bundle alongside any later retest.

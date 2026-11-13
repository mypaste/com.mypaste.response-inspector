# 响应头与证书

MyPaste extension `com.mypaste.response-inspector` (version `1.0.0`).

打开一条链接就查看它实际返回的响应：状态行、完整响应头、重定向链，以及 TLS 版本、密码套件和整条证书链的颁发者、有效期、SAN、公钥与 SHA-256 指纹。证书验证失败也照常列出细节，并明确标出失败原因。检查只经宿主的 `network.inspect` 服务发出一次 HTTPS GET：不读正文、不发送 Cookie、不连接本机或内网地址，也不打开任何套接字。

This repository is an independent copy extracted from the former `mypaste-code-extensions` monorepo at commit `b31981cd4baf3c300c7634ef26be118cc0074094`. It contains only this extension's tracked source files. The published `.mypaste-plugin` archives and marketplace index live in [`mypaste-extensions-catalog`](https://github.com/mypaste/mypaste-extensions-catalog).

The manifest speaks MyPaste plugin protocol v3. Installation, capability mediation, and content-digest verification are performed by the MyPaste desktop host.

## Files

- `mypaste.plugin.json`: package identity, the `entity.read`,
  `clipboard.write` and official-only `network.inspect` capabilities, and the
  internal `inspect` command the surface invokes.
- `src/preview.html`, `src/main.ts`, `src/bridge.ts`, `src/report.ts`: the
  surface page, its bridge to the host, and the pure report module.
- `src/cmd/mypaste-response-inspector`: the Go runtime that normalizes the
  address and forwards it to the host.
- `scripts/build.mjs`: bundles `src/preview.html` and `src/main.ts` into the
  page the manifest names.

## Build

```bash
bun install
bun run build
```

The generated `preview.html` is intentionally ignored; edit `src/preview.html`
and `src/main.ts` instead.

`src/` is its own Go module for the runtime: `cd src && go test ./...`.

## License

MIT. See [LICENSE](LICENSE).

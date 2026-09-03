# Docker suitcase target

This is the portable, inspectable Docker target for deploy.local. It runs on a Linux Docker Engine,
including the Linux VM supplied by Docker Desktop on macOS and Windows. It does not use
Docker-in-Docker: `suitcase-core` mounts the host Docker socket and creates sibling application and
short-lived volume-helper containers.

Generate the resolved Compose project without contacting Docker:

```sh
deploy suitcase target compose
```

`target.json`, `target.env`, `compose.yaml`, and `releases.json` live in
`~/.deploy/suitcase-target` by default. The
target ID is also written into the state volume on first boot; a different identity cannot silently
adopt that state. `stop` and `upgrade` preserve these named volumes:

- `deploy-local-suitcase-state`
- `deploy-local-suitcase-content`
- `deploy-local-suitcase-build-cache`

The core image's Docker-socket access is administrative access to the Docker host. The CLI requires
`--accept-docker-socket-risk` before starting or upgrading it.

## Platform upgrades and rollback

Moving tags are candidate selectors only. Before first start or upgrade, the CLI pulls each image,
resolves it to an immutable `repository@sha256:...` reference, and writes only that resolved pair to
the active Compose project. An unresolved/local image fails closed unless
`--allow-mutable-images` is explicitly supplied for development.

The target retains two health-admitted platform slots. Upgrade stages the inactive slot, waits for
the core health check, and commits it only after admission. If admission fails, the prior Compose
and image pair is recreated automatically and remains active. Switch to the retained release with:

```sh
deploy suitcase target rollback --accept-docker-socket-risk
```

Digest resolution does not prove publisher identity. Without a configured policy the release ledger
says `not-configured`; it never claims signature verification. Release-pipeline cosign signatures can
be enforced with either a public key or a complete keyless policy:

```sh
deploy suitcase target upgrade --accept-docker-socket-risk \
  --cosign-key ./suitcase-release.pub

deploy suitcase target upgrade --accept-docker-socket-risk \
  --cosign-certificate-identity <workflow-identity> \
  --cosign-certificate-oidc-issuer https://token.actions.githubusercontent.com
```

## Images

Build local multi-architecture OCI archives:

```sh
node docker/suitcase/build-images.mjs --version 1.0.0
```

Push manifest lists with BuildKit SBOM and provenance attestations, then sign them with cosign:

```sh
node docker/suitcase/build-images.mjs --version 1.0.0 --push --sign
```

Both images target `linux/amd64` and `linux/arm64`. `release.json` is the machine-readable runtime
contract. Core and helper must use the same `runtimeProtocol`.

## Offline access

Compose publishes the admin HTTPS and HTTP ports. Physical Wi-Fi remains a host responsibility:
macOS Internet Sharing, Windows Mobile hotspot, or a Linux host hotspot. Run
`deploy suitcase target diagnose` for the detected LAN URL and platform-specific startup guidance.
Application `.local` names require native mDNS integration or the planned host helper; the IP URL is
the portable admin fallback.

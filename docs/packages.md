# Packages

## On your computer

`deploy packages login` only adds settings that apply to deploy.local, the same
way GitHub Packages, Artifactory and Verdaccio are set up. Public npm keeps
working as before.

- `//deploy.local/npm/:_authToken` holds your package key.
- `//deploy.local/npm/:cafile` points at deploy.local's certificate, for pnpm.
- npm ignores a per-registry certificate, so it reads `NODE_EXTRA_CA_CERTS` from
  your shell profile, which adds to the trusted roots. Login prints the line when
  you need it. If deploy.local's certificate is in your keychain and
  `NODE_USE_SYSTEM_CA=1` is set, npm needs nothing more.

Never set a plain `cafile=` for deploy.local: it replaces the public roots, and
npmjs.org stops working. Logging in again removes one that an older login wrote.

`deploy packages use` adds `registry=` to one project, so that project installs
everything through deploy.local.

## In app builds

Apps can install from `https://deploy.local/npm/` without a person signing in.
The build uses the assigned computer's install-only key. It cannot publish. No
key belongs in your repository, `deploy.yaml`, a Docker `ARG` or `ENV`, or an
image layer. A project's **Install through deploy.local** setting applies to
these builds too; an explicit project registry configuration takes precedence.

Generated Node Dockerfiles already mount the registry configuration. In your own
Dockerfile, enable BuildKit syntax and mount the two optional secrets on the
install step (after copying the manifest and lockfile):

```dockerfile
# syntax=docker/dockerfile:1.7
RUN --mount=type=secret,id=npmrc,required=false,target=/run/deploy-packages/npmrc,mode=0600 --mount=type=secret,id=ca,required=false,target=/run/deploy-packages/ca.crt,mode=0600 if [ -f /run/deploy-packages/npmrc ]; then export NPM_CONFIG_USERCONFIG=/run/deploy-packages/npmrc; if [ -s /run/deploy-packages/ca.crt ]; then export NODE_EXTRA_CA_CERTS=/run/deploy-packages/ca.crt; fi; fi; pnpm install --frozen-lockfile
```

For npm, replace `pnpm install --frozen-lockfile` with `npm ci` (commit a
`package-lock.json` first). Both clients read `NPM_CONFIG_USERCONFIG`; the supplied
npmrc sets `registry`, the install token and `cafile=/run/deploy-packages/ca.crt`
when a CA is present. The paths and mode match the generated Dockerfile. The
mounts are mode 0600, so run this step as root. `NODE_EXTRA_CA_CERTS` also lets
Node-based install scripts trust that CA. Each later install step needs its own
mounts and exports; do not copy the files or persist the exports with `ENV`.

With no secrets, this line uses the client's ordinary configuration, normally
npmjs.org. If deploy.local is unreachable before a build, deploy.local supplies
public-registry configuration instead. This does not make private packages
available on npmjs.org, and the custom step does not retry a failed install.
A Dockerfile that does not mount the secrets keeps its existing install behavior.

This works for source builds declared under `components.<name>.build` in
`deploy.yaml` (including `context`, `dockerfile` and `target`) and for apps without
a manifest. There is no registry key or extra Packages field to add to the
manifest. Image-only components do not install dependencies. Updated workers
support it on other computers, including Docker through Colima: the worker
resolves deploy.local on the host and passes that address into BuildKit. If
buildx or secret support is unavailable, the worker uses its existing build
command and logs: “The package registry was not available for this build.”

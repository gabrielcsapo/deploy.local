# Graph Lab

Graph Lab is deploy.local's first-party end-to-end graph exercise. It intentionally uses small,
public images so the test measures orchestration rather than application build time.

The graph covers:

- a public Nginx gateway connected through a generated service binding;
- two API instances behind the gateway;
- a private PostgreSQL service with durable data;
- a long-running worker with a projected secret;
- a per-site migration job that must complete before traffic moves;
- dependency ordering, health admission, routing, logs, restart, and volume recovery.

Deploy it from this directory with:

```sh
deploy -a graph-lab
```

Use any non-empty value for `workerToken`. A successful run should expose the gateway, return a
Whoami response, show two API placements, stream worker heartbeats, and retain the PostgreSQL
volume across a redeploy.

Inspect the complete desired and actual graph, stream one component, and exercise the managed
PostgreSQL profile with:

```sh
deploy component inspect graph-lab
deploy logs -a graph-lab --component worker
deploy component operation graph-lab database readiness
deploy component operation graph-lab database logical-export
```

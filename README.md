# Kubeclaw

WebSocket gateway + Ollama inference stack for Kubernetes.

## Prerequisites

- Kubernetes cluster (1.27+)
- CNI with NetworkPolicy support (Calico, Cilium, etc.)
- A container registry (the manifests default to `harbor.blocksecops.local/blocksecops/openclaw`)
- PersistentVolume provisioner for Ollama model storage

## Build

```bash
VERSION="0.5.0"
docker build --build-arg SERVICE_VERSION=${VERSION} -t <your-registry>/openclaw:${VERSION} .
docker push <your-registry>/openclaw:${VERSION}
```

Update the image in `k8s/base/kustomization.yaml` to match your registry:

```yaml
images:
  - name: ghcr.io/openclaw/openclaw
    newName: <your-registry>/openclaw
    newTag: "0.5.0"
```

## Deploy

```bash
kubectl apply -k k8s/base/
```

## Configuration

Set secrets before deploying (or use an external secrets operator):

```bash
kubectl -n openclaw create secret generic openclaw-secrets \
  --from-literal=OPENCLAW_GATEWAY_TOKEN=<token>
```

Optional secret keys: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `TELEGRAM_TOKEN`, `SLACK_TOKEN`, `DISCORD_TOKEN`, `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET`.

## Verify

```bash
kubectl get pods -n openclaw

# Health check
kubectl port-forward -n openclaw svc/openclaw-gateway 18790:18790
curl localhost:18790
```

## Architecture

- **Gateway** (port 18789 WS, 18790 HTTP) — WebSocket server with rate limiting (20 msg/60s), 64KB message cap
- **Ollama** — runs as non-root (uid 1000), init container pulls the model, main container serves inference
- **HPA** — autoscales gateway 2-5 replicas at 70% CPU
- **PDB** — `minAvailable: 1` for both gateway and Ollama

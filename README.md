# Kubeclaw

WebSocket gateway + Ollama inference stack for Kubernetes. The gateway speaks a JSON-RPC protocol over WebSocket, compatible with the OpenClaw Control UI.

## Prerequisites

- Kubernetes cluster (1.27+)
- CNI with NetworkPolicy support (Calico, Cilium, etc.)
- A container registry (the manifests default to `harbor.blocksecops.local/blocksecops/openclaw`)
- PersistentVolume provisioner for Ollama model storage

## Build

```bash
VERSION="0.6.0"
docker build --build-arg SERVICE_VERSION=${VERSION} -t <your-registry>/openclaw:${VERSION} .
docker push <your-registry>/openclaw:${VERSION}
```

Update the image in `k8s/base/kustomization.yaml` to match your registry:

```yaml
images:
  - name: ghcr.io/openclaw/openclaw
    newName: <your-registry>/openclaw
    newTag: "0.6.0"
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

Agent name and description can be set in the ConfigMap (`k8s/base/configmap.yaml`):

```json
{
  "agent": {
    "model": "qwen2.5:14b",
    "name": "OpenClaw",
    "description": "AI assistant powered by Ollama"
  }
}
```

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

## WebSocket Protocol

The gateway uses a JSON-RPC-like protocol over WebSocket:

**Request** (client to server):
```json
{"type": "req", "id": "<uuid>", "method": "<name>", "params": {}}
```

**Response** (server to client):
```json
{"type": "res", "id": "<uuid>", "ok": true, "payload": {}}
```

**Server Event** (server to client):
```json
{"type": "event", "event": "<name>", "seq": 1, "payload": {}}
```

### RPC Methods

| Method | Description |
|--------|-------------|
| `connect` | Handshake — returns session defaults |
| `chat.send` | Send a message and stream the response |
| `chat.history` | Retrieve chat history for a session |
| `chat.abort` | Abort a running chat stream |
| `agents.list` | List available agents |
| `agent.identity.get` | Get agent identity |
| `sessions.list` | List active sessions |
| `sessions.patch` | Create or update a session |
| `sessions.delete` | Delete a session |
| `health` | Health check |
| `status` | Server status and version |
| `config.get` | Get server configuration |
| `models.list` | List available models |

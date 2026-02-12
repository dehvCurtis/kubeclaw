# OpenClaw Kubernetes Deployment

## Prerequisites

- Kubernetes cluster with:
  - [External Secrets Operator](https://external-secrets.io/) installed
  - `vault-backend` ClusterSecretStore configured
  - A CNI plugin that supports NetworkPolicy (e.g., Calico, Cilium)

## Seed Vault Secrets

Before deploying, populate the required secrets in Vault:

```bash
# Required
vault kv put secret/openclaw/gateway token=<gateway-token>
vault kv put secret/openclaw/anthropic api_key=<anthropic-api-key>

# Optional (failover LLM provider)
vault kv put secret/openclaw/openai api_key=<openai-api-key>

# Channel tokens (add the ones you need)
vault kv put secret/openclaw/channels \
  telegram_token=<telegram-bot-token> \
  slack_token=<slack-bot-token> \
  discord_token=<discord-bot-token>

# OAuth credentials (if using OAuth-based channels)
vault kv put secret/openclaw/oauth \
  client_id=<oauth-client-id> \
  client_secret=<oauth-client-secret>
```

## Deploy

```bash
# Validate manifests render correctly
kubectl kustomize k8s/base/

# Dry-run against cluster API
kubectl apply -k k8s/base/ --dry-run=server

# Apply
kubectl apply -k k8s/base/
```

## Verify

```bash
# Check ExternalSecret sync status
kubectl get externalsecret -n openclaw

# Check pod status
kubectl get pods -n openclaw

# Check gateway health
kubectl port-forward -n openclaw svc/openclaw-gateway 18790:18790
curl localhost:18790
```

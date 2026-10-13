Loop warm worker infrastructure
===============================
Project: tavus-511105
Instance: loop-worker, us-central1-a
Machine: e2-standard-4 (4 vCPU, 16 GB), Debian 12, 50 GB balanced disk
Runtime user: loopworker
Deployment root: /opt/loop-worker (owned by loopworker)
CLI: /usr/local/bin/codex, pinned 0.153.4
Node: newest Node 22 release at bootstrap; archive SHA256 verified
pnpm: 10

Network: dedicated loop-worker VPC and loop-worker-us-central1 subnet.
Only inbound rule permits TCP22 from Google's IAP range 35.235.240.0/20.
No public HTTP/API service. Outbound access uses the VM's external IP.
No GCP service account is attached to this worker.
Project SSH keys are blocked; a dedicated instance key is used.
Local SSH alias: loop-worker, authenticated IAP ProxyCommand.

Bootstrap script is idempotent, intended for root on the dedicated VM.
Application source must be uploaded using an allowlist; do not copy .env,
data directories, local node_modules, gcloud credentials, or local Codex auth.
Install Linux dependencies remotely using the committed pnpm lockfile.
Run bash scripts/remote-worker/deploy.sh to refresh the allowlisted code and
dependencies. SSH uses ControlMaster with a 10-minute keepalive to reuse the
authenticated IAP connection across short verification commands.

Remote sign-in (separate from the local account cache):
  ssh -t loop-worker '/usr/local/bin/codex login --device-auth'
Follow the official OpenAI device-code page displayed by the CLI.
Check without displaying credentials:
  ssh loop-worker '/usr/local/bin/codex login status'

Pause hosting compute charges when intentionally not using the worker:
  gcloud compute instances stop loop-worker --project=tavus-511105 --zone=us-central1-a
Restart before use:
  gcloud compute instances start loop-worker --project=tavus-511105 --zone=us-central1-a
Disk storage persists and remains billable while stopped.

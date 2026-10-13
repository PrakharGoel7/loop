Loop hosted demo (Google Cloud tavus-511105)

App: loop-app, us-central1-a, e2-medium, Debian 12, 30GB disk.
Public origin: https://35-226-89-51.sslip.io (static IP 35.226.89.51).
Caddy terminates HTTPS and forwards to localhost:3001.
Backend runs as loopapp under systemd from /opt/loop-app.
Private address 10.84.0.3 connects to existing loop-worker 10.84.0.2.
The existing warm worker remains separate and retains its own Codex sign-in.

Storage: loop-tavus-511105-store-versions and loop-tavus-511105-clips.
Both buckets enforce public access prevention and uniform bucket-level access.
Only the app service account has application-level object administration rights.
Inherited project administrators still retain normal administrative access.

Credentials: /etc/loop-app.env is protected (root owner, mode 600) and loaded
by systemd. Hosted Tavus credentials can persist in protected
/opt/loop-app/data/hosted-tavus.json. All credentials and study data stay outside Git.
Public visitors receive a signed study identity automatically; there is no invite
or admin code page. Hosted browser setup is blocked. Manage configuration through
the trusted server environment. The old admin/invite tokens are no longer used.

Deployment: ./scripts/hosting/deploy.sh allowlists application source files,
uploads to /opt/loop-app-staging, installs locked Linux dependencies, runs tests,
checks backend types and builds. Only a verified candidate is promoted, including
its existing dist build, without copying credentials or live data. No second build
is performed. Promotion automatically refuses when any live study has storeLifecycle active,
or if existing session state cannot be safely parsed. It does not restart the service.
After testing, use gcloud compute ssh loop-app --project=tavus-511105
--zone=us-central1-a --tunnel-through-iap --command='sudo systemctl restart loop-app'.
This deploys the shared Loop app; shopper revisions use uploaded verified files
and per-study version activation, not this deployment script.

Staging: /opt/loop-app-staging is an isolated build-and-test candidate directory.
There is no public staging URL or continuously running staging service yet.
Staging test data is isolated from production. No second VM is provisioned.

Operational constraints: one active study; no simultaneous local and hosted
benchmarks on the same worker while measuring performance. ssh loop-app and
ssh loop-worker use separate authorized users. App-to-worker key is generated
on the app VM, never copied from the developer machine. Worker SSH ingress is
restricted to the app network tag and Google IAP administration.

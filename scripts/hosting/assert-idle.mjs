import fs from 'node:fs';
const file = process.argv[2] || '/opt/loop-app/data/sessions.json';
if (fs.existsSync(file)) {
  let sessions;
  try {
    sessions = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!sessions || typeof sessions !== 'object' || Array.isArray(sessions)) throw new Error('Unexpected session storage format');
  } catch {
    console.error('Deployment refused: live session state could not be safely read.');
    process.exit(1);
  }
  if (Object.values(sessions).some((session) => session?.storeLifecycle === 'active')) {
    console.error('Deployment refused: an active study must finish before promoting the app.');
    process.exit(1);
  }
}

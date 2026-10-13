import path from 'node:path';

export type WorkerCommand = (command: string, args: string[], options?: { cwd?: string; input?: string; timeoutMs?: number; sessionId?: string; logPath?: string }) => Promise<{ stdout: string; stderr: string }>;
export type RemoteWorkspace = { host: string; warmRoot: string; root: string; localRoot: string; localProjectRoot: string };

export function remoteWorkerConfig(env: NodeJS.ProcessEnv = process.env) {
  const host = env.LOOP_WORKER_SSH_HOST;
  const warmRoot = env.LOOP_WORKER_REMOTE_ROOT;
  if (!host && !warmRoot) return undefined;
  if (!host || !warmRoot) throw new Error('Remote workers require both LOOP_WORKER_SSH_HOST and LOOP_WORKER_REMOTE_ROOT.');
  if (!/^[a-zA-Z0-9_.@-]+$/.test(host) || host.startsWith('-')) throw new Error('Invalid remote worker SSH host. Use a configured SSH alias or user@hostname.');
  if (!/^\/[a-zA-Z0-9_./-]+$/.test(warmRoot) || warmRoot.split('/').includes('..')) throw new Error('Remote worker root must be an absolute path containing letters, numbers, dots, underscores, slashes or hyphens.');
  return { host, warmRoot: warmRoot.replace(/\/$/, '') };
}
const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
const sshArgs = (host: string) => ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=2', host];

export async function createRemoteWorkspace(localRoot: string, localProjectRoot: string, run: WorkerCommand): Promise<RemoteWorkspace | undefined> {
  const config = remoteWorkerConfig();
  if (!config) return undefined;
  const parent = config.warmRoot + '/.loop-workspaces';
  const created = await run('ssh', [...sshArgs(config.host), `mkdir -p ${quote(parent)} && mktemp -d ${quote(parent + '/job-XXXXXXXX')}`], { timeoutMs: 20_000 });
  const root = created.stdout.trim();
  if (!root.startsWith(parent + '/job-') || !/^[a-zA-Z0-9_./-]+$/.test(root)) throw new Error('Remote worker returned an invalid workspace path.');
  const workspace = { ...config, root, localRoot, localProjectRoot };
  try {
    await run('rsync', ['-az', '--exclude=node_modules', '--exclude=dist', '--exclude=.env*', '--exclude=data', '--exclude=*.tsbuildinfo', '-e', 'ssh -o BatchMode=yes -o ConnectTimeout=10', localRoot + '/', `${config.host}:${root}/`], { timeoutMs: 120_000 });
    // Keep incremental build caches private; reuse Linux-installed dependencies.
    const setup = `const fs=require('fs'),p=require('path');const root=${JSON.stringify(root)},warm=${JSON.stringify(config.warmRoot)};fs.mkdirSync(p.join(root,'node_modules'),{recursive:true});for(const name of fs.readdirSync(p.join(warm,'node_modules'))){if(name==='.tmp'||name==='.cache')continue;fs.symlinkSync(p.join(warm,'node_modules',name),p.join(root,'node_modules',name));}fs.mkdirSync(p.join(root,'.loop'),{recursive:true});`;
    await run('ssh', [...sshArgs(config.host), 'node -e ' + quote(setup)], { timeoutMs: 20_000 });
    return workspace;
  } catch (error) { await cleanupRemoteWorkspace(workspace, run).catch(() => undefined); throw error; }
}

export function remoteCommandSpec(workspace: RemoteWorkspace, command: string, args: string[]) {
  const remap = (value: string) => value.startsWith(workspace.localRoot + '/') || value === workspace.localRoot
    ? workspace.root + value.slice(workspace.localRoot.length)
    : value.startsWith(workspace.localProjectRoot + '/node_modules/')
      ? workspace.warmRoot + value.slice(workspace.localProjectRoot.length) : value;
  let executable = command;
  if (command === process.execPath) executable = 'node';
  else if (path.basename(command) === 'codex') executable = process.env.LOOP_WORKER_REMOTE_CODEX_BIN || 'codex';
  return { executable, args: args.map(remap) };
}

export async function runRemoteCommand(workspace: RemoteWorkspace, command: string, args: string[], run: WorkerCommand, options: Parameters<WorkerCommand>[2] = {}) {
  const spec = remoteCommandSpec(workspace, command, args);
  const timeout = options.timeoutMs || 60_000;
  // A remote watchdog also terminates commands if the SSH client disappears.
  const program = `const fs=require('fs'),root=${JSON.stringify(workspace.root)};if(!fs.existsSync(root)||fs.existsSync(root+'/.loop/cancelled'))process.exit(125);const{spawn}=require('child_process');const c=spawn(${JSON.stringify(spec.executable)},${JSON.stringify(spec.args)},{cwd:${JSON.stringify(workspace.root)},stdio:['pipe','inherit','inherit'],detached:true,env:Object.fromEntries(Object.entries(process.env).filter(([k])=>/^(PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|LANG|LC_.*|CODEX_HOME|NODE_EXTRA_CA_CERTS)$/.test(k)))});require('fs').writeFileSync(${JSON.stringify(workspace.root + '/.loop/active-process.json')},JSON.stringify({pid:c.pid}));process.stdin.pipe(c.stdin);c.stdin.on('error',()=>{});let stopped=false;function stop(){if(stopped)return;stopped=true;try{process.kill(-c.pid,'SIGTERM')}catch{}setTimeout(()=>{try{process.kill(-c.pid,'SIGKILL')}catch{}},1500).unref()}const timer=setTimeout(stop,${timeout});const lease=setInterval(()=>{if(!fs.existsSync(root)||fs.existsSync(root+'/.loop/cancelled'))stop()},250);for(const sig of ['SIGHUP','SIGTERM','SIGINT'])process.on(sig,stop);c.on('error',e=>{console.error(e.message);process.exit(1)});c.on('exit',code=>{clearTimeout(timer);clearInterval(lease);try{require('fs').unlinkSync(${JSON.stringify(workspace.root + '/.loop/active-process.json')})}catch{}process.exit(stopped?124:(code??1))});`;
  return run('ssh', [...sshArgs(workspace.host), 'node -e ' + quote(program)], { ...options, timeoutMs: timeout + 5000 });
}

export async function syncRemoteStore(workspace: RemoteWorkspace, run: WorkerCommand) {
  await run('rsync', ['-az', '--delete', '-e', 'ssh -o BatchMode=yes -o ConnectTimeout=10', `${workspace.host}:${workspace.root}/src/store/`, workspace.localRoot + '/src/store/'], { timeoutMs: 60_000 });
}

export async function readRemoteFile(workspace: RemoteWorkspace, relative: string, run: WorkerCommand) {
  if (relative.startsWith('/') || relative.split('/').includes('..')) throw new Error('Invalid remote result path.');
  return (await runRemoteCommand(workspace, 'node', ['-e', 'process.stdout.write(require("fs").readFileSync(process.argv[1],"utf8"))', workspace.root + '/' + relative], run, { timeoutMs: 10_000 })).stdout;
}

export async function cancelRemoteWorkspace(workspace: RemoteWorkspace, run: WorkerCommand) {
  if (!workspace.root.startsWith(workspace.warmRoot + '/.loop-workspaces/job-')) throw new Error('Refusing to cancel unexpected remote workspace.');
  const script = `const fs=require('fs');const root=${JSON.stringify(workspace.root)};if(!fs.existsSync(root))process.exit(0);fs.writeFileSync(root+'/.loop/cancelled','1');let pid;try{pid=JSON.parse(fs.readFileSync(root+'/.loop/active-process.json','utf8')).pid}catch{}if(Number.isInteger(pid)&&pid>1){try{process.kill(-pid,'SIGTERM')}catch{}}setTimeout(()=>{if(Number.isInteger(pid)&&pid>1){try{process.kill(-pid,'SIGKILL')}catch{}}},1600);`;
  await run('ssh', [...sshArgs(workspace.host), 'node -e ' + quote(script)], { timeoutMs: 20_000 });
}

export async function cleanupRemoteWorkspace(workspace: RemoteWorkspace, run: WorkerCommand) {
  if (!workspace.root.startsWith(workspace.warmRoot + '/.loop-workspaces/job-')) throw new Error('Refusing to remove unexpected remote workspace.');
  await cancelRemoteWorkspace(workspace, run);
  await run('ssh', [...sshArgs(workspace.host), 'rm -rf -- ' + quote(workspace.root)], { timeoutMs: 20_000 });
}

// Fetch the exact dist produced by verification; never rebuild on the app host.
export async function downloadRemoteBuild(workspace: RemoteWorkspace, destination: string, run: WorkerCommand, sessionId?: string) {
  await run('rsync', ['-az', '--delete', '-e', 'ssh -o BatchMode=yes -o ConnectTimeout=10', `${workspace.host}:${workspace.root}/dist/`, destination + '/'], { timeoutMs: 60_000, sessionId });
}

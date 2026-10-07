/**
 * Desktop-only deployment: vault content → website project → build → server.
 *
 * Runs the same pipeline a user would otherwise script by hand or hand to the post-sync
 * hook, but from settings instead of a command line:
 *
 * 1. copy `.md`/`.mdx` out of `vaultContentPath`'s `project/` and `journal/` trees into the
 *    project's `src/content/` collections (pruning files the vault no longer has), then run
 *    the project's own content script if it ships one;
 * 2. `npm run build` in `astroProjectPath`;
 * 3. publish `dist/` to `sftpRemotePath` over SSH with `rsync`.
 *
 * Like `src/postSyncHook.ts` this is a registered desktop-only exception, so it follows the
 * rules in docs/api-compatibility.md § Desktop-only exceptions:
 *
 * - Nothing Node is reached at module load. The four built-ins it uses are `require`d
 *   lazily, inside `loadNodeModules`, and only after `isDeploymentSupported()` has confirmed
 *   a real filesystem adapter (desktop Obsidian).
 * - Every failure path degrades to a `skipped` outcome, and no caller depends on this file:
 *   the sync that triggered it has already completed by the time it runs.
 * - `runDeployment` resolves rather than rejects on every path, so a failed deploy can never
 *   be mistaken for a failed sync.
 *
 * Every run also appends a timestamped entry — configuration, stage markers, command output,
 * final verdict — to `~/.fit-deploy.log` (`DEPLOYMENT_LOG_FILENAME`), which is what makes a
 * deployment inspectable after the sticky Notice is gone. `DeploymentOptions.logPath` points
 * the log somewhere else, `null` turns it off.
 *
 * Transport is `rsync` over SSH rather than an SFTP client library: an SFTP client would pull
 * a dozen Node built-ins (`net`, `tls`, `dns`, ...) into the bundle and break the mobile
 * compatibility check, while `rsync` is incremental and can prune files the build no longer
 * produces. A password, when supplied, is handed to `sshpass` through a mode-0600 temp file
 * rather than a command-line argument, so it never appears in the process list.
 *
 * @see docs/deployment.md
 */
import { FileSystemAdapter, Platform, Vault } from 'obsidian';
import type { FitSettings } from '@/fitSettings';

/** Retained output lines. A chatty build must not grow memory without bound. */
export const DEPLOYMENT_MAX_OUTPUT_LINES = 200;

/** Vault subfolder → Astro collection directory, relative to `astroProjectPath`. */
export const DEPLOYMENT_CONTENT_MAPPINGS = [
	{ source: 'project', target: 'src/content/projects' },
	{ source: 'journal', target: 'src/content/journal' },
] as const;

/**
 * Extensions copied out of the vault. `.md` matters as much as `.mdx`: the Astro content
 * collections accept both, and a plain note containing `{` or `<Tag>` must not be pushed
 * through the MDX pipeline by treating it as `.mdx`.
 */
export const DEPLOYMENT_CONTENT_EXTENSIONS = ['.md', '.mdx'] as const;

/**
 * Optional content script run after the copy, when `astroProjectPath` ships one. It is a
 * convention, not a requirement: the copy above already publishes the files, the script only
 * reconciles frontmatter and prunes entries a hand-written file would fail the build on.
 * See docs/deployment.md § Content synchronisation.
 */
export const DEPLOYMENT_CONTENT_SCRIPT = 'scripts/sync-content.mjs';

/** Build command, run in `astroProjectPath` through a shell. */
export const DEPLOYMENT_BUILD_COMMAND = 'npm run build';

/** Build output published to `sftpRemotePath`. */
export const DEPLOYMENT_DIST_DIR = 'dist';

/** Never published: OS/editor litter and source maps. Mirrors the defaults the equivalent
 * shell pipeline uses, so both routes put the same tree on the server. */
export const DEPLOYMENT_UPLOAD_EXCLUDES = ['.DS_Store', '*.log', '*.map'] as const;

/** SSH port used when `sftpPort` is unset or out of range. */
export const DEPLOYMENT_DEFAULT_PORT = 22;

/** Per-command ceiling, in seconds. An unbounded build would hang the deploy forever. */
export const DEPLOYMENT_COMMAND_TIMEOUT_SEC = 900;

/** Run log written to the user's home directory: `~/.fit-deploy.log`. */
export const DEPLOYMENT_LOG_FILENAME = '.fit-deploy.log';

/** The active run log is rotated to `<path>.1` as soon as it grows past this many bytes. */
export const DEPLOYMENT_LOG_MAX_BYTES = 512 * 1024;

/** A `child_process` output stream, as far as this file needs it. */
interface OutputStreamLike {
	on(event: 'data', listener: (chunk: { toString(): string }) => void): void;
}

/**
 * The subset of `child_process.ChildProcess` this file uses. Declared locally rather than
 * imported from `child_process`: a static type import of a Node built-in is exactly what the
 * mobile-compatibility checks reject.
 */
interface ChildProcessLike {
	stdout: OutputStreamLike | null;
	stderr: OutputStreamLike | null;
	on(event: 'error', listener: (error: Error) => void): void;
	on(event: 'close', listener: (code: number | null, signal: string | null) => void): void;
	kill(signal?: string): boolean;
}

interface SpawnOptionsLike {
	cwd?: string;
	shell?: boolean;
	windowsHide?: boolean;
}

/** The subset of the `child_process` module this file uses. */
interface ChildProcessModuleLike {
	spawn(command: string, args: string[], options: SpawnOptionsLike): ChildProcessLike;
}

interface DirentLike {
	name: string;
	isDirectory(): boolean;
	isFile(): boolean;
}

interface StatsLike {
	isDirectory(): boolean;
	/** Total size in bytes — used only to decide whether the run log is due for rotation. */
	size: number;
}

/** The subset of the `fs` module this file uses. */
interface FsModuleLike {
	existsSync(path: string): boolean;
	mkdirSync(path: string, options: { recursive: true }): string | undefined;
	readdirSync(path: string, options: { withFileTypes: true }): DirentLike[];
	copyFileSync(source: string, destination: string): void;
	rmSync(path: string, options: { recursive?: boolean; force?: boolean }): void;
	renameSync(source: string, destination: string): void;
	statSync(path: string): StatsLike;
	writeFileSync(path: string, data: string, options: { mode: number }): void;
	appendFileSync(path: string, data: string, options: { encoding: 'utf8' }): void;
}

/** The subset of the `path` module this file uses. */
interface PathModuleLike {
	join(...parts: string[]): string;
}

/** The subset of the `os` module this file uses. */
interface OsModuleLike {
	tmpdir(): string;
	homedir(): string;
}

interface NodeModules {
	childProcess: ChildProcessModuleLike;
	fs: FsModuleLike;
	os: OsModuleLike;
	path: PathModuleLike;
}

/** Deployment settings FIT owns. A `FitSettings` satisfies this structurally. */
export type DeploymentSettings = Pick<
	FitSettings,
	| 'enableAutoDeploy'
	| 'astroProjectPath'
	| 'vaultContentPath'
	| 'sftpHost'
	| 'sftpPort'
	| 'sftpUser'
	| 'sftpPassword'
	| 'sftpRemotePath'
>;

/** Why a deployment did not run at all. Distinct from one that ran and failed. */
export type DeploymentSkipReason = 'disabled' | 'unsupported-platform' | 'not-configured';

/** Which of the three sequential steps a failure came from. */
export type DeploymentStage = 'content' | 'build' | 'upload';

/** Outcome of one deployment. */
export type DeploymentResult =
	| { status: 'skipped'; reason: DeploymentSkipReason }
	| {
		status: 'success';
		/** Content files copied out of the vault. */
		copied: number;
		/** Stale collection files removed because the vault no longer has them. */
		removed: number;
		/** Directory that was published, for logging. */
		uploadedFrom: string;
		durationMs: number;
		output: string[];
	}
	| {
		status: 'failed';
		stage: DeploymentStage;
		/** One-line reason, suitable for a Notice. */
		message: string;
		exitCode: number | null;
		signal: string | null;
		timedOut: boolean;
		output: string[];
	};

export interface DeploymentOptions {
	/** Called for each output line as it arrives, for live logging. */
	onOutput?: (line: string) => void;
	/** Called as each stage starts, so a progress Notice can say what is happening. */
	onStage?: (stage: DeploymentStage) => void;
	/** Per-command ceiling in seconds; defaults to `DEPLOYMENT_COMMAND_TIMEOUT_SEC`. */
	timeoutSec?: number;
	/**
	 * Where the run log is appended. Defaults to `~/.fit-deploy.log`
	 * ({@link DEPLOYMENT_LOG_FILENAME}); `null` disables file logging. Tests pass a path in
	 * their temp directory so a suite run never touches the developer's home directory.
	 */
	logPath?: string | null;
}

/** Outcome of one spawned command. */
interface RunOutcome {
	code: number | null;
	signal: string | null;
	/** Non-null when the process could not be started at all (e.g. binary not found). */
	startError: string | null;
	timedOut: boolean;
}

interface CopyOutcome {
	copied: number;
	removed: number;
}

/**
 * Whether a deployment can run on this device.
 *
 * Both conditions are load-bearing. `Platform.isDesktopApp` is the primary gate (it is false
 * on iOS/Android, where there is no Node.js runtime to spawn anything with), and the adapter
 * check confirms Obsidian is running against a real filesystem rather than a mobile/capacitor
 * adapter.
 */
export function isDeploymentSupported(vault: Vault): boolean {
	if (!Platform.isDesktopApp) {
		return false;
	}
	return vault.adapter instanceof FileSystemAdapter;
}

/**
 * Required deployment settings that are still empty, in the order the settings tab shows them.
 *
 * A password is deliberately not required: key/agent auth is the preferred way in, and an
 * empty password is what selects it.
 */
export function missingDeploymentSettings(settings: DeploymentSettings): string[] {
	const missing: string[] = [];
	if (settings.astroProjectPath.trim() === '') missing.push('Astro project path');
	if (settings.vaultContentPath.trim() === '') missing.push('Vault content path');
	if (settings.sftpHost.trim() === '') missing.push('Server host');
	if (settings.sftpUser.trim() === '') missing.push('Server user');
	if (settings.sftpRemotePath.trim() === '') missing.push('Remote path');
	return missing;
}

/**
 * Absolute path of the run log a deployment appends to, or null when Node's `os` is not
 * reachable (mobile). Exported so callers can name the file — the settings button's
 * description and the docs both point at it.
 */
export function deploymentLogPath(): string | null {
	const node = loadNodeModules();
	if (node === null) return null;
	return defaultLogPath(node);
}

/** The log path used when `DeploymentOptions.logPath` is not given. */
function defaultLogPath(node: NodeModules): string {
	return node.path.join(node.os.homedir(), DEPLOYMENT_LOG_FILENAME);
}

/**
 * Why a deployment must not start, or null when it may.
 *
 * The pre-flight the settings button and the "Run deployment" command run before handing
 * over to `runDeployment`, so an empty or non-existent path is reported once, as an error
 * notice, instead of surfacing as a deploy that died in its first stage.
 *
 * Returns null on a platform without Node: there is no filesystem to check with, and the
 * platform gate owns that message.
 */
export function deploymentConfigurationProblem(settings: DeploymentSettings): string | null {
	const missing = missingDeploymentSettings(settings);
	if (missing.length > 0) {
		return `settings are incomplete — still needs ${missing.join(', ')}`;
	}

	const node = loadNodeModules();
	if (node === null) return null;

	const projectDir = settings.astroProjectPath.trim();
	if (!node.fs.existsSync(projectDir)) {
		return `website project not found: ${projectDir}`;
	}
	const vaultContentDir = settings.vaultContentPath.trim();
	if (!node.fs.existsSync(vaultContentDir)) {
		return `vault content folder not found: ${vaultContentDir}`;
	}
	return null;
}

/** HTTP is not the only thing that shuffles ports; keep an unusable value from reaching ssh. */
function normalizePort(port: number): number {
	return Number.isInteger(port) && port > 0 && port <= 65535 ? port : DEPLOYMENT_DEFAULT_PORT;
}

/** Quote a value for the *remote* shell, which receives `mkdir -p <path>` as one argument. */
function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function hasContentExtension(name: string): boolean {
	const lower = name.toLowerCase();
	return DEPLOYMENT_CONTENT_EXTENSIONS.some(extension => lower.endsWith(extension));
}

/**
 * `require` the four Node modules this file needs, or null when they are unavailable.
 *
 * Deliberately `require`, not `import()`: in Obsidian's renderer a bare dynamic import of a
 * Node built-in is left as a native dynamic import and fails to resolve, while `require`
 * works. Only ever called after `isDeploymentSupported()` has returned true.
 */
function loadNodeModules(): NodeModules | null {
	try {
		return {
			childProcess: require('child_process') as ChildProcessModuleLike,
			fs: require('fs') as FsModuleLike,
			os: require('os') as OsModuleLike,
			path: require('path') as PathModuleLike,
		};
	} catch {
		// Node runtime unavailable after all (or a module failed to load) — same fallback as
		// running on a platform that cannot support this.
		return null;
	}
}

/**
 * Publish one vault folder into one collection directory, and prune what it no longer has.
 *
 * A plain recursive copy rather than a sync library: the trees are small, and keeping it
 * here means the result is the same on every machine. Both directions are filtered to
 * `.md`/`.mdx`, so a `.gitkeep` (or any other file) in the target survives pruning.
 */
function copyContentTree(
	fs: FsModuleLike,
	path: PathModuleLike,
	sourceDir: string,
	targetDir: string
): CopyOutcome {
	const keep = new Set<string>();

	// The collection directory always ends up existing after a run, even when the vault
	// folder behind it is empty: a missing `journal/` still yields `src/content/journal/`,
	// and `project/en/` with no notes in it yields `src/content/projects/en/` (created when
	// the walk enters it).
	fs.mkdirSync(targetDir, { recursive: true });

	const walkSource = (relativeDir: string): void => {
		const absoluteDir = relativeDir === '' ? sourceDir : path.join(sourceDir, relativeDir);
		let entries: DirentLike[];
		try {
			entries = fs.readdirSync(absoluteDir, { withFileTypes: true });
		} catch {
			return; // folder absent — nothing to publish from it
		}

		for (const entry of entries) {
			// Hidden entries are never content: this is what keeps `.trash` and `.obsidian`
			// out of the website build.
			if (entry.name.startsWith('.')) continue;

			const relative = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`;
			if (entry.isDirectory()) {
				// Mirrored even when the folder holds no notes, so the collection layout
				// matches the vault rather than only its populated corners.
				fs.mkdirSync(path.join(targetDir, relative), { recursive: true });
				walkSource(relative);
				continue;
			}
			if (!entry.isFile() || !hasContentExtension(entry.name)) continue;

			keep.add(relative);
			fs.copyFileSync(path.join(sourceDir, relative), path.join(targetDir, relative));
		}
	};

	const walkTarget = (relativeDir: string): number => {
		const absoluteDir = relativeDir === '' ? targetDir : path.join(targetDir, relativeDir);
		let entries: DirentLike[];
		try {
			entries = fs.readdirSync(absoluteDir, { withFileTypes: true });
		} catch {
			return 0; // collection directory does not exist yet
		}

		let removed = 0;
		for (const entry of entries) {
			const relative = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`;
			if (entry.isDirectory()) {
				removed += walkTarget(relative);
				continue;
			}
			if (!entry.isFile() || !hasContentExtension(entry.name) || keep.has(relative)) continue;
			fs.rmSync(path.join(targetDir, relative), { force: true });
			removed++;
		}
		return removed;
	};

	walkSource('');

	// Every file in `keep` was copied above, so the set's size is the count — no need to
	// thread a counter through the recursion.
	return { copied: keep.size, removed: walkTarget('') };
}

/**
 * Sync vault content, build the project, and publish `dist/`.
 *
 * Resolves — never rejects — so a failing deploy cannot masquerade as a failed sync. Callers
 * distinguish "didn't run" (`skipped`) from "ran and failed" (`failed`, with the stage).
 */
export async function runDeployment(
	vault: Vault,
	settings: DeploymentSettings,
	options: DeploymentOptions = {}
): Promise<DeploymentResult> {
	if (!settings.enableAutoDeploy) {
		return { status: 'skipped', reason: 'disabled' };
	}
	if (!isDeploymentSupported(vault)) {
		return { status: 'skipped', reason: 'unsupported-platform' };
	}

	const node = loadNodeModules();
	if (node === null) {
		return { status: 'skipped', reason: 'unsupported-platform' };
	}

	const { childProcess, fs, os, path } = node;
	const timeoutSec = options.timeoutSec && options.timeoutSec > 0
		? options.timeoutSec
		: DEPLOYMENT_COMMAND_TIMEOUT_SEC;

	const output: string[] = [];

	// Run log: every stage marker, every output line and the final verdict are appended as
	// they happen, so `tail -f ~/.fit-deploy.log` follows a deployment live. The active log
	// is rotated to `<path>.1` as soon as it passes DEPLOYMENT_LOG_MAX_BYTES — checked before
	// the run starts *and* again before every line, so a chatty build cannot run away with an
	// unbounded file mid-run. `logPath: null` opts out (the tests use that).
	const logPath = options.logPath === undefined ? defaultLogPath(node) : options.logPath;

	/** Bytes currently in the active log; -1 once rotation has been given up on. */
	let logBytes = -1;
	if (logPath !== null) {
		try {
			logBytes = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;
		} catch {
			logBytes = 0;
		}
	}
	let encoder: TextEncoder | null = null;

	/** Move the active log onto `<path>.1`, dropping the previous generation, when over cap. */
	const rotateLogIfNeeded = (): void => {
		if (logPath === null || logBytes < 0 || logBytes <= DEPLOYMENT_LOG_MAX_BYTES) return;
		try {
			fs.rmSync(`${logPath}.1`, { force: true });
			fs.renameSync(logPath, `${logPath}.1`);
			logBytes = 0;
		} catch {
			// Rotation is best-effort: a stuck log beats a deploy that refuses to start.
			// Stop trying rather than pay a failing syscall on every following line.
			logBytes = -1;
		}
	};

	const writeLog = (line: string): void => {
		if (logPath === null || line.trim() === '') return;
		const entry = `${new Date().toISOString()} ${line}\n`;
		rotateLogIfNeeded();
		try {
			fs.appendFileSync(logPath, entry, { encoding: 'utf8' });
			// TextEncoder, not Buffer: Buffer is a Node global this file may not touch
			// (docs/api-compatibility.md), and the cap counts bytes, not characters.
			encoder ??= new TextEncoder();
			logBytes += encoder.encode(entry).length;
		} catch {
			// A log that cannot be written (full disk, no permissions) must not fail the deploy.
		}
	};

	const addLine = (line: string) => {
		if (line.trim() === '') return;
		writeLog(line);
		output.push(line);
		if (output.length > DEPLOYMENT_MAX_OUTPUT_LINES) output.shift();
		try {
			options.onOutput?.(line);
		} catch {
			// A failing log consumer must not take down the deployment.
		}
	};

	/** Marks a stage in the run log — the same moment `onStage` moves the progress Notice. */
	const stage = (name: DeploymentStage) => {
		addLine(`[deploy] stage: ${name}`);
		options.onStage?.(name);
	};

	const fail = (stg: DeploymentStage, message: string, run: RunOutcome | null = null): DeploymentResult => {
		addLine(`[deploy] ${stg} failed: ${message}`);
		// Verdict last: the tail of the run log is always what the run ended as.
		addLine(`[deploy] ===== run failed during ${stg} — ${message} =====`);
		return {
			status: 'failed',
			stage: stg,
			message,
			exitCode: run?.code ?? null,
			signal: run?.signal ?? null,
			timedOut: run?.timedOut ?? false,
			output: [...output],
		};
	};

	addLine(`[deploy] ===== run started ${new Date().toISOString()} =====`);

	const run = (command: string, args: string[], spawnOptions: SpawnOptionsLike): Promise<RunOutcome> => {
		return new Promise<RunOutcome>((resolve) => {
			let settled = false;
			let timedOut = false;
			let timer: ReturnType<typeof setTimeout> | null = null;
			const finish = (outcome: RunOutcome) => {
				if (settled) return;
				settled = true;
				if (timer !== null) clearTimeout(timer);
				resolve(outcome);
			};

			let child: ChildProcessLike;
			try {
				child = childProcess.spawn(command, args, spawnOptions);
			} catch (error) {
				finish({
					code: null, signal: null, timedOut: false,
					startError: error instanceof Error ? error.message : String(error),
				});
				return;
			}

			const emit = (chunk: { toString(): string }) => {
				for (const line of String(chunk).split(/\r?\n/)) addLine(line);
			};
			child.stdout?.on('data', emit);
			child.stderr?.on('data', emit);

			timer = setTimeout(() => {
				timedOut = true;
				try {
					child.kill();
				} catch {
					// Already exited between the timer firing and this call.
				}
			}, timeoutSec * 1000);

			child.on('error', (error: Error) => {
				finish({ code: null, signal: null, timedOut: false, startError: error.message });
			});
			child.on('close', (code, signal) => {
				finish({ code, signal, timedOut, startError: null });
			});
		});
	};

	const missing = missingDeploymentSettings(settings);
	if (missing.length > 0) {
		addLine(`[deploy] not configured — missing: ${missing.join(', ')}`);
		return { status: 'skipped', reason: 'not-configured' };
	}

	const projectDir = settings.astroProjectPath.trim();
	const vaultContentDir = settings.vaultContentPath.trim();
	const host = settings.sftpHost.trim();
	const user = settings.sftpUser.trim();
	const port = normalizePort(settings.sftpPort);
	const remotePath = settings.sftpRemotePath.trim().replace(/\/+$/, '');
	const startedAt = Date.now();

	// The run's configuration, logged before anything moves so a later failure can be read
	// back with the inputs that produced it.
	addLine(`[deploy] project: ${projectDir}`);
	addLine(`[deploy] vault: ${vaultContentDir}`);
	addLine(`[deploy] target: ${user}@${host}:${remotePath} (port ${port})`);

	// ---------------------------------------------------------------------
	// Stage 1 — content
	// ---------------------------------------------------------------------
	stage('content');

	if (!fs.existsSync(projectDir)) {
		return fail('content', `website project not found: ${projectDir}`);
	}
	if (!fs.existsSync(vaultContentDir)) {
		return fail('content', `vault content folder not found: ${vaultContentDir}`);
	}

	let content: CopyOutcome;
	try {
		content = { copied: 0, removed: 0 };
		for (const mapping of DEPLOYMENT_CONTENT_MAPPINGS) {
			const outcome = copyContentTree(
				fs,
				path,
				path.join(vaultContentDir, mapping.source),
				path.join(projectDir, mapping.target)
			);
			content.copied += outcome.copied;
			content.removed += outcome.removed;
		}
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return fail('content', `could not copy vault content: ${reason}`);
	}
	addLine(`[deploy] content: ${content.copied} file(s) copied, ${content.removed} stale file(s) removed`);

	// The project may ship its own content script; when it does, it owns frontmatter
	// normalisation, so a hand-written note missing `title`/`date`/`lang` still builds.
	if (fs.existsSync(path.join(projectDir, DEPLOYMENT_CONTENT_SCRIPT))) {
		addLine(`[deploy] running ${DEPLOYMENT_CONTENT_SCRIPT}`);
		const normalised = await run(
			'node',
			[DEPLOYMENT_CONTENT_SCRIPT, '--vault', vaultContentDir, '--quiet'],
			{ cwd: projectDir, windowsHide: true }
		);
		if (normalised.code !== 0) {
			return fail(
				'content',
				normalised.startError ?? `${DEPLOYMENT_CONTENT_SCRIPT} exited with code ${normalised.code}`,
				normalised
			);
		}
	}

	// ---------------------------------------------------------------------
	// Stage 2 — build
	// ---------------------------------------------------------------------
	stage('build');
	addLine(`[deploy] building: ${DEPLOYMENT_BUILD_COMMAND} in ${projectDir}`);

	const build = await run(DEPLOYMENT_BUILD_COMMAND, [], { cwd: projectDir, shell: true, windowsHide: true });
	if (build.code !== 0) {
		// The upload never starts: half a build published over an existing site is worse than
		// no deploy at all.
		return fail(
			'build',
			build.startError
				?? (build.timedOut ? `build timed out after ${timeoutSec}s` : `build exited with code ${build.code}`),
			build
		);
	}

	// ---------------------------------------------------------------------
	// Stage 3 — upload
	// ---------------------------------------------------------------------
	stage('upload');

	const distDir = path.join(projectDir, DEPLOYMENT_DIST_DIR);
	if (!fs.existsSync(distDir) || !fs.statSync(distDir).isDirectory()) {
		return fail('upload', `build output not found: ${distDir}`);
	}
	let fileCount = 0;
	const countFiles = (relativeDir: string): void => {
		for (const entry of fs.readdirSync(relativeDir === '' ? distDir : path.join(distDir, relativeDir), { withFileTypes: true })) {
			if (entry.isDirectory()) countFiles(relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`);
			else fileCount++;
		}
	};
	try {
		countFiles('');
	} catch (error) {
		return fail('upload', `could not read ${distDir}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (fileCount === 0) {
		return fail('upload', `${DEPLOYMENT_DIST_DIR}/ is empty — refusing to publish an empty site`);
	}

	// The password reaches sshpass through a file, never an argument, so it cannot be read out
	// of the process list. Removed again in the `finally` below.
	let passwordFile: string | null = null;
	let authPrefix: string[] = [];
	try {
		if (settings.sftpPassword !== '') {
			passwordFile = path.join(os.tmpdir(), `fit-deploy-${Date.now()}-${Math.random().toString(36).slice(2)}`);
			fs.writeFileSync(passwordFile, `${settings.sftpPassword}\n`, { mode: 0o600 });
			authPrefix = ['sshpass', '-f', passwordFile];
			addLine('[deploy] using password auth via sshpass — key auth is preferred');
		}

		const sshOptions = [
			'-p', String(port),
			'-o', 'ConnectTimeout=15',
			'-o', 'StrictHostKeyChecking=accept-new',
		];
		// Password auth cannot work in BatchMode; without a password, fail fast instead of
		// hanging on an interactive prompt that nobody can answer from inside Obsidian.
		if (authPrefix.length === 0) sshOptions.push('-o', 'BatchMode=yes');

		/** Run `program` behind the sshpass prefix when one is in use. */
		const runWithAuth = (program: string, args: string[]) => authPrefix.length === 0
			? run(program, args, { windowsHide: true })
			: run(authPrefix[0], [...authPrefix.slice(1), program, ...args], { windowsHide: true });

		const target = `${user}@${host}`;

		// rsync creates only the final path component of its destination, so the directory is
		// created explicitly first (same step, same reason, as the equivalent shell script).
		addLine(`[deploy] ensuring ${remotePath} exists on ${host}`);
		const ensure = await runWithAuth('ssh', [...sshOptions, target, `mkdir -p ${shellQuote(remotePath)}`]);
		if (ensure.code !== 0) {
			return fail(
				'upload',
				ensure.startError ?? `could not create ${remotePath} on ${host} — check host, user, port and credentials`,
				ensure
			);
		}

		const rsyncArgs = ['-a', '--human-readable', '--itemize-changes', '--delete', '-e', `ssh ${sshOptions.join(' ')}`];
		for (const pattern of DEPLOYMENT_UPLOAD_EXCLUDES) rsyncArgs.push('--exclude', pattern);
		// Trailing slash on the source: publish the *contents* of dist/, not dist/ itself.
		rsyncArgs.push(`${distDir}/`, `${target}:${remotePath}/`);

		addLine(`[deploy] uploading ${fileCount} file(s) to ${target}:${remotePath}/`);
		const upload = await runWithAuth('rsync', rsyncArgs);
		if (upload.code !== 0) {
			return fail(
				'upload',
				upload.startError
					?? (upload.timedOut ? `upload timed out after ${timeoutSec}s` : `rsync exited with code ${upload.code}`),
				upload
			);
		}
	} catch (error) {
		// Nothing in this stage may escape: the caller treats a rejection as a bug in FIT.
		return fail('upload', error instanceof Error ? error.message : String(error));
	} finally {
		if (passwordFile !== null) {
			try {
				fs.rmSync(passwordFile, { force: true });
			} catch {
				// Best effort: a leftover temp file is not worth failing an otherwise good deploy.
			}
		}
	}

	const durationMs = Date.now() - startedAt;
	addLine(
		`[deploy] ===== success in ${Math.round(durationMs / 1000)}s — ` +
		`${content.copied} file(s) copied, ${content.removed} removed, ${fileCount} uploaded from ${distDir} =====`
	);

	return {
		status: 'success',
		copied: content.copied,
		removed: content.removed,
		uploadedFrom: distDir,
		durationMs,
		output: [...output],
	};
}

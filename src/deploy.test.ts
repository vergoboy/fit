/**
 * Tests for the desktop-only deployment pipeline (`src/deploy.ts`).
 *
 * The gate and configuration tests run everywhere. The tests that exercise the
 * content → build → upload pipeline create a throwaway project and vault under the OS temp
 * directory and put fake `npm`/`node`/`ssh`/`rsync`/`sshpass` executables in front of `PATH`,
 * so the upload arguments can be asserted end to end without a real server or network. Those
 * rely on POSIX shell scripts and are skipped on Windows.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { delimiter, join } from 'path';
import { FileSystemAdapter, Platform, Vault } from 'obsidian';
import {
	DEPLOYMENT_DEFAULT_PORT,
	DEPLOYMENT_LOG_MAX_BYTES,
	deploymentConfigurationProblem,
	deploymentLogPath,
	isDeploymentSupported,
	missingDeploymentSettings,
	runDeployment,
	type DeploymentSettings,
} from './deploy';

/** Desktop Obsidian: a real filesystem adapter behind the platform flag. */
const desktopVault = () => ({ adapter: new FileSystemAdapter() }) as unknown as Vault;
/** Mobile-shaped vault: platform allows it, but the adapter is not a filesystem one. */
const nonFileSystemVault = () => ({ adapter: { getName: () => 'capacitor' } }) as unknown as Vault;

const setDesktopApp = (value: boolean) => {
	(Platform as unknown as { isDesktopApp: boolean }).isDesktopApp = value;
};

const settings = (overrides: Partial<DeploymentSettings> = {}): DeploymentSettings => ({
	enableAutoDeploy: true,
	astroProjectPath: '/tmp/project',
	vaultContentPath: '/tmp/vault',
	sftpHost: 'example.com',
	sftpPort: DEPLOYMENT_DEFAULT_PORT,
	sftpUser: 'deploy',
	sftpPassword: '',
	sftpRemotePath: '/var/www/site',
	...overrides,
});

afterEach(() => {
	setDesktopApp(true);
});

describe('isDeploymentSupported', () => {
	it('is true on desktop with a filesystem adapter', () => {
		expect(isDeploymentSupported(desktopVault())).toBe(true);
	});

	it('is false when Obsidian is not running as the desktop app', () => {
		setDesktopApp(false);
		expect(isDeploymentSupported(desktopVault())).toBe(false);
	});

	it('is false when the adapter is not a filesystem adapter', () => {
		expect(isDeploymentSupported(nonFileSystemVault())).toBe(false);
	});
});

describe('missingDeploymentSettings', () => {
	it('reports the five required fields, in settings-tab order', () => {
		const missing = missingDeploymentSettings(
			settings({
				astroProjectPath: '',
				vaultContentPath: '',
				sftpHost: '',
				sftpUser: '',
				sftpRemotePath: '',
			})
		);
		expect(missing).toEqual([
			'Astro project path',
			'Vault content path',
			'Server host',
			'Server user',
			'Remote path',
		]);
	});

	it('does not require a password, so key/agent auth stays usable', () => {
		expect(missingDeploymentSettings(settings({ sftpPassword: '' }))).toEqual([]);
	});

	it('treats whitespace-only values as missing', () => {
		expect(missingDeploymentSettings(settings({ sftpHost: '   ' }))).toEqual(['Server host']);
	});
});

describe('deploymentConfigurationProblem', () => {
	it('reports the first setting that is still empty', () => {
		expect(deploymentConfigurationProblem(settings({ sftpHost: '' })))
			.toBe('settings are incomplete — still needs Server host');
		expect(deploymentConfigurationProblem(settings({ astroProjectPath: '  ', vaultContentPath: '' })))
			.toBe('settings are incomplete — still needs Astro project path, Vault content path');
	});

	it('reports a project path that does not exist on this machine', () => {
		const problem = deploymentConfigurationProblem(settings({
			astroProjectPath: '/definitely/not/a/project',
			vaultContentPath: tmpdir(),
		}));
		expect(problem).toBe('website project not found: /definitely/not/a/project');
	});

	it('reports a vault content folder that does not exist on this machine', () => {
		const problem = deploymentConfigurationProblem(settings({
			astroProjectPath: tmpdir(),
			vaultContentPath: '/definitely/not/a/vault',
		}));
		expect(problem).toBe('vault content folder not found: /definitely/not/a/vault');
	});

	it('is null once every field is filled and both folders exist', () => {
		expect(deploymentConfigurationProblem(settings({
			astroProjectPath: tmpdir(),
			vaultContentPath: tmpdir(),
		}))).toBeNull();
	});
});

describe('deploymentLogPath', () => {
	it('points at ~/.fit-deploy.log on a desktop build', () => {
		const logPath = deploymentLogPath();
		expect(logPath).not.toBeNull();
		expect(logPath?.split(/[\\/]/).pop()).toBe('.fit-deploy.log');
	});
});

describe('runDeployment: skip paths', () => {
	it('skips when disabled, before the platform check', async () => {
		setDesktopApp(false);
		const result = await runDeployment(desktopVault(), settings({ enableAutoDeploy: false }), { logPath: null });
		expect(result).toEqual({ status: 'skipped', reason: 'disabled' });
	});

	it('skips on a platform that cannot spawn processes', async () => {
		setDesktopApp(false);
		const result = await runDeployment(desktopVault(), settings(), { logPath: null });
		expect(result).toEqual({ status: 'skipped', reason: 'unsupported-platform' });
	});

	it('skips when the adapter is not a filesystem adapter', async () => {
		const result = await runDeployment(nonFileSystemVault(), settings(), { logPath: null });
		expect(result).toEqual({ status: 'skipped', reason: 'unsupported-platform' });
	});

	it('skips when required settings are missing', async () => {
		const result = await runDeployment(desktopVault(), settings({ sftpHost: '' }), { logPath: null });
		expect(result).toEqual({ status: 'skipped', reason: 'not-configured' });
	});
});

describe.skipIf(process.platform === 'win32')('runDeployment: pipeline', () => {
	let root: string;
	let projectDir: string;
	let vaultDir: string;
	let binDir: string;
	let logFile: string;
	let runLog: string;
	let originalPath: string;

	/** Write an executable shell script, so `spawn` can find it through PATH. */
	const writeScript = (name: string, body: string) => {
		const file = join(binDir, name);
		writeFileSync(file, `#!/bin/sh\n${body}\n`);
		chmodSync(file, 0o755);
	};

	/** Stand-ins for every external program the pipeline shells out to. */
	const installFakeBinaries = () => {
		writeScript('npm', [
			'echo "npm $*" >> "$FAKE_BIN_LOG"',
			'if [ -n "$FAKE_NPM_EXIT" ]; then exit "$FAKE_NPM_EXIT"; fi',
			'mkdir -p dist',
			'if [ "$FAKE_NPM_EMPTY_DIST" = "1" ]; then exit 0; fi',
			'echo "<!doctype html>" > dist/index.html',
			'exit 0',
		].join('\n'));
		writeScript('node', [
			'echo "node $*" >> "$FAKE_BIN_LOG"',
			'if [ -n "$FAKE_NODE_EXIT" ]; then exit "$FAKE_NODE_EXIT"; fi',
			'exit 0',
		].join('\n'));
		writeScript('ssh', [
			'echo "ssh $*" >> "$FAKE_BIN_LOG"',
			'if [ -n "$FAKE_SSH_EXIT" ]; then exit "$FAKE_SSH_EXIT"; fi',
			'exit 0',
		].join('\n'));
		writeScript('rsync', [
			'echo "rsync $*" >> "$FAKE_BIN_LOG"',
			'if [ -n "$FAKE_RSYNC_EXIT" ]; then exit "$FAKE_RSYNC_EXIT"; fi',
			'exit 0',
		].join('\n'));
		// Mirrors how the pipeline invokes it: `sshpass -f <file> <program> <args...>`.
		writeScript('sshpass', [
			'echo "sshpass $*" >> "$FAKE_BIN_LOG"',
			'shift 2',
			'"$@"',
			'exit $?',
		].join('\n'));
	};

	/** Vault content: two collection folders, one unsupported extension, one hidden folder. */
	const seedVault = () => {
		mkdirSync(join(vaultDir, 'project'), { recursive: true });
		mkdirSync(join(vaultDir, 'journal'), { recursive: true });
		mkdirSync(join(vaultDir, 'project/.trash'), { recursive: true });
		writeFileSync(join(vaultDir, 'project/alpha.md'), '# alpha');
		writeFileSync(join(vaultDir, 'project/beta.mdx'), '# beta');
		writeFileSync(join(vaultDir, 'project/ignore.txt'), 'not content');
		writeFileSync(join(vaultDir, 'project/.trash/skip.md'), 'hidden');
		writeFileSync(join(vaultDir, 'journal/post.md'), '# post');
	};

	/** Pre-existing collection files: one stale, one non-content that must survive. */
	const seedTargets = () => {
		mkdirSync(join(projectDir, 'src/content/projects'), { recursive: true });
		writeFileSync(join(projectDir, 'src/content/projects/stale.md'), 'stale');
		writeFileSync(join(projectDir, 'src/content/projects/.gitkeep'), '');
	};

	const liveSettings = (overrides: Partial<DeploymentSettings> = {}) => settings({
		astroProjectPath: projectDir,
		vaultContentPath: vaultDir,
		...overrides,
	});

	/** One pipeline run, with the run log kept inside this suite's temp directory. */
	const deploy = (overrides: Partial<DeploymentSettings> = {}, options = {}) =>
		runDeployment(desktopVault(), liveSettings(overrides), { logPath: runLog, ...options });

	/** The run log this suite produced, newest entry last. */
	const runLogLines = () => readFileSync(runLog, 'utf8').split('\n').filter(line => line !== '');

	const calls = () => readFileSync(logFile, 'utf8').split('\n').filter(line => line !== '');
	const callFor = (program: string) =>
		calls().find(line => line.startsWith(`${program} `)) ?? '';

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), 'fit-deploy-test-'));
		projectDir = join(root, 'project');
		vaultDir = join(root, 'vault');
		binDir = join(root, 'bin');
		logFile = join(root, 'calls.log');
		runLog = join(root, 'fit-deploy.log');
		mkdirSync(projectDir, { recursive: true });
		mkdirSync(vaultDir, { recursive: true });
		mkdirSync(binDir, { recursive: true });
		writeFileSync(logFile, '');
		installFakeBinaries();

		originalPath = process.env.PATH ?? '';
		process.env.PATH = `${binDir}${delimiter}${originalPath}`;
		process.env.FAKE_BIN_LOG = logFile;
		delete process.env.FAKE_NPM_EXIT;
		delete process.env.FAKE_NPM_EMPTY_DIST;
		delete process.env.FAKE_NODE_EXIT;
		delete process.env.FAKE_SSH_EXIT;
		delete process.env.FAKE_RSYNC_EXIT;
	});

	afterEach(() => {
		process.env.PATH = originalPath;
		delete process.env.FAKE_BIN_LOG;
		delete process.env.FAKE_NPM_EXIT;
		delete process.env.FAKE_NPM_EMPTY_DIST;
		delete process.env.FAKE_NODE_EXIT;
		delete process.env.FAKE_SSH_EXIT;
		delete process.env.FAKE_RSYNC_EXIT;
		rmSync(root, { recursive: true, force: true });
	});

	it('copies vault content into the collections, prunes stale files, and keeps non-content', async () => {
		seedVault();
		seedTargets();

		const result = await deploy();

		expect(result.status).toBe('success');
		if (result.status !== 'success') throw new Error('expected success');
		expect(result.copied).toBe(3);
		expect(result.removed).toBe(1);

		expect(existsSync(join(projectDir, 'src/content/projects/alpha.md'))).toBe(true);
		expect(existsSync(join(projectDir, 'src/content/projects/beta.mdx'))).toBe(true);
		expect(existsSync(join(projectDir, 'src/content/journal/post.md'))).toBe(true);
		// Stale collection entry pruned; `.gitkeep` and non-content sources untouched.
		expect(existsSync(join(projectDir, 'src/content/projects/stale.md'))).toBe(false);
		expect(existsSync(join(projectDir, 'src/content/projects/.gitkeep'))).toBe(true);
		expect(existsSync(join(projectDir, 'src/content/projects/ignore.txt'))).toBe(false);
		expect(existsSync(join(projectDir, 'src/content/projects/skip.md'))).toBe(false);
		expect(callFor('npm')).toBe('npm run build');
	});

	it('aborts before upload when the build fails', async () => {
		seedVault();
		process.env.FAKE_NPM_EXIT = '2';

		const result = await deploy();

		expect(result).toMatchObject({ status: 'failed', stage: 'build', exitCode: 2, timedOut: false });
		expect(callFor('ssh')).toBe('');
		expect(callFor('rsync')).toBe('');
	});

	it('refuses to publish an empty dist/', async () => {
		seedVault();
		process.env.FAKE_NPM_EMPTY_DIST = '1';

		const result = await deploy();

		expect(result).toMatchObject({ status: 'failed', stage: 'upload' });
		if (result.status !== 'failed') throw new Error('expected failure');
		expect(result.message).toContain('empty');
		expect(callFor('rsync')).toBe('');
	});

	it('runs the project content script and aborts before build when it fails', async () => {
		seedVault();
		mkdirSync(join(projectDir, 'scripts'), { recursive: true });
		writeFileSync(join(projectDir, 'scripts/sync-content.mjs'), '// normalise');
		process.env.FAKE_NODE_EXIT = '1';

		const result = await deploy();

		expect(result).toMatchObject({ status: 'failed', stage: 'content', exitCode: 1 });
		expect(callFor('node')).toBe(`node scripts/sync-content.mjs --vault ${vaultDir} --quiet`);
		expect(callFor('npm')).toBe('');
	});

	it('publishes dist/ with the expected ssh and rsync arguments', async () => {
		seedVault();

		const result = await deploy();

		expect(result.status).toBe('success');
		if (result.status !== 'success') throw new Error('expected success');
		expect(result.uploadedFrom).toBe(join(projectDir, 'dist'));

		const ssh = callFor('ssh');
		expect(ssh).toContain('-p 22');
		expect(ssh).toContain('-o ConnectTimeout=15');
		expect(ssh).toContain('-o StrictHostKeyChecking=accept-new');
		expect(ssh).toContain('-o BatchMode=yes');
		expect(ssh).toContain('deploy@example.com');
		expect(ssh).toContain("mkdir -p '/var/www/site'");

		const rsync = callFor('rsync');
		expect(rsync).toContain('rsync -a --human-readable --itemize-changes --delete');
		expect(rsync).toContain('-e ssh -p 22 -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new -o BatchMode=yes');
		expect(rsync).toContain('--exclude .DS_Store --exclude *.log --exclude *.map');
		// Trailing slashes: publish the *contents* of dist/ into the remote path.
		expect(rsync.endsWith(`${join(projectDir, 'dist')}/ deploy@example.com:/var/www/site/`)).toBe(true);
		expect(callFor('sshpass')).toBe('');
	});

	it('passes a configured password through sshpass and removes the temp file', async () => {
		seedVault();

		const result = await deploy({ sftpPassword: 'hunter2' });
		expect(result.status).toBe('success');

		const sshpass = callFor('sshpass');
		expect(sshpass.startsWith('sshpass -f ')).toBe(true);
		// The password itself never reaches an argument (or the process list).
		expect(calls().join('\n')).not.toContain('hunter2');
		// Password auth rules out BatchMode.
		expect(callFor('ssh')).not.toContain('-o BatchMode=yes');

		const passwordFile = sshpass.split(' ')[2];
		expect(existsSync(passwordFile)).toBe(false);
	});

	it('reports an upload failure when the remote directory cannot be created', async () => {
		seedVault();
		process.env.FAKE_SSH_EXIT = '255';

		const result = await deploy();

		expect(result).toMatchObject({ status: 'failed', stage: 'upload', exitCode: 255 });
		if (result.status !== 'failed') throw new Error('expected failure');
		expect(result.message).toContain('could not create /var/www/site');
		expect(callFor('rsync')).toBe('');
	});

	it('reports a non-zero rsync exit code as an upload failure', async () => {
		seedVault();
		process.env.FAKE_RSYNC_EXIT = '23';

		const result = await deploy();

		expect(result).toMatchObject({ status: 'failed', stage: 'upload' });
		if (result.status !== 'failed') throw new Error('expected failure');
		expect(result.message).toContain('rsync exited with code 23');
	});

	it('appends the configuration, every stage and the verdict to the run log', async () => {
		seedVault();
		seedTargets();

		const result = await deploy();

		expect(result.status).toBe('success');
		const lines = runLogLines();
		expect(lines.length).toBeGreaterThan(5);
		// Timestamp first on every line, so `tail -f ~/.fit-deploy.log` reads as a history.
		for (const line of lines) expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T\S+Z /);

		const text = lines.join('\n');
		expect(text).toContain(`[deploy] project: ${projectDir}`);
		expect(text).toContain(`[deploy] vault: ${vaultDir}`);
		expect(text).toContain('[deploy] target: deploy@example.com:/var/www/site (port 22)');
		expect(text).toContain('[deploy] stage: content');
		expect(text).toContain('[deploy] stage: build');
		expect(text).toContain('[deploy] stage: upload');
		expect(text).toMatch(/\[deploy\] ===== success in \d+s — 3 file\(s\) copied, 1 removed, \d+ uploaded from /);
	});

	it('logs the verdict of a failed run, including the failing command output', async () => {
		seedVault();
		process.env.FAKE_NPM_EXIT = '2';

		const result = await deploy();

		expect(result.status).toBe('failed');
		const lines = runLogLines();
		const text = lines.join('\n');
		expect(text).toContain('[deploy] ===== run failed during build — build exited with code 2 =====');
		// The verdict is written last, so the tail of the file is always how the run ended.
		expect(lines[lines.length - 1]).toContain('===== run failed during build');
		// The child's own stdout is appended as it arrives, not only kept in memory.
		expect(text).toContain('npm run build');
	});

	it('creates collection folders that hold no notes, so an empty language branch still ships', async () => {
		mkdirSync(join(vaultDir, 'project', 'en'), { recursive: true });
		// `journal/` is not created in the vault at all.

		const result = await deploy();

		expect(result.status).toBe('success');
		expect(existsSync(join(projectDir, 'src/content/projects/en'))).toBe(true);
		expect(existsSync(join(projectDir, 'src/content/journal'))).toBe(true);
	});

	it('rotates a run log that has grown past the size limit', async () => {
		seedVault();
		writeFileSync(runLog, 'x'.repeat(DEPLOYMENT_LOG_MAX_BYTES + 1));

		const result = await deploy();

		expect(result.status).toBe('success');
		const overflow = `${runLog}.1`;
		expect(existsSync(overflow)).toBe(true);
		expect(readFileSync(overflow, 'utf8')).toHaveLength(DEPLOYMENT_LOG_MAX_BYTES + 1);
		// The active log restarts with this run instead of carrying the overflow over.
		const active = readFileSync(runLog, 'utf8');
		expect(active.length).toBeLessThan(DEPLOYMENT_LOG_MAX_BYTES);
		expect(active).toContain('[deploy] stage: content');
	});

	it('rotates again mid-run when this run alone pushes the log past the cap', async () => {
		seedVault();
		// Just under the cap at run start: the start-of-run check leaves it alone, so it is
		// this run's own lines that tip it over.
		writeFileSync(runLog, 'y'.repeat(DEPLOYMENT_LOG_MAX_BYTES - 50));

		const result = await deploy();

		expect(result.status).toBe('success');
		const overflow = `${runLog}.1`;
		expect(existsSync(overflow)).toBe(true);
		expect(readFileSync(overflow, 'utf8')).toContain('yyyy');
		// The fresh generation holds the rest of the run — stages included — not the seed.
		const active = readFileSync(runLog, 'utf8');
		expect(active).not.toContain('yyyy');
		expect(active).toContain('[deploy] stage: upload');
		expect(active.length).toBeLessThan(DEPLOYMENT_LOG_MAX_BYTES);
	});
});

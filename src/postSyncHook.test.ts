/**
 * Tests for the desktop-only post-sync hook.
 *
 * The gate tests run everywhere; the tests that actually spawn a process use POSIX shell
 * commands and are skipped on Windows, where the CI matrix does not run anyway.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { FileSystemAdapter, Platform, Vault } from 'obsidian';
import {
	POST_SYNC_HOOK_MAX_OUTPUT_LINES,
	isPostSyncHookSupported,
	runPostSyncHook,
	type PostSyncHookOptions,
} from './postSyncHook';

/** Desktop Obsidian: a real filesystem adapter behind the platform flag. */
const desktopVault = () => ({ adapter: new FileSystemAdapter() }) as unknown as Vault;
/** Mobile-shaped vault: platform allows it, but the adapter is not a filesystem one. */
const nonFileSystemVault = () => ({ adapter: { getName: () => 'capacitor' } }) as unknown as Vault;

const setDesktopApp = (value: boolean) => {
	(Platform as unknown as { isDesktopApp: boolean }).isDesktopApp = value;
};

const options = (overrides: Partial<PostSyncHookOptions> = {}): PostSyncHookOptions => ({
	enabled: true,
	command: 'echo hello',
	cwd: '',
	timeoutSec: 30,
	...overrides,
});

afterEach(() => {
	setDesktopApp(true);
});

describe('isPostSyncHookSupported', () => {
	it('is true on desktop with a filesystem adapter', () => {
		expect(isPostSyncHookSupported(desktopVault())).toBe(true);
	});

	it('is false when Obsidian is not running as the desktop app', () => {
		setDesktopApp(false);
		expect(isPostSyncHookSupported(desktopVault())).toBe(false);
	});

	it('is false when the adapter is not a filesystem adapter', () => {
		expect(isPostSyncHookSupported(nonFileSystemVault())).toBe(false);
	});
});

describe('runPostSyncHook: skip paths', () => {
	it('skips without spawning when disabled', async () => {
		const result = await runPostSyncHook(desktopVault(), options({ enabled: false }));
		expect(result).toEqual({ status: 'skipped', reason: 'disabled' });
	});

	it('skips on a platform that cannot run it', async () => {
		setDesktopApp(false);
		const result = await runPostSyncHook(desktopVault(), options());
		expect(result).toEqual({ status: 'skipped', reason: 'unsupported-platform' });
	});

	it('skips when the adapter is not a filesystem adapter', async () => {
		const result = await runPostSyncHook(nonFileSystemVault(), options());
		expect(result).toEqual({ status: 'skipped', reason: 'unsupported-platform' });
	});

	it('skips when no command is configured', async () => {
		const result = await runPostSyncHook(desktopVault(), options({ command: '   ' }));
		expect(result).toEqual({ status: 'skipped', reason: 'not-configured' });
	});

	it('reports disabled before unsupported, so a mobile device never contradicts the toggle', async () => {
		setDesktopApp(false);
		const result = await runPostSyncHook(desktopVault(), options({ enabled: false }));
		expect(result).toEqual({ status: 'skipped', reason: 'disabled' });
	});
});

describe.skipIf(process.platform === 'win32')('runPostSyncHook: spawning', () => {
	it('resolves success and captures stdout', async () => {
		const result = await runPostSyncHook(desktopVault(), options({ command: 'echo hello' }));
		expect(result.status).toBe('success');
		expect(result).toMatchObject({ exitCode: 0 });
		if (result.status !== 'success') throw new Error('expected success');
		expect(result.output).toContain('hello');
	});

	it('captures stderr as well as stdout', async () => {
		const result = await runPostSyncHook(desktopVault(), options({ command: 'echo oops 1>&2' }));
		if (result.status !== 'success') throw new Error('expected success');
		expect(result.output).toContain('oops');
	});

	it('reports a non-zero exit code as a failure, not a throw', async () => {
		const result = await runPostSyncHook(desktopVault(), options({ command: 'exit 3' }));
		expect(result).toMatchObject({ status: 'failed', exitCode: 3, timedOut: false });
	});

	it('reports a command the shell cannot resolve as a failure', async () => {
		// `shell: true` means a bad command name is a 127 from the shell, not a spawn error.
		const result = await runPostSyncHook(
			desktopVault(),
			options({ command: 'this-command-does-not-exist-9f8e7d6c' })
		);
		expect(result).toMatchObject({ status: 'failed', exitCode: 127 });
	});

	it('streams each output line to onOutput', async () => {
		const seen: string[] = [];
		await runPostSyncHook(
			desktopVault(),
			options({ command: "printf 'a\\nb\\n'", onOutput: (line) => seen.push(line) })
		);
		expect(seen).toEqual(['a', 'b']);
	});

	it('caps retained output at POST_SYNC_HOOK_MAX_OUTPUT_LINES', async () => {
		const lineCount = POST_SYNC_HOOK_MAX_OUTPUT_LINES + 50;
		const result = await runPostSyncHook(desktopVault(), options({ command: `seq 1 ${lineCount}` }));
		if (result.status !== 'success') throw new Error('expected success');
		expect(result.output).toHaveLength(POST_SYNC_HOOK_MAX_OUTPUT_LINES);
		// Oldest lines are dropped, so the tail of the output survives.
		expect(result.output[result.output.length - 1]).toBe(String(lineCount));
	});

	it('runs in the configured working directory', async () => {
		const result = await runPostSyncHook(desktopVault(), options({ command: 'pwd', cwd: tmpdir() }));
		if (result.status !== 'success') throw new Error('expected success');
		expect(result.output.join('\n')).toContain(tmpdir());
	});

	it('kills a command that exceeds the timeout', async () => {
		const result = await runPostSyncHook(
			desktopVault(),
			options({ command: 'sleep 30', timeoutSec: 1 })
		);
		expect(result).toMatchObject({ status: 'failed', timedOut: true });
	}, 10000);
});

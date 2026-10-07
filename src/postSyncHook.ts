/**
 * Desktop-only post-sync hook.
 *
 * Runs one user-configured shell command after a sync that actually pushed a commit to
 * GitHub — for example "rebuild my Astro site and rsync it to the server". This is the
 * single deliberate desktop-only exception in the plugin, so it follows the rules in
 * docs/api-compatibility.md § Desktop-only exceptions:
 *
 * - It is never reached at module load: `require('child_process')` runs lazily, inside
 *   `runPostSyncHook`, and only after `isPostSyncHookSupported()` has confirmed a real
 *   filesystem adapter (desktop Obsidian).
 * - `child_process` is the only Node built-in it may use; `Buffer` and `process` stay
 *   banned here too (see the per-file block in eslint.config.js).
 * - Everything it enables degrades gracefully without it: on mobile, when disabled, or
 *   when the module fails to resolve, the result is a `skipped` outcome and nothing else
 *   depends on it. No caller sees an exception from this file.
 *
 * The command is spawned, not awaited by the sync itself, so a slow build never delays
 * sync completion; the caller reports progress through the `onOutput` callback.
 *
 * @see docs/post-sync-hook.md
 */
import { FileSystemAdapter, Platform, Vault } from 'obsidian';

/** Retained output lines. A chatty build should not grow memory without bound. */
export const POST_SYNC_HOOK_MAX_OUTPUT_LINES = 200;

/** A `child_process` output stream, as far as this file needs it. */
interface OutputStreamLike {
	on(event: 'data', listener: (chunk: { toString(): string }) => void): void;
}

/**
 * The subset of `child_process.ChildProcess` this file uses. Declared locally rather
 * than imported from `child_process`: a static type import of a Node built-in is exactly
 * what the mobile-compatibility checks reject.
 */
interface ChildProcessLike {
	pid?: number;
	stdout: OutputStreamLike | null;
	stderr: OutputStreamLike | null;
	on(event: 'error', listener: (error: Error) => void): void;
	on(event: 'close', listener: (code: number | null, signal: string | null) => void): void;
	kill(signal?: string): boolean;
}

/** The subset of the `child_process` module this file uses. */
interface ChildProcessModuleLike {
	spawn(
		command: string,
		options: { cwd?: string; shell: boolean; windowsHide: boolean }
	): ChildProcessLike;
}

/** Why the hook did not run at all. Distinct from a hook that ran and failed. */
export type PostSyncHookSkipReason = 'disabled' | 'unsupported-platform' | 'not-configured';

/** Outcome of one hook invocation. */
export type PostSyncHookResult =
	| { status: 'skipped'; reason: PostSyncHookSkipReason }
	| { status: 'success'; exitCode: 0; output: string[] }
	| { status: 'failed'; exitCode: number | null; signal: string | null; timedOut: boolean; output: string[] };

export interface PostSyncHookOptions {
	/** Opt-in toggle. A disabled hook never spawns anything. */
	enabled: boolean;
	/** Shell command line, e.g. `bash scripts/deploy.sh`. */
	command: string;
	/** Working directory for the command. Empty means the Obsidian process CWD. */
	cwd: string;
	/** Hard timeout in seconds; the process is killed once it elapses. */
	timeoutSec: number;
	/** Called for each output line as it arrives, for live logging. */
	onOutput?: (line: string) => void;
}

/**
 * Whether a post-sync hook can run on this device.
 *
 * Both conditions are load-bearing. `Platform.isDesktopApp` is the primary gate (it is
 * false on iOS/Android, where there is no Node.js runtime to spawn anything with), and
 * the adapter check confirms Obsidian is actually running against a real filesystem
 * rather than a mobile/capacitor adapter.
 */
export function isPostSyncHookSupported(vault: Vault): boolean {
	if (!Platform.isDesktopApp) {
		return false;
	}
	return vault.adapter instanceof FileSystemAdapter;
}

/**
 * Run the configured post-sync command.
 *
 * Resolves — never rejects — so a failing deploy cannot masquerade as a failed sync.
 * Callers distinguish "didn't run" (`skipped`) from "ran and failed" (`failed`).
 */
export function runPostSyncHook(vault: Vault, options: PostSyncHookOptions): Promise<PostSyncHookResult> {
	if (!options.enabled) {
		return Promise.resolve({ status: 'skipped', reason: 'disabled' });
	}
	if (!isPostSyncHookSupported(vault)) {
		return Promise.resolve({ status: 'skipped', reason: 'unsupported-platform' });
	}

	const command = options.command.trim();
	if (command === '') {
		return Promise.resolve({ status: 'skipped', reason: 'not-configured' });
	}

	let spawn: ChildProcessModuleLike['spawn'];
	try {
		// Deliberately `require`, not `import()`: in Obsidian's renderer a bare dynamic
		// import of a Node built-in is left as a native dynamic import and fails to
		// resolve, while `require` works. Reached only on desktop, behind the checks above.
		const childProcess = require('child_process') as ChildProcessModuleLike;
		spawn = childProcess.spawn;
	} catch {
		// Node runtime unavailable after all (or the module failed to load) — treat the
		// same as running on a platform that cannot support the hook.
		return Promise.resolve({ status: 'skipped', reason: 'unsupported-platform' });
	}

	return new Promise<PostSyncHookResult>((resolve) => {
		const output: string[] = [];
		let settled = false;
		let timedOut = false;
		let timer: ReturnType<typeof setTimeout> | null = null;

		const emit = (chunk: { toString(): string }) => {
			for (const line of String(chunk).split(/\r?\n/)) {
				if (line.trim() === '') continue;
				output.push(line);
				if (output.length > POST_SYNC_HOOK_MAX_OUTPUT_LINES) output.shift();
				try {
					options.onOutput?.(line);
				} catch {
					// A failing log consumer must not take down the hook.
				}
			}
		};

		const finish = (result: PostSyncHookResult) => {
			if (settled) return;
			settled = true;
			if (timer !== null) clearTimeout(timer);
			resolve(result);
		};

		let child: ChildProcessLike;
		try {
			child = spawn(command, {
				cwd: options.cwd.trim() === '' ? undefined : options.cwd.trim(),
				shell: true,
				windowsHide: true,
			});
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			finish({ status: 'failed', exitCode: null, signal: null, timedOut: false, output: [reason] });
			return;
		}

		child.stdout?.on('data', emit);
		child.stderr?.on('data', emit);

		timer = setTimeout(() => {
			timedOut = true;
			try {
				child.kill();
			} catch {
				// Already exited between the timer firing and this call.
			}
		}, Math.max(1, options.timeoutSec) * 1000);

		child.on('error', (error: Error) => {
			finish({
				status: 'failed', exitCode: null, signal: null, timedOut: false,
				output: [...output, error.message],
			});
		});

		child.on('close', (code: number | null, signal: string | null) => {
			if (timedOut) {
				finish({ status: 'failed', exitCode: code, signal, timedOut: true, output });
				return;
			}
			if (code === 0) {
				finish({ status: 'success', exitCode: 0, output });
				return;
			}
			finish({ status: 'failed', exitCode: code, signal, timedOut: false, output });
		});
	});
}

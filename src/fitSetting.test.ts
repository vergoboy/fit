/**
 * FitSettingTab Integration Tests
 *
 * Purpose: Test settings UI interactions and data flow between UI and orchestration classes.
 * Scope: DOM manipulation, API calls triggered by user interactions, state updates.
 *
 * Test Strategy:
 * - Use real FitSettingTab instance with faked dependencies (GitHubConnection, plugin)
 * - Build actual DOM using githubUserInfoBlock() and repoInfoBlock()
 * - Verify behavior by interacting with real DOM elements and checking results
 * - Focus on user-observable behavior, not internal implementation details
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { FileSystemAdapter } from 'obsidian';
import FitSettingTab from './fitSettingTab';
import { FitLogger } from './logger';
import { DEFAULT_SETTINGS } from '@/fitSettings';
import { deploymentLogPath } from '@/deploy';

const EMPTY_SETTINGS = { ...DEFAULT_SETTINGS };

// Helper functions to find elements by their user-visible labels
function findInputByLabel(container: HTMLElement, labelText: string): HTMLInputElement | null {
	const settings = Array.from(container.querySelectorAll('.setting-item'));
	for (const setting of settings) {
		const nameEl = setting.querySelector('.setting-item-name');
		if (nameEl?.textContent === labelText) {
			const input = setting.querySelector('input[type="text"]') as HTMLInputElement;
			return input || null;
		}
	}
	return null;
}

function findButtonByText(container: HTMLElement, buttonText: string): HTMLButtonElement | null {
	const buttons = Array.from(container.querySelectorAll('button'));
	return buttons.find(btn => btn.textContent === buttonText) as HTMLButtonElement || null;
}

describe('FitSettingTab - GitHub settings', () => {
	let consoleLogSpy: MockInstance<typeof console.log>;
	let consoleErrorSpy: MockInstance<typeof console.error>;
	let mockLogger: FitLogger;

	beforeEach(() => {
		// Create mock logger for tests
		mockLogger = new FitLogger({ adapter: null });

		// Capture console output for debugging failed tests
		const consoleLogCapture: any[] = [];
		const consoleErrorCapture: any[] = [];

		consoleLogSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
			consoleLogCapture.push(['log', args]);
		});
		consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
			consoleErrorCapture.push(['error', args]);
		});

		// Store captures for afterEach to access
		(global as any).__testConsoleCapture = { log: consoleLogCapture, error: consoleErrorCapture };

		// Scoped: unscoped useFakeTimers() hangs under Node 18 (vitest 4.1 + Node 18's
		// microtask/timer interaction) — deterministic, reproduced outside CI via Docker.
		vi.useFakeTimers({
			toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
		});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.resetAllMocks();

		// Check if test failed - if so, replay captured console output
		const testState = (expect as any).getState();
		const testFailed = testState.currentTestName && testState.assertionCalls > testState.numPassingAsserts;

		const captures = (global as any).__testConsoleCapture;
		// Restore console first (otherwise console.log won't work)
		consoleLogSpy.mockRestore();
		consoleErrorSpy.mockRestore();
		if (testFailed && captures && (captures.log.length > 0 || captures.error.length > 0)) {
			console.log('\n==================== CAPTURED CONSOLE OUTPUT (TEST FAILED) ====================');

			// Replay all captured logs in order
			for (const [, args] of captures.log) {
				console.log('[LOG]', ...args);
			}
			for (const [, args] of captures.error) {
				console.error('[ERROR]', ...args);
			}

			console.log('================================================================================\n');
		}

		// Clean up global
		delete (global as any).__testConsoleCapture;
	});

	it('should have Authenticate button disabled when PAT is missing', async () => {
		const fakePlugin: any = {
			githubConnection: null,
			settings: { ...EMPTY_SETTINGS, pat: '' },
			saveSettings: async () => {},
			fit: {
				clearRemoteVault: () => {},
			},
			logger: mockLogger
		};

		const settingTab = new FitSettingTab({} as any, fakePlugin);

		// Build UI
		settingTab.githubUserInfoBlock();
		await settingTab.repoInfoBlock();

		// Verify: Authenticate button is disabled when no PAT
		const authenticateButton = findButtonByText(settingTab.containerEl, 'Authenticate user')!;
		expect(authenticateButton.disabled).toBe(true);

		// When: click attempted on disabled button
		authenticateButton.click();

		// Then: Should not enter authenticating state
		expect(settingTab.authenticating).toBe(false);
	});

	it('should authenticate and populate all suggestion lists', async () => {
		const fakeConnection: any = {
			getAuthenticatedUser: async () => ({ owner: 'alice', avatarUrl: 'http://example.com/avatar.png' }),
			getAccessibleOwners: async () => ['alice', 'bob'],
			getReposForOwner: async () => ['repo1', 'repo2']
		};

		const fakePlugin: any = {
			githubConnection: null,
			lastGithubConnectionPat: null,
			settings: { ...EMPTY_SETTINGS, pat: '' },
			saveSettings: async () => {
				// Simulate main.ts saveSettings creating GitHubConnection
				if (fakePlugin.settings.pat && fakePlugin.settings.pat !== fakePlugin.lastGithubConnectionPat) {
					fakePlugin.githubConnection = fakeConnection;
					fakePlugin.lastGithubConnectionPat = fakePlugin.settings.pat;
				}
			},
			fit: {
				clearRemoteVault: () => {},
			},
			logger: mockLogger
		};

		const settingTab = new FitSettingTab({} as any, fakePlugin);

		// Build UI
		settingTab.githubUserInfoBlock();
		await settingTab.repoInfoBlock();

		// Get inputs by their labels (user-visible text)
		const patInput = findInputByLabel(settingTab.containerEl, 'Github personal access token')!;
		const ownerInput = findInputByLabel(settingTab.containerEl, 'Repository owner')!;
		const repoInput = findInputByLabel(settingTab.containerEl, 'Repository name')!;

		// Verify: Start in unauthenticated state
		expect(ownerInput.placeholder).toBe('Authenticate above to auto-fill');
		expect(repoInput.placeholder).toBe('Authenticate above for suggestions');

		// When: User enters PAT
		patInput.value = 'ghp_test';
		patInput.dispatchEvent(new Event('input', { bubbles: true }));
		await vi.advanceTimersByTimeAsync(0);  // Wait for async saveSettings

		// Then: GitHubConnection created, placeholders updated
		expect(fakePlugin.githubConnection).not.toBeNull();
		expect(ownerInput.placeholder).toBe('owner-username');
		expect(repoInput.placeholder).toBe('repo-name');

		// When: User clicks authenticate button
		const authenticateButton = findButtonByText(settingTab.containerEl, 'Authenticate user')!;
		expect(authenticateButton.disabled).toBe(false);  // Should be enabled now
		authenticateButton.click();
		await vi.advanceTimersByTimeAsync(0);  // Wait for async saveSettings

		// Then: Owner pre-filled with authenticated user
		expect(ownerInput.value).toBe('alice');
		expect(fakePlugin.settings.owner).toBe('alice');

		// And: Owner/repo suggestions populated (via AbstractInputSuggest)
		const ownerSuggest = (settingTab as any).ownerSuggest;
		expect(ownerSuggest).toBeDefined();
		expect(ownerSuggest.getSuggestions('')).toEqual(['alice', 'bob']);

		const repoSuggest = (settingTab as any).repoSuggest;
		expect(repoSuggest).toBeDefined();
		expect(repoSuggest.getSuggestions('')).toEqual(['repo1', 'repo2']);
	});

	it('should refresh suggestions for different owners', async () => {
		const fakeConnection: any = {
			getAuthenticatedUser: async () => ({ owner: 'alice', avatarUrl: '' }),
			getAccessibleOwners: async () => ['alice', 'bob'],
			getReposForOwner: async (owner: string) => {
				if (owner === 'alice') return ['repo1', 'repo2', 'repo3'];
				if (owner === 'bob') return ['bob-repo1', 'bob-repo2'];
				return [];
			}
		};
		const fakePlugin: any = {
			githubConnection: fakeConnection,
			settings: { ...EMPTY_SETTINGS, pat: 'ghp_test', owner: 'alice' },
			saveSettings: async () => {},
			fit: {
				clearRemoteVault: () => {},
			},
			logger: mockLogger
		};

		const settingTab = new FitSettingTab({} as any, fakePlugin);

		// Build UI
		settingTab.githubUserInfoBlock();
		await settingTab.repoInfoBlock();

		// When: User clicks refresh
		const refreshButton = (settingTab as any).refreshButton.querySelector('button') as HTMLButtonElement;
		refreshButton.click();

		await vi.advanceTimersByTimeAsync(0);  // Wait for async saveSettings

		// Then: Repo suggestions show alice's repos (via AbstractInputSuggest)
		const repoSuggest = (settingTab as any).repoSuggest;
		expect(repoSuggest).toBeDefined();
		let suggestions = repoSuggest.getSuggestions('');
		expect(suggestions).toEqual(['repo1', 'repo2', 'repo3']);

		// When: User changes owner to bob via UI input and refreshes
		const ownerInput = findInputByLabel(settingTab.containerEl, 'Repository owner')!;
		ownerInput.value = 'bob';
		ownerInput.dispatchEvent(new Event('input', { bubbles: true }));
		await vi.advanceTimersByTimeAsync(0);  // Wait for debounced repo fetching

		refreshButton.click();

		await vi.advanceTimersByTimeAsync(0);  // Wait for async saveSettings

		// Then: Repo suggestions update to show bob's repos
		suggestions = repoSuggest.getSuggestions('');
		expect(suggestions).toEqual(['bob-repo1', 'bob-repo2']);
	});

	it('should populate branch dropdown when owner and repo are set', async () => {
		const fakeConnection: any = {
			getAuthenticatedUser: async () => ({ owner: 'alice', avatarUrl: '' }),
			getAccessibleOwners: async () => ['alice'],
			getReposForOwner: async () => ['vault-repo'],
			getBranches: async (owner: string, repo: string) => {
				if (owner === 'alice' && repo === 'vault-repo') {
					return ['main', 'develop', 'feature-x'];
				}
				return [];
			}
		};
		const fakePlugin: any = {
			githubConnection: fakeConnection,
			settings: { ...EMPTY_SETTINGS, pat: 'ghp_test', owner: 'alice', repo: 'vault-repo' },
			saveSettings: async () => {},
			fit: {
				clearRemoteVault: () => {},
			},
			logger: mockLogger
		};

		const settingTab = new FitSettingTab({} as any, fakePlugin);

		// Build UI
		settingTab.githubUserInfoBlock();
		await settingTab.repoInfoBlock();

		// When: User clicks refresh
		const refreshButton = (settingTab as any).refreshButton.querySelector('button') as HTMLButtonElement;
		refreshButton.click();

		await vi.advanceTimersByTimeAsync(0);  // Wait for async saveSettings

		// Then: Branch dropdown is populated
		const branchDropdown = settingTab.containerEl.querySelector('.branch-dropdown') as HTMLSelectElement;
		const branches = Array.from(branchDropdown.options).map(opt => opt.value);
		expect(branches).toEqual(['main', 'develop', 'feature-x']);
	});

	it.each([
		['github.com', 'https://github.com/bob/project-x/tree/feature-123'],
		['github.example.com', 'https://github.example.com/bob/project-x/tree/feature-123'],
	])('should generate correct GitHub link for owner/repo/branch on host %j', async (githubHost, expectedLink) => {
		const fakePlugin: any = {
			githubConnection: null,
			settings: { githubHost, owner: 'bob', repo: 'project-x', branch: 'feature-123' },
			logger: mockLogger
		};

		const settingTab = new FitSettingTab({} as any, fakePlugin);

		// Verify: Link uses settings values
		expect(settingTab.getLatestLink()).toBe(expectedLink);
	});

	it('should clear branches when fetching fails (repo not found)', async () => {
		const fakeConnection: any = {
			getAuthenticatedUser: async () => ({ owner: 'alice', avatarUrl: '' }),
			getAccessibleOwners: async () => ['alice'],
			getReposForOwner: async () => ['vault-repo'],
			getBranches: async (_owner: string, repo: string) => {
				if (repo === 'nonexistent') {
					throw new Error("Repository not found");
				}
				return ['main'];
			}
		};
		const fakePlugin: any = {
			githubConnection: fakeConnection,
			settings: { ...EMPTY_SETTINGS, pat: 'ghp_test', owner: 'alice', repo: 'nonexistent' },
			saveSettings: async () => {},
			fit: {
				clearRemoteVault: () => {},
			},
			logger: mockLogger
		};

		const settingTab = new FitSettingTab({} as any, fakePlugin);

		// Build UI
		settingTab.githubUserInfoBlock();
		await settingTab.repoInfoBlock();

		// When: User clicks refresh for nonexistent repo
		const refreshButton = (settingTab as any).refreshButton.querySelector('button') as HTMLButtonElement;
		refreshButton.click();

		await vi.advanceTimersByTimeAsync(0);  // Wait for async saveSettings

		// Then: Branch dropdown is cleared (graceful degradation)
		const branchDropdown = settingTab.containerEl.querySelector('.branch-dropdown') as HTMLSelectElement;
		expect(branchDropdown.options.length).toBe(0);
		expect(settingTab.existingBranches).toEqual([]);
	});

	it('should enable authenticate button when githubConnection becomes available', async () => {
		const fakeConnection: any = {
			getAuthenticatedUser: async () => ({ owner: 'alice', avatarUrl: 'http://example.com/avatar.png' }),
			getAccessibleOwners: async () => ['alice'],
			getReposForOwner: async () => []
		};
		const fakePlugin: any = {
			githubConnection: null, // Starts with no connection
			settings: { ...EMPTY_SETTINGS },
			saveSettings: async () => {},
			fit: { clearRemoteVault: () => {} },
			logger: mockLogger
		};

		const settingTab = new FitSettingTab({} as any, fakePlugin);

		// Build UI
		settingTab.githubUserInfoBlock();
		await settingTab.repoInfoBlock();

		const authenticateButton = findButtonByText(settingTab.containerEl, 'Authenticate user')!;

		// Verify: Button starts disabled (no connection)
		expect(authenticateButton.disabled).toBe(true);

		// When: githubConnection becomes available
		fakePlugin.githubConnection = fakeConnection;
		(settingTab as any).updateButtonStates();

		// Then: Button is enabled
		expect(authenticateButton.disabled).toBe(false);

		// And: Clicking works
		authenticateButton.click();
		await vi.advanceTimersByTimeAsync(0);  // Wait for async saveSettings

		expect(settingTab.containerEl.querySelector('.fit-github-handle')?.textContent).toBe('alice');
	});

	describe('Debouncing and performance fixes', () => {
		it('should debounce repo fetching to prevent UI grinding', async () => {
			let fetchCount = 0;
			const fakeConnection: any = {
				getAuthenticatedUser: async () => ({ owner: 'alice', avatarUrl: '' }),
				getAccessibleOwners: async () => ['alice'],
				getReposForOwner: async (owner: string) => {
					fetchCount++;
					return owner === 'the' ? Array(100).fill(null).map((_, i) => `repo-${i}`) : [];
				}
			};
			const fakePlugin: any = {
				githubConnection: fakeConnection,
				settings: { ...EMPTY_SETTINGS, pat: 'ghp_test', owner: '' },
				saveSettings: async () => {},
				fit: { clearRemoteVault: () => {} },
				logger: mockLogger
			};

			const settingTab = new FitSettingTab({} as any, fakePlugin);
			settingTab.githubUserInfoBlock();
			await settingTab.repoInfoBlock();

			const ownerInput = findInputByLabel(settingTab.containerEl, 'Repository owner')!;

			// When: User types "the" character by character
			ownerInput.value = 't';
			ownerInput.dispatchEvent(new Event('input', { bubbles: true }));
			ownerInput.value = 'th';
			ownerInput.dispatchEvent(new Event('input', { bubbles: true }));
			ownerInput.value = 'the';
			ownerInput.dispatchEvent(new Event('input', { bubbles: true }));

			// Then: Should not fetch immediately (debounced)
			expect(fetchCount).toBe(0);

			// When: Advance time by debounce timeout
			vi.advanceTimersByTime(800);

			// Then: Should fetch only once for "the"
			expect(fetchCount).toBe(1);
		});
	});
});

describe('FitSettingTab - auto-sync triggers (#65)', () => {
	it('renders sync-on-save/sync-on-open toggles that persist on change', async () => {
		const mockLogger = new FitLogger({ adapter: null });
		const fakePlugin: any = {
			settings: { ...DEFAULT_SETTINGS, syncOnSave: false, syncOnOpen: false },
			saveSettings: vi.fn().mockResolvedValue(undefined),
			logger: mockLogger,
		};

		const settingTab = new FitSettingTab({} as any, fakePlugin);
		settingTab.localConfigBlock();

		const findToggleByLabel = (labelText: string): HTMLInputElement | null => {
			const settings = Array.from(settingTab.containerEl.querySelectorAll('.setting-item'));
			for (const setting of settings) {
				const nameEl = setting.querySelector('.setting-item-name');
				if (nameEl?.textContent === labelText) {
					return setting.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
				}
			}
			return null;
		};

		const saveToggle = findToggleByLabel('Sync on save')!;
		const openToggle = findToggleByLabel('Sync on open')!;
		expect(saveToggle.checked).toBe(false);
		expect(openToggle.checked).toBe(false);

		saveToggle.checked = true;
		saveToggle.dispatchEvent(new Event('change'));
		openToggle.checked = true;
		openToggle.dispatchEvent(new Event('change'));

		await vi.waitFor(() => expect(fakePlugin.saveSettings).toHaveBeenCalledTimes(2));
		expect(fakePlugin.settings.syncOnSave).toBe(true);
		expect(fakePlugin.settings.syncOnOpen).toBe(true);
	});
});

describe('FitSettingTab - deployment (desktop only)', () => {
	/** Find a rendered setting row by its label, as the user sees it. */
	const findRow = (container: HTMLElement, labelText: string): HTMLElement | null =>
		Array.from(container.querySelectorAll('.setting-item')).find(
			setting => setting.querySelector('.setting-item-name')?.textContent === labelText
		) as HTMLElement | null;

	const makeTab = (overrides: Record<string, unknown> = {}) => {
		const fakePlugin: any = {
			settings: {
				...DEFAULT_SETTINGS,
				enableAutoDeploy: true,
				astroProjectPath: '/site',
				vaultContentPath: '/vault',
				sftpHost: 'example.com',
				sftpUser: 'deploy',
				sftpRemotePath: '/var/www/site',
				...overrides,
			},
			saveSettings: vi.fn().mockResolvedValue(undefined),
			runDeploymentNow: vi.fn().mockResolvedValue(undefined),
			app: { vault: { adapter: new FileSystemAdapter() } },
		};
		const settingTab = new FitSettingTab({} as any, fakePlugin);
		settingTab.deploymentBlock();
		return { settingTab, fakePlugin };
	};

	const readinessDesc = (container: HTMLElement) =>
		findRow(container, 'Readiness')?.querySelector('.setting-item-description')?.textContent ?? '';

	it('renders the deployment rows as setting-items and persists the toggle', async () => {
		const { settingTab, fakePlugin } = makeTab();
		const container = settingTab.containerEl;

		const toggleRow = findRow(container, 'Enable auto-deploy')!;
		expect(toggleRow.className).toBe('setting-item');
		expect(toggleRow.classList.contains('setting-item-heading')).toBe(false);

		const toggle = toggleRow.querySelector('input[type="checkbox"]') as HTMLInputElement;
		expect(toggle.checked).toBe(true);
		toggle.checked = false;
		toggle.dispatchEvent(new Event('change'));

		await vi.waitFor(() => expect(fakePlugin.saveSettings).toHaveBeenCalled());
		expect(fakePlugin.settings.enableAutoDeploy).toBe(false);

		const pathInput = findRow(container, 'Astro project path')!.querySelector('input') as HTMLInputElement;
		expect(pathInput.value).toBe('/site');
		pathInput.value = '/new/site';
		pathInput.dispatchEvent(new Event('input'));
		await vi.waitFor(() => expect(fakePlugin.settings.astroProjectPath).toBe('/new/site'));
	});

	it('stores the server port as a number and falls back to the default when empty', async () => {
		const { settingTab, fakePlugin } = makeTab();
		const portInput = findRow(settingTab.containerEl, 'Server port')!.querySelector('input') as HTMLInputElement;

		expect(portInput.type).toBe('number');
		expect(portInput.value).toBe('22');

		portInput.value = '2222';
		portInput.dispatchEvent(new Event('input'));
		await vi.waitFor(() => expect(fakePlugin.settings.sftpPort).toBe(2222));
		expect(typeof fakePlugin.settings.sftpPort).toBe('number');

		portInput.value = '';
		portInput.dispatchEvent(new Event('input'));
		await vi.waitFor(() => expect(fakePlugin.settings.sftpPort).toBe(22));
	});

	it('masks the server password field', () => {
		const { settingTab } = makeTab();
		const passwordInput = findRow(settingTab.containerEl, 'Server password')!.querySelector('input') as HTMLInputElement;
		expect(passwordInput.type).toBe('password');
	});

	it('tracks readiness as required fields are filled in', async () => {
		const { settingTab } = makeTab();
		expect(readinessDesc(settingTab.containerEl)).toContain('Ready —');

		const hostInput = findRow(settingTab.containerEl, 'Server host')!.querySelector('input') as HTMLInputElement;
		hostInput.value = '';
		hostInput.dispatchEvent(new Event('input'));
		// Readiness is refreshed after the settings save resolves, so it lands a microtask later.
		await vi.waitFor(() =>
			expect(readinessDesc(settingTab.containerEl)).toContain('Not ready — still needs: Server host')
		);
	});

	it('runs a deployment from the Run now button', () => {
		const { settingTab, fakePlugin } = makeTab();
		const button = Array.from(settingTab.containerEl.querySelectorAll('button')).find(
			b => b.textContent === 'Run now'
		)!;
		button.click();
		expect(fakePlugin.runDeploymentNow).toHaveBeenCalledTimes(1);
	});

	it('offers the real default paths as placeholders, even when the saved values are blank', () => {
		const { settingTab } = makeTab({ astroProjectPath: '', vaultContentPath: '' });
		const container = settingTab.containerEl;

		expect(findRow(container, 'Astro project path')!.querySelector('input')!.placeholder)
			.toBe(DEFAULT_SETTINGS.astroProjectPath);
		expect(findRow(container, 'Vault content path')!.querySelector('input')!.placeholder)
			.toBe(DEFAULT_SETTINGS.vaultContentPath);
	});

	it('names the run log file in the Run deployment now description', () => {
		const { settingTab } = makeTab();
		const description = findRow(settingTab.containerEl, 'Run deployment now')!
			.querySelector('.setting-item-description')!.textContent!;

		// Same path the deployer appends to at runtime — not a hard-coded example.
		expect(deploymentLogPath()).toContain('.fit-deploy.log');
		expect(description).toContain(deploymentLogPath()!);
	});
});

import { Notice, Plugin, SettingTab, TFile, requestUrl } from 'obsidian';
import { FitStatusModal } from '@/fitStatusModal';
import { renderExplanation, type AutoSyncInfo } from '@/fitStatusExplainer';
import { Fit } from '@/fit';
import FitNotice from '@/fitNotice';
import FitSettingTab from '@/fitSettingTab';
import { FitSync } from '@/fitSync';
import { showFileChanges, showUnappliedConflicts } from '@/utils';
import { fitLogger } from '@/logger';
import { LocalStores, parseLocalStore } from '@/localStores';
import { handleCriticalError } from '@/util/errorHandling';
import { GitHubConnection } from '@/remotes/githubConnection';
import { treeUrl } from '@/remotes/githubHost';
import * as Encryption from "@/encryption";
import { FitSettings, DEFAULT_SETTINGS, withDefaults } from '@/fitSettings';
import { FitAttributesFile, FITATTRIBUTES_PATH, parseFitAttributes } from '@/fitAttributes';
import { isPostSyncHookSupported, runPostSyncHook } from '@/postSyncHook';
import { collectBundle, describeResult, publishBundle, type HttpFn } from '@/publish/publisher';

/**
 * Discriminated union representing the outcome of a sync operation.
 * Separates business logic (sync result) from UI lifecycle management.
 */
type SyncOutcome =
	| { status: 'success'; result: Awaited<ReturnType<FitSync['sync']>> & { success: true } }
	| { status: 'already-syncing' }
	| { status: 'error'; error: { type: string; message: string; details?: Record<string, unknown> } }
	| { status: 'not-configured' };


/**
 * FIT Plugin - Obsidian integration layer for sync engine.
 *
 * Thin integration layer between Obsidian and the FIT sync engine.
 * Handles Obsidian-specific concerns only:
 * - Plugin lifecycle (load/unload)
 * - Settings UI and persistence
 * - Ribbon icons and commands
 * - Auto-sync scheduling
 * - Delegating to FitSync for all business logic
 *
 * Architecture:
 * - **Role**: Obsidian plugin lifecycle manager and UI coordinator
 * - **Delegates to**: FitSync (sync orchestration), Fit (data access)
 * - **Manages**: User settings, auto-sync intervals, UI notifications
 *
 * @see FitSync - The sync orchestrator (contains business logic)
 * @see Fit - Data access layer for local/remote storage
 */
const SAVE_SYNC_DEBOUNCE_MS = 30000;

export default class FitPlugin extends Plugin {
	settings: FitSettings;
	settingTab: FitSettingTab;
	localStore: LocalStores;
	fit: Fit;
	fitSync: FitSync;
	githubConnection: GitHubConnection | null;
	autoSyncIntervalId: number | null;
	fitPullRibbonIconEl: HTMLElement;
	fitPushRibbonIconEl: HTMLElement;
	fitSyncRibbonIconEl: HTMLElement;
	logger = fitLogger; // Explicit reference to singleton for future refactoring
	private activeSyncRequests = 0; // Track number of active sync attempts
	private lastGithubConnectionPat: string | null = null; // Track PAT changes
	private lastGithubConnectionHost: string | null = null; // Track host changes (cached auth user is per-host)
	private activeManualSyncRequests = 0; // Track number of active manual sync attempts
	private currentSyncNotice: FitNotice | null = null; // The active sync notice (shared by concurrent requests)
	private saveSyncDebounceTimer: number | null = null; // Pending debounced sync after a file save
	private postSyncHookActive = false; // Guards against overlapping post-sync hook runs
	private publishActive = false; // Guards against overlapping publish runs
	private postSyncTimeoutSec = 900; // Fallback when user setting has not loaded

	// if settings not configured, open settings to let user quickly setup
	// Note: this is not a stable feature and might be disabled at any point in the future
	openPluginSettings() {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const appWithSetting = this.app as any as {
			setting: {
				open(): void;
				openTabById(id: string): SettingTab | null;
			}
		};
		appWithSetting.setting.open();
		appWithSetting.setting.openTabById("fit");
	}

	/**
	 * Build the sync-failure notice content. Plain authentication failures (bad/revoked/expired
	 * token — GitHub's response doesn't distinguish which) get an actionable settings link;
	 * rate-limit and SSO subtypes aren't fixed by touching the token, so they stay plain text
	 * (see #214).
	 */
	private buildSyncErrorNoticeMessage(error: { type: string; message: string; details?: Record<string, unknown> }): string | DocumentFragment {
		const baseText = `Sync failed: ${error.message}`;
		if (error.type !== 'authentication') {
			return baseText;
		}
		const authSubtype = error.details?.authSubtype;
		if (authSubtype === 'rate_limited') {
			return baseText;
		}

		const fragment = document.createDocumentFragment();
		fragment.appendChild(document.createTextNode(baseText + ' '));

		if (authSubtype === 'sso_required') {
			const ssoUrl = error.details?.ssoUrl;
			if (typeof ssoUrl === 'string') {
				const link = document.createElement('a');
				link.href = ssoUrl;
				link.textContent = 'Authorize SSO';
				fragment.appendChild(link);
			}
			return fragment;
		}

		// No subtype — an actual credentials problem. Offer a next step rather than
		// just saying "check your token" with no way to act on it.
		const settingsLink = document.createElement('a');
		settingsLink.textContent = 'Open plugin settings';
		settingsLink.style.cursor = 'pointer';
		settingsLink.addEventListener('click', () => this.openPluginSettings());
		fragment.appendChild(settingsLink);

		return fragment;
	}

	checkSettingsConfigured(): boolean {
		const actionItems: Array<string> = [];
		if (this.settings.pat === "") {
			actionItems.push("provide GitHub personal access token");
		}
		if (this.settings.owner === "") {
			actionItems.push("select or enter a repository owner");
		}
		if (this.settings.repo === "") {
			actionItems.push("select or enter a repository to sync to");
		}
		if (this.settings.branch === "") {
			actionItems.push("select a branch to sync to");
		}

		if (actionItems.length > 0) {
			const initialMessage = "Settings not configured, please complete the following action items:\n" + actionItems.join("\n");
			const settingsNotice = new FitNotice(this.fit, ["static"], initialMessage);
			this.openPluginSettings();
			settingsNotice.remove("static");
			return false;

		}

		this.fit.loadSettings(this.settings);
		return true;
	}

	// use of arrow functions to ensure this refers to the FitPlugin class
	saveLocalStoreCallback = async (localStore: Partial<LocalStores>): Promise<void> => {
		this.localStore = {...this.localStore, ...localStore};
		await this.saveLocalStore();
	};

	// ============================================================================
	// BUSINESS LOGIC LAYER
	// ============================================================================

	/**
	 * Execute sync operation with plugin-level concerns:
	 * - Settings validation
	 * - Local store loading
	 * - Result processing (notifications, error formatting)
	 * - Notice updates
	 */
	private async executeSync(triggerType: 'manual' | 'auto'): Promise<SyncOutcome> {
		if (!this.checkSettingsConfigured()) {
			return { status: 'not-configured' };
		}
		await this.loadLocalStore();

		const syncStartTime = Date.now();
		fitLogger.log(`🚀 [SYNC START] ${triggerType === 'manual' ? 'Manual' : 'Auto'} sync requested`);

		const syncResult = await this.fitSync.sync(this.currentSyncNotice!, { isAutoSync: triggerType === 'auto' });

		if (syncResult.success) {
			const duration = Date.now() - syncStartTime;
			const totalOps = syncResult.changeGroups.reduce((sum, g) => sum + g.changes.length, 0);
			const hasConflicts = syncResult.clash.length > 0;

			fitLogger.log(
				`✅ [SYNC COMPLETE] ${hasConflicts ? 'Success with conflicts' : 'Success'}`,
				{
					duration: `${(duration / 1000).toFixed(2)}s`,
					totalOperations: totalOps,
					conflicts: syncResult.clash.length,
					...(totalOps > 0 && { changes: syncResult.changeGroups }),
					...(hasConflicts && { unresolvedConflicts: syncResult.clash })
				}
			);

			return { status: 'success', result: syncResult };
		} else {
			// Handle already-syncing case - rare race between isActive check and sync() call
			if (syncResult.error.type === 'already-syncing') {
				fitLogger.log('[Plugin] Sync already in progress (race)', { triggerType });
				return { status: 'already-syncing' };
			}

			// Generate user-friendly message from structured sync error
			const errorMessage = this.fitSync.getSyncErrorMessage(syncResult.error);

			// Log detailed error information for debugging AND to file
			fitLogger.log('[Plugin] Sync failed', {
				type: syncResult.error.type,
				message: errorMessage,
				details: syncResult.error.details || {}
			});

			console.error(`Sync failed: ${errorMessage}`, {
				type: syncResult.error.type,
				...(syncResult.error.details || {})
			});

			return {
				status: 'error',
				error: {
					type: syncResult.error.type,
					message: errorMessage,
					details: syncResult.error.details
				}
			};
		}
	}

	// ============================================================================
	// UI LIFECYCLE MANAGEMENT
	// ============================================================================

	/**
	 * Handle sync start event - manages UI state when a sync request begins.
	 * Only creates notice/animation on the first active request.
	 */
	private onSyncStart(triggerType: 'manual' | 'auto'): void {
		// Track this sync attempt
		this.activeSyncRequests++;
		if (triggerType === 'manual') {
			this.activeManualSyncRequests++;
		}

		// "Real" start = first request - create shared notice
		if (this.activeSyncRequests === 1) {
			this.currentSyncNotice = new FitNotice(
				this.fit,
				["loading"],
				triggerType === 'manual' ? "Initiating sync" : "Auto syncing",
				triggerType === 'manual' ? undefined : 0,  // Auto-sync: hide immediately on success
				triggerType === 'auto' && this.settings.autoSync === "muted"
			);
		}

		// Show animation if this is the first manual sync request
		if (triggerType === 'manual' && this.activeManualSyncRequests === 1) {
			this.fitSyncRibbonIconEl.addClass('animate-icon');
		}
	}

	/**
	 * Handles cleanup when a sync fails with an error.
	 * Unlike onSyncEnd, this does NOT nullify the notice reference,
	 * allowing error notices to remain visible until the user dismisses them.
	 */
	private onSyncError(triggerType: 'manual' | 'auto'): void {
		// Decrement counters
		this.activeSyncRequests--;
		if (triggerType === 'manual') {
			this.activeManualSyncRequests--;
		}

		// Clear animation when all manual sync attempts complete
		if (this.activeManualSyncRequests === 0) {
			this.fitSyncRibbonIconEl.removeClass('animate-icon');
		}

		// Note: We do NOT nullify this.currentSyncNotice here,
		// keeping the error notice alive for the user to dismiss manually.
	}

	/**
	 * Handle sync end event - manages UI state when a sync request completes.
	 * Only cleans up notice/animation on the last active request.
	 */
	private onSyncEnd(triggerType: 'manual' | 'auto'): void {
		// Decrement counters
		this.activeSyncRequests--;
		if (triggerType === 'manual') {
			this.activeManualSyncRequests--;
		}

		// "Real" end = last request completes - clean up shared notice
		// Note: executeSync already handled success/error display, we just clean up the reference
		if (this.activeSyncRequests === 0) {
			this.currentSyncNotice = null;
		}

		// Clear animation when all manual sync attempts complete
		if (this.activeManualSyncRequests === 0) {
			this.fitSyncRibbonIconEl.removeClass('animate-icon');
		}
	}

	// ============================================================================
	// COORDINATION LAYER (Decorator Pattern)
	// ============================================================================

	/**
	 * Wraps sync execution with UI lifecycle events (notice, animation).
	 * This is the "decorator" that adds UI coordination to the core sync operation.
	 */
	private async executeSyncWithUICoordination(triggerType: 'manual' | 'auto'): Promise<void> {
		fitLogger.log(`[Plugin] ${triggerType === 'manual' ? 'Manual' : 'Auto'} sync requested`);

		if (this.fitSync.isActive) {
			fitLogger.log('[Plugin] Sync already in progress - ignoring request', { triggerType });
			return;
		}

		this.onSyncStart(triggerType);

		let outcome: SyncOutcome;
		try {
			outcome = await this.executeSync(triggerType);
		} catch (error) {
			// Catch any unhandled exceptions (programming errors, unexpected failures)
			const errorMsg = error instanceof Error ? error.message : String(error);
			const fullMessage = `Sync failed unexpectedly: ${errorMsg}`;

			fitLogger.log('[Plugin] Unhandled sync error', {
				error: errorMsg,
				stack: error instanceof Error ? error.stack : undefined
			});

			console.error(fullMessage, error);

			// Show error in notice and clean up state
			this.currentSyncNotice?.setMessage(fullMessage, true);
			this.onSyncError(triggerType);
			return;
		}

		// Handle all sync outcomes with centralized UI lifecycle management
		switch (outcome.status) {
			case 'success':
				// Record sync timestamp for status display
				this.localStore = { ...this.localStore, lastSyncedAt: Date.now() };
				void this.saveLocalStore();

				// Show optional notifications
				if (this.settings.notifyConflicts) {
					showUnappliedConflicts(outcome.result.clash);
				}
				if (this.settings.notifyChanges) {
					showFileChanges(
						outcome.result.changeGroups,
						undefined,
						this.settings.fileChangesNoticeDurationSec * 1000
					);
				}

				// Show success completion state in notice
				if (triggerType === 'auto') {
					this.currentSyncNotice!.remove(); // Auto-sync hides notice completely
				} else {
					this.currentSyncNotice!.remove("done"); // Manual shows success state briefly
				}

				// Clean up and nullify notice reference (success can nullify)
				this.onSyncEnd(triggerType);

				// Opt-in desktop-only post-sync hook. Guarded on an actually-created commit (a
				// pull-only sync has nothing new to build), and deliberately not awaited: a
				// full site build plus rsync must never hold the sync UI open.
				void this.maybeRunPostSyncHook(outcome.result.pushedRemoteChanges?.length ?? 0, triggerType);
				// Opt-in publish to the website (HTTPS, works on mobile). Same commit gate and the
				// same fire-and-forget reasoning as the hook above.
				if (this.settings.publishAfterSync && (outcome.result.pushedRemoteChanges?.length ?? 0) > 0) {
					void this.publishNow({ quiet: true });
				}
				break;

			case 'already-syncing':
				// Rare race: passed isActive check but sync() was claimed before we reached it.
				// onSyncStart already ran, so undo its counter increment.
				this.onSyncEnd(triggerType);
				break;

			case 'not-configured':
				// Settings check failed, sync didn't start
				// No notice to clean up (onSyncStart didn't create one if settings invalid)
				this.onSyncError(triggerType);
				break;

			case 'error':
				// Show sticky error notice
				this.currentSyncNotice!.setMessage(this.buildSyncErrorNoticeMessage(outcome.error), true);

				// Clean up state WITHOUT nullifying the error notice reference
				this.onSyncError(triggerType);
				break;
		}
	}

	// ============================================================================
	// PUBLIC ENTRY POINTS (User-triggered sync operations)
	// ============================================================================

	/**
	 * Entry point: User clicks ribbon icon or uses command palette
	 */
	triggerManualSync = async (): Promise<void> => {
		await this.executeSyncWithUICoordination('manual');
	};

	/**
	 * Entry point: run the post-sync hook on demand.
	 *
	 * Bypasses the "did this sync create a commit" gate — the point is to deploy without
	 * waiting for a content change (first deploy, or a retry after a failed run). Still
	 * honours the enabled toggle, so a disabled hook never runs.
	 */
	runPostSyncHookNow = async (): Promise<void> => {
		if (!this.settings?.postSyncHookEnabled) {
			new Notice('FIT: enable the post-sync hook in FIT settings first.');
			return;
		}
		await this.maybeRunPostSyncHook(1, 'manual');
	};

	/**
	 * Run the configured post-sync hook: rebuild the site and deploy it.
	 *
	 * Fire-and-forget by design (see the call site) — the sync is already complete and its
	 * notice dismissed, while a build/deploy can take minutes. Never throws: a failing
	 * deploy must not surface as a failed sync.
	 *
	 * @param pushedCount - local changes the sync wrote to remote; 0 means no new commit.
	 * @param triggerType - whether the sync was manual or scheduled, for logging only.
	 */
	private async maybeRunPostSyncHook(pushedCount: number, triggerType: 'manual' | 'auto'): Promise<void> {
		if (pushedCount === 0 || !this.settings?.postSyncHookEnabled) {
			return;
		}

		const command = this.settings.postSyncHookCommand;
		const cwd = this.settings.postSyncHookCwd;
		const timeoutSec = this.settings.postSyncHookTimeoutSec || this.postSyncTimeoutSec;

		// Re-entrancy guard: a manual sync during a running deploy would otherwise start a
		// second build against the same working tree and rsync over the first one's output.
		if (this.postSyncHookActive) {
			fitLogger.log('[PostSyncHook] Skipped — a previous run is still in progress', { triggerType });
			new Notice('FIT: post-sync hook skipped — the previous run is still in progress.', 0);
			return;
		}

		if (!isPostSyncHookSupported(this.app.vault)) {
			// Only worth saying out loud when the user actually configured a command to run.
			if (command.trim() !== '') {
				fitLogger.log('[PostSyncHook] Skipped — desktop-only', { triggerType });
				new Notice('FIT: post-sync hook is desktop-only and was skipped on this device.', 0);
			}
			return;
		}

		this.postSyncHookActive = true;
		const startedAt = Date.now();
		fitLogger.log('[PostSyncHook] Starting', { triggerType, pushed: pushedCount, command, cwd, timeoutSec });
		const progressNotice = new Notice('FIT: running post-sync hook (build + deploy)…', 0);

		try {
			const result = await runPostSyncHook(this.app.vault, {
				enabled: true,
				command,
				cwd,
				timeoutSec,
				onOutput: (line) => fitLogger.log(`[PostSyncHook] ${line}`),
			});

			const durationSec = ((Date.now() - startedAt) / 1000).toFixed(1);

			if (result.status === 'skipped') {
				fitLogger.log('[PostSyncHook] Skipped', { reason: result.reason, durationSec });
				progressNotice.hide();
				if (result.reason === 'not-configured') {
					new Notice('FIT: the post-sync hook is enabled but no command is set — see FIT settings.', 0);
				} else if (result.reason === 'unsupported-platform') {
					new Notice('FIT: post-sync hook is desktop-only and was skipped on this device.', 0);
				}
				return;
			}

			if (result.status === 'success') {
				fitLogger.log('[PostSyncHook] Completed', { durationSec, logLines: result.output.length });
				progressNotice.hide();
				new Notice(`FIT: post-sync hook finished in ${durationSec}s.`, 5000);
				return;
			}

			fitLogger.log('[PostSyncHook] Failed', {
				durationSec,
				exitCode: result.exitCode,
				signal: result.signal,
				timedOut: result.timedOut,
			});
			const reason = result.timedOut
				? `timed out after ${timeoutSec}s`
				: result.exitCode === null
					? 'could not be started'
					: `exited with code ${result.exitCode}`;
			// Left sticky on purpose: a failed deploy is not something to auto-dismiss, and the
			// full output is in the fit debug log for the user to read.
			progressNotice.setMessage(`FIT: post-sync hook ${reason}. See the FIT debug log for output.`);
		} catch (error) {
			// runPostSyncHook resolves rather than rejects, so reaching here means an
			// unexpected bug. Do not let it escape into the sync path.
			const message = error instanceof Error ? error.message : String(error);
			fitLogger.log('[PostSyncHook] Unexpected error', { message });
			progressNotice.setMessage(`FIT: post-sync hook failed unexpectedly: ${message}`);
		} finally {
			this.postSyncHookActive = false;
		}
	}

	/**
	 * Validate and publish the vault's `project/` and `journal/` notes through the site's admin API.
	 * Never throws: a failed publish must not surface as a failed sync.
	 */
	publishNow = async (opts: { dryRun?: boolean; quiet?: boolean } = {}): Promise<void> => {
		const s = this.settings;
		if (!s.publishUrl.trim() || !s.publishToken.trim()) {
			new Notice('FIT: set the site URL and token in FIT settings ▸ Publishing first.', 0);
			return;
		}
		if (this.publishActive) {
			new Notice('FIT: a publish is already running.');
			return;
		}
		this.publishActive = true;
		const notice = new Notice(opts.dryRun ? 'FIT: validating notes…' : 'FIT: publishing notes…', 0);
		try {
			const bundle = await collectBundle(this.app.vault, s);
			for (const w of bundle.warnings) fitLogger.log('[Publish] warning', { w });
			const http: HttpFn = async (req) => {
				const res = await requestUrl({ url: req.url, method: req.method, headers: req.headers, body: req.body, throw: false });
				let json: unknown = {};
				try { json = res.json; } catch { /* non-JSON error body */ }
				return { status: res.status, json };
			};
			const result = await publishBundle(s, bundle, http, { dryRun: opts.dryRun });
			fitLogger.log('[Publish] result', { ...result });
			const text = describeResult(result) + (bundle.warnings.length ? `
(${bundle.warnings.length} warning(s) in the FIT log)` : '');
			notice.setMessage(text);
			if (result.ok) setTimeout(() => notice.hide(), opts.quiet ? 4000 : 8000);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			fitLogger.log('[Publish] Unexpected error', { message });
			notice.setMessage(`FIT: publish failed unexpectedly: ${message}`);
		} finally {
			this.publishActive = false;
		}
	};

	private async explainSyncStatus(): Promise<void> {
		if (!this.checkSettingsConfigured()) return;
		// Reload so status reflects disk state even if user hasn't synced since startup.
		await this.loadLocalStore();
		this.fit.loadLocalStore(this.localStore);

		const explanation = await this.fitSync.explainStatus();

		const { owner, repo, autoSync, checkEveryXMinutes, githubHost } = this.settings;
		const sha = this.localStore.lastFetchedCommitSha;
		const commitUrl = (owner && repo && sha)
			? treeUrl(githubHost, owner, repo, sha)
			: null;
		const autoSyncInfo: AutoSyncInfo = {
			enabled: autoSync !== 'off',
			intervalMinutes: checkEveryXMinutes,
			lastSyncedAt: this.localStore.lastSyncedAt ?? null,
		};

		const renderable = renderExplanation(explanation, { commitUrl, autoSyncInfo });
		new FitStatusModal(this.app, renderable).open();
	}

	loadRibbonIcons() {
		// Pull from remote then Push to remote if no clashing changes detected during pull
		// TODO: Update title from "GitHub" to selected remote service when other services are supported.
		this.fitSyncRibbonIconEl = this.addRibbonIcon('github', 'Sync to GitHub', this.triggerManualSync);
		this.fitSyncRibbonIconEl.addClass('fit-sync-ribbon-el');
	}

	/**
	 * Entry point: Scheduled sync triggered (usually via timer)
	 */
	async handleAutoSyncTimer() {
		if (!(this.settings.autoSync === "off") && this.checkSettingsConfigured()) {
			if (this.settings.autoSync === "on" || this.settings.autoSync === "muted") {
				await this.executeSyncWithUICoordination('auto');
			} else if (this.settings.autoSync === "remind") {
				const { changes } = await this.fit.getRemoteChanges();
				if (changes.length > 0) {
					const initialMessage = "Remote update detected, please pull the latest changes.";
					const intervalNotice = new FitNotice(this.fit, ["static"], initialMessage);
					intervalNotice.remove("static");
				}
			}
		}
	}

	/**
	 * Entry point: app launch — one-shot full sync when the user opted in
	 * ("Sync on open", #65). Independent of the autoSync interval setting.
	 * Mirrors handleAutoSyncTimer's guard structure, including the
	 * not-configured prompt.
	 */
	async handleSyncOnOpen(): Promise<void> {
		if (!this.settings?.syncOnOpen) return;
		if (this.checkSettingsConfigured()) {
			await this.executeSyncWithUICoordination('auto');
		}
	}

	/**
	 * Register vault event listeners driving the auto-sync triggers.
	 * registerEvent() auto-unregisters them on plugin unload.
	 */
	registerVaultEvents(): void {
		this.registerEvent(this.app.vault.on('modify', this.onVaultFileSaved));
	}

	/**
	 * Entry point: a vault file was written to disk (Ctrl+S, vim :w, editor
	 * autosave on blur, or a mobile save). Debounced so a burst of saves
	 * coalesces into one full auto sync. The isActive guard is load-bearing:
	 * FIT's own pull writes fire 'modify' too (LocalVault.applyChanges uses
	 * vault.modify/create), so without it every sync would re-arm a redundant
	 * no-op sync 30 seconds later.
	 */
	onVaultFileSaved = (_file: TFile): void => {
		if (!this.settings?.syncOnSave || this.fitSync?.isActive) return;

		if (this.saveSyncDebounceTimer !== null) {
			window.clearTimeout(this.saveSyncDebounceTimer);
		}
		this.saveSyncDebounceTimer = window.setTimeout(() => {
			this.saveSyncDebounceTimer = null;
			// Re-check at fire time: settings can be toggled off (or a sync
			// started) during the debounce window; the entry-time guard above
			// only covered the moment the save landed.
			if (!this.settings?.syncOnSave || this.fitSync?.isActive) return;
			void this.executeSyncWithUICoordination('auto');
		}, SAVE_SYNC_DEBOUNCE_MS);
	};

	async startOrUpdateAutoSyncInterval() {
		// Clear existing interval if it exists
		if (this.autoSyncIntervalId !== null) {
			window.clearInterval(this.autoSyncIntervalId);
			this.autoSyncIntervalId = null;
		}

		// Check remote every X minutes (set in settings)
		this.autoSyncIntervalId = window.setInterval(async () => {
			await this.handleAutoSyncTimer();
		}, this.settings.checkEveryXMinutes * 60 * 1000);
	}

	async onload() {
		try {
			// Initialize logger with vault and plugin directory for cross-platform diagnostics
			// This is done first so the logger is available if later initialization steps fail.
			if (this.manifest.dir) {
				fitLogger.configure(this.app.vault, this.manifest.dir);
			}

			await this.loadSettings();
			fitLogger.setEnabled(this.settings.enableDebugLogging);

			fitLogger.log('[Plugin] Starting plugin initialization');

			await this.loadLocalStore();

			Encryption.init(this);

			this.githubConnection = this.settings.pat
				? new GitHubConnection(this.settings.pat, this.settings.githubHost)
				: null;
			this.fit = new Fit(this.settings, this.localStore, this.app.vault, this.manifest.dir ?? undefined);
			this.fitSync = new FitSync(this.fit, this.saveLocalStoreCallback);
			this.settingTab = new FitSettingTab(this.app, this);
			this.loadRibbonIcons();

			// Add command to command palette for fit sync
			this.addCommand({
				id: 'fit-sync',
				name: 'Fit Sync',
				callback: this.triggerManualSync
			});

			this.addCommand({
				id: 'fit-explain-status',
				name: 'Explain sync status',
				callback: () => this.explainSyncStatus()
			});

			// Desktop-only, and only meaningful once a command is configured; still surfaced
			// everywhere so the skip reason is discoverable rather than a silently absent command.
			this.addCommand({
				id: 'fit-run-post-sync-hook',
				name: 'Run post-sync hook',
				callback: () => this.runPostSyncHookNow()
			});

			this.addCommand({
				id: 'fit-publish',
				name: 'Publish notes to the website',
				callback: () => this.publishNow()
			});
			this.addCommand({
				id: 'fit-publish-validate',
				name: 'Validate notes for the website (dry run)',
				callback: () => this.publishNow({ dryRun: true })
			});

			// This adds a settings tab so the user can configure various aspects of the plugin
			this.addSettingTab(new FitSettingTab(this.app, this));

			// register interval to repeat auto check
			await this.startOrUpdateAutoSyncInterval();

			this.registerVaultEvents();

			// One-shot sync at launch when opted in; not awaited so a slow
			// network never delays vault load.
			void this.handleSyncOnOpen();

			fitLogger.log('[Plugin] Plugin initialization completed successfully');
		} catch (error) {
			handleCriticalError('Plugin failed to load', error, {
				logger: fitLogger,
				showNotice: true
			});
			throw error;
		}
	}

	onunload() {
		if (this.saveSyncDebounceTimer !== null) {
			window.clearTimeout(this.saveSyncDebounceTimer);
			this.saveSyncDebounceTimer = null;
		}
		if (this.autoSyncIntervalId !== null) {
			window.clearInterval(this.autoSyncIntervalId);
			this.autoSyncIntervalId = null;
		}
	}

	async loadSettings() {
		const userSetting = await this.loadData();
		// withDefaults, not a plain Object.assign: trims the publish folder.
		const merged = withDefaults(userSetting as Partial<FitSettings> | null);
		// Raw view over the same object: values arrive as whatever JSON stored (a "5" for a
		// number, a "" for a path), so the coercion below reads them before their types are
		// settled.
		const raw = merged as unknown as Record<string, unknown>;
		const settingsObj: FitSettings = Object.keys(DEFAULT_SETTINGS).reduce(
			(obj, key: keyof FitSettings) => {
				// Written through the raw view: assigning to a union-keyed slot of FitSettings
				// would need a single type that fits every remaining key at once.
				const target = obj as unknown as Record<string, unknown>;
				if (raw.hasOwnProperty(key)) {
					if (key == "checkEveryXMinutes" || key == "fileChangesNoticeDurationSec" || key == "postSyncHookTimeoutSec") {
						target[key] = Number(raw[key]);
					}
					else if (key === "notifyChanges" || key === "notifyConflicts" || key === "enableDebugLogging" || key === "syncHiddenFiles" || key === "syncOnSave" || key === "syncOnOpen" || key === "postSyncHookEnabled" || key === "publishAfterSync" || key === "publishBuild") {
						target[key] = Boolean(raw[key]);
					}
					else {
						target[key] = raw[key];
					}
				}
				return obj;
			}, {} as FitSettings);
		this.settings = settingsObj;

		await this.migrateObsidianSyncRules(userSetting);
	}

	/**
	 * One-time migration from the retired 1.6.0-alpha.1 obsidianSyncRules settings toggle.
	 * That mechanism had exactly one strategy ("replace" = whole-file byte sync), which is
	 * exactly what .fitattributes.json's format:"text" is — so migration is mechanical:
	 * write a format:"text" entry for every previously-toggled path. See docs/sync-logic.md
	 * § Migrating from obsidianSyncRules.
	 */
	private async migrateObsidianSyncRules(userSetting: unknown): Promise<void> {
		const legacyRules = (userSetting as { obsidianSyncRules?: Record<string, unknown> } | undefined)
			?.obsidianSyncRules;
		if (!legacyRules || Object.keys(legacyRules).length === 0) return;

		let current: FitAttributesFile = {};
		try {
			const text = await this.app.vault.adapter.read(FITATTRIBUTES_PATH);
			// Only migrate into a file we can interpret in full: rewriting one with
			// a bad rule or bad JSON would erase what the user wrote.
			if (text.trim() !== '') {
				const parsed = parseFitAttributes(text);
				if (!parsed.ok || parsed.invalidRules.length > 0) {
					fitLogger.log('⚠️ [Plugin] Skipping obsidianSyncRules migration: existing .fitattributes.json is not fully valid.');
					// The next save drops the legacy setting, so this cannot be retried. Paths the
					// file already configures validly need nothing added (and keep their own choice).
					const unmigrated = Object.keys(legacyRules).filter(path => !(parsed.ok && parsed.value[path]));
					if (unmigrated.length > 0) {
						new Notice(
							'FIT: could not move your old .obsidian/ sync settings to .fitattributes.json because the existing file is not fully valid. ' +
							`Fix it, then add { "format": "text" } entries for: ${unmigrated.join(', ')}`,
							0
						);
					}
					return;
				}
				current = parsed.value;
			}
		} catch { /* .fitattributes.json doesn't exist locally yet */ }

		let migratedAny = false;
		for (const path of Object.keys(legacyRules)) {
			if (current[path]) continue; // already configured — don't overwrite a deliberate choice
			current[path] = { format: 'text' };
			migratedAny = true;
		}
		if (!migratedAny) return;

		await this.app.vault.adapter.write(FITATTRIBUTES_PATH, JSON.stringify(current, null, '\t'));
		new Notice(
			'FIT: your .obsidian/ sync settings moved to .fitattributes.json (format: "text"). ' +
			'Review it at your vault root — this is a compatibility migration, not necessarily the ideal long-term config.',
			0
		);
	}

	// TODO: loadLocalStore and saveLocalStoreCallback are the persistence contract for all
	// sync state. Adding any new field to LocalStores requires updating BOTH parseLocalStore
	// and saveLocalStoreCallback — see fitPlugin.test.ts for coverage.
	// When adding a field: add it to parseLocalStore with a ?? default, add it to
	// saveLocalStoreCallback, and add a round-trip assertion to the test.
	async loadLocalStore() {
		this.localStore = parseLocalStore(await this.loadData());
	}

	// allow saving of local stores property, passed in properties will override existing stored value
	async saveLocalStore() {
		await this.saveData({...this.settings, ...this.localStore});
		// sync local store to Fit class as well upon saving
		this.fit.loadLocalStore(this.localStore);
	}

	async saveSettings() {
		await this.saveData({...this.settings, ...this.localStore});
		// update auto sync interval with new setting
		this.startOrUpdateAutoSyncInterval();
		// sync settings to Fit class as well upon saving
		this.fit.loadSettings(this.settings);

		// Update GitHubConnection only when PAT or host changes
		if (this.settings.pat !== this.lastGithubConnectionPat
			|| this.settings.githubHost !== this.lastGithubConnectionHost) {
			if (this.settings.pat) {
				this.githubConnection = new GitHubConnection(this.settings.pat, this.settings.githubHost);
				this.lastGithubConnectionPat = this.settings.pat;
				this.lastGithubConnectionHost = this.settings.githubHost;
			} else {
				this.githubConnection = null;
				this.lastGithubConnectionPat = null;
				this.lastGithubConnectionHost = null;
			}
		}
	}
}

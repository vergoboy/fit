export interface FitSettings {
	// TODO: When adding support for multiple remote providers (GitLab, Gitea),
	// consider using a discriminated union structure:
	// remote: { provider: "github", pat: string, owner: string, ... }
	//       | { provider: "gitlab", token: string, project: string, ... }
	//       | { provider: "gitea", token: string, owner: string, ... }
	// This would allow type-safe, provider-specific settings.
	// See RemoteVaultProvider type in src/vault.ts for provider enum.
	encryptionPassword: string;
	pat: string;
	githubHost: string;
	owner: string;       // Owner of the repo (may differ from authenticated user for contributor repos)
	avatarUrl: string;
	repo: string;
	branch: string;
	deviceName: string;
	checkEveryXMinutes: number
	autoSync: "on" | "off" | "muted" | "remind"
	notifyChanges: boolean
	fileChangesNoticeDurationSec: number   // 0 = stays until clicked
	notifyConflicts: boolean
	enableDebugLogging: boolean
	syncHiddenFiles: boolean
	// opt-in auto-sync triggers (#65); both off by default
	syncOnSave: boolean
	syncOnOpen: boolean
	// opt-in desktop-only post-sync hook; off by default, see docs/post-sync-hook.md
	postSyncHookEnabled: boolean
	/** Shell command run after a sync that pushed a commit, e.g. `bash scripts/deploy.sh`. */
	postSyncHookCommand: string
	/** Working directory for the hook command; empty means Obsidian's own CWD. */
	postSyncHookCwd: string
	/** Hard timeout for the hook command, in seconds. */
	postSyncHookTimeoutSec: number
	// Publishing to the website through its admin API (HTTPS + bearer token; works on mobile).
	// See docs/publishing.md.
	publishUrl: string
	/** Token created in the site dashboard (Settings ▸ FIT tokens). Per-device secret, never synced. */
	publishToken: string
	/** Vault folder that contains `project/<lang>/` and `journal/<lang>/`. */
	publishFolder: string
	/** Publish automatically after a sync that pushed a commit. */
	publishAfterSync: boolean
	/** Ask the server to rebuild the site once the notes are accepted. */
	publishBuild: boolean
}

export const DEFAULT_SETTINGS: FitSettings = {
	encryptionPassword: "",
	pat: "",
	githubHost: "github.com",
	owner: "",
	avatarUrl: "",
	repo: "",
	branch: "",
	deviceName: "",
	checkEveryXMinutes: 5,
	autoSync: "off",
	notifyChanges: true,
	fileChangesNoticeDurationSec: 0,   // preserves current "click to dismiss" behavior by default
	notifyConflicts: true,
	enableDebugLogging: true,
	syncHiddenFiles: true,
	syncOnSave: false,
	syncOnOpen: false,
	postSyncHookEnabled: false,
	postSyncHookCommand: "",
	postSyncHookCwd: "",
	postSyncHookTimeoutSec: 900,
	publishUrl: "https://arman-hosseini.ir",
	publishToken: "",
	publishFolder: "arman-hosseini",
	publishAfterSync: false,
	publishBuild: true,
};

/** Saved settings merged over {@link DEFAULT_SETTINGS}; unknown keys in `saved` are dropped. */
export function withDefaults(saved: Partial<FitSettings> | null | undefined): FitSettings {
	const merged: FitSettings = { ...DEFAULT_SETTINGS, ...(saved ?? {}) };
	if (typeof merged.publishFolder === 'string') merged.publishFolder = merged.publishFolder.trim();
	return merged;
}

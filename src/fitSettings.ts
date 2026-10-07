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
	// opt-in auto-deploy after a sync that pushed a commit; off by default, desktop-only,
	// see docs/deployment.md
	enableAutoDeploy: boolean
	/** Local checkout of the website project the vault is published to. */
	astroProjectPath: string
	/** Vault folder holding the publishable `project/` and `journal/` trees. */
	vaultContentPath: string
	/** Deployment server. The `sftp*` names are kept from the original feature request even
	 * though the transport is rsync over SSH — these are the same credentials. */
	sftpHost: string
	/** SSH port. */
	sftpPort: number
	/** SSH user. */
	sftpUser: string
	/** SSH password. Only needed when the server refuses key auth; stored in plaintext in
	 * data.json, which is why it is on FIT's own settings denylist (see protectedPaths.ts). */
	sftpPassword: string
	/** Directory on the server that `dist/` is published to. */
	sftpRemotePath: string
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
	enableAutoDeploy: false,
	astroProjectPath: "/home/arman/Documents/project/arman-hosseini",
	vaultContentPath: "/home/arman/Documents/obsidian/arman/arman-hosseini",
	sftpHost: "45.135.242.135",
	sftpPort: 22,
	sftpUser: "ubuntu",
	sftpPassword: "",
	sftpRemotePath: "/opt/arman-hosseini",
};

/**
 * Deployment paths whose built-in default is re-adopted when a saved value comes back empty.
 *
 * An empty string here means "this device never had it filled in", not "I deliberately
 * cleared it": these are machine-specific paths, and letting a stale `""` in `data.json`
 * shadow the default would leave the field blank forever while the readiness line still
 * looks configurable. Cleared values therefore only stay cleared for settings that are not
 * on this list.
 */
const DEPLOYMENT_PATH_KEYS = ['astroProjectPath', 'vaultContentPath'] as const;

/**
 * Saved settings merged over {@link DEFAULT_SETTINGS}, the way `loadSettings` needs them.
 *
 * Same contract as `Object.assign({}, DEFAULT_SETTINGS, saved)` except for
 * {@link DEPLOYMENT_PATH_KEYS}: an empty (or whitespace-only) saved path falls back to the
 * default instead of winning over it. Extra keys in `saved` are dropped, exactly as before.
 */
export function withDefaults(saved: Partial<FitSettings> | null | undefined): FitSettings {
	const merged: FitSettings = { ...DEFAULT_SETTINGS, ...(saved ?? {}) };
	for (const key of DEPLOYMENT_PATH_KEYS) {
		if (typeof merged[key] === 'string' && merged[key].trim() === '') {
			merged[key] = DEFAULT_SETTINGS[key];
		}
	}
	return merged;
}

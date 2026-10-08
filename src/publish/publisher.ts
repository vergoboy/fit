import type { Vault } from 'obsidian';
import { TFile } from 'obsidian';
import { convertObsidianMarkdown, frontmatterValue } from './obsidianSyntax';

export interface PublishSettings {
	publishUrl: string;
	publishToken: string;
	publishFolder: string;
	publishBuild: boolean;
}

export interface BundleNote { path: string; content: string; sha: string }
export interface BundleMedia { name: string; base64: string }
export interface Bundle {
	notes: BundleNote[];
	/** Images keyed by the note path that references them. */
	media: Map<string, BundleMedia[]>;
	warnings: string[];
}
export interface ServerError { path: string; message: string; line?: number; column?: number }
export interface PublishResult {
	ok: boolean;
	status: number;
	written?: number; deleted?: number; unchanged?: number; media?: number;
	build?: { id: string; queued: boolean } | null;
	errors?: ServerError[];
	message?: string;
	dryRun?: boolean;
}

export type HttpFn = (req: { url: string; method: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; json: unknown }>;

const NOTE_EXT = /\.(md|mdx)$/i;
const SECTION_MAP: Record<string, string> = { project: 'projects', projects: 'projects', journal: 'journal' };

export async function sha256Hex(data: string | ArrayBuffer): Promise<string> {
	const buf = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
	const digest = await crypto.subtle.digest('SHA-256', buf);
	return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function toBase64(buf: ArrayBuffer): string {
	return btoa(Array.from(new Uint8Array(buf), (b) => String.fromCharCode(b)).join(''));
}

/** `<folder>/journal/fa/x.md` → `journal/fa/x.md`; null when the file is outside the publish tree. */
export function serverPathFor(vaultPath: string, folder: string): { path: string; collection: string; lang: string } | null {
	const root = folder.replace(/^\/+|\/+$/g, '');
	const rel = root ? (vaultPath.startsWith(`${root}/`) ? vaultPath.slice(root.length + 1) : null) : vaultPath;
	if (!rel || !NOTE_EXT.test(rel)) return null;
	const [section, lang, ...rest] = rel.split('/');
	const collection = SECTION_MAP[section];
	if (!collection || (lang !== 'en' && lang !== 'fa') || rest.length === 0) return null;
	return { path: `${collection}/${lang}/${rest.join('/')}`, collection, lang };
}

export async function collectBundle(vault: Vault, s: PublishSettings): Promise<Bundle> {
	const warnings: string[] = [];
	const files = vault.getFiles();
	const candidates = files.map((f) => ({ f, info: serverPathFor(f.path, s.publishFolder) })).filter((x): x is { f: TFile; info: NonNullable<typeof x.info> } => x.info !== null);

	// Public URL for a note name, derived from its slug, so wikilinks between published notes work.
	const urlByName = new Map<string, string>();
	const sources = new Map<string, string>();
	for (const { f, info } of candidates) {
		let src: string;
		try { src = new TextDecoder('utf-8', { fatal: true }).decode(await vault.readBinary(f)); }
		catch { warnings.push(`${f.path}: not valid UTF-8, skipped`); continue; }
		sources.set(f.path, src);
		if (frontmatterValue(src, 'publish') === 'false') continue;
		const slug = frontmatterValue(src, 'slug') ?? f.basename.normalize('NFC').toLowerCase().replace(/[\s_]+/g, '-').replace(/[^\p{L}\p{N}-]+/gu, '-').replace(/-{2,}/g, '-').replace(/^-|-$/g, '');
		urlByName.set(f.basename.toLowerCase(), `/${info.lang}/${info.collection}/${slug}/`);
	}

	const imageByName = new Map<string, TFile>();
	for (const f of files) if (/\.(png|jpe?g|webp|avif|gif|svg)$/i.test(f.name)) imageByName.set(f.name.toLowerCase(), f);

	const notes: BundleNote[] = [];
	const media = new Map<string, BundleMedia[]>();
	for (const { f, info } of candidates) {
		const src = sources.get(f.path);
		if (src === undefined || frontmatterValue(src, 'publish') === 'false') continue;
		const pending = new Map<string, { file: TFile; ext: string }>();
		const converted = convertObsidianMarkdown(src, {
			resolveLink: (t) => urlByName.get(t.toLowerCase()) ?? null,
			resolveImage: (name) => {
				const file = imageByName.get(name.toLowerCase());
				if (!file) { warnings.push(`${f.path}: image "${name}" not found in the vault`); return null; }
				pending.set(name, { file, ext: file.extension.toLowerCase() });
				return `/media/vault/__${name.toLowerCase()}__`; // placeholder, replaced below once hashed
			},
		});
		let text = converted.text;
		const uploads: BundleMedia[] = [];
		for (const [name, { file, ext }] of pending) {
			const data = await vault.readBinary(file);
			const hashed = `${(await sha256Hex(data)).slice(0, 12)}.${ext}`;
			text = text.split(`/media/vault/__${name.toLowerCase()}__`).join(`/media/vault/${hashed}`);
			uploads.push({ name: hashed, base64: toBase64(data) });
		}
		notes.push({ path: info.path, content: text, sha: await sha256Hex(text) });
		if (uploads.length) media.set(info.path, uploads);
	}
	return { notes, media, warnings };
}

function joinUrl(base: string, p: string): string { return `${base.replace(/\/+$/, '')}${p}`; }

/** Diff against the server manifest, then send only what changed. */
export async function publishBundle(
	s: PublishSettings, bundle: Bundle, http: HttpFn, opts: { dryRun?: boolean } = {},
): Promise<PublishResult> {
	const headers = { authorization: `Bearer ${s.publishToken}`, 'content-type': 'application/json' };
	const m = await http({ url: joinUrl(s.publishUrl, '/api/ingest/manifest'), method: 'GET', headers });
	if (m.status === 401) return { ok: false, status: 401, message: 'The server rejected the token. Create a new one in the dashboard (Settings ▸ FIT tokens).' };
	if (m.status !== 200) return { ok: false, status: m.status, message: `Manifest request failed (HTTP ${m.status}).` };
	const remote = (m.json as { files: Record<string, string> }).files ?? {};

	if (bundle.notes.length === 0 && Object.keys(remote).length > 0) {
		return { ok: false, status: 0, message: `No publishable notes found in "${s.publishFolder}" — refusing to remove ${Object.keys(remote).length} page(s) from the site. Check the vault folder setting.` };
	}
	const changed = bundle.notes.filter((n) => remote[n.path] !== n.sha);
	const local = new Set(bundle.notes.map((n) => n.path));
	const del = Object.keys(remote).filter((p) => !local.has(p));
	const media = changed.flatMap((n) => bundle.media.get(n.path) ?? []);

	const r = await http({
		url: joinUrl(s.publishUrl, '/api/ingest'), method: 'POST', headers,
		body: JSON.stringify({ files: changed.map(({ path, content }) => ({ path, content })), delete: del, media, build: s.publishBuild, dryRun: Boolean(opts.dryRun) }),
	});
	const j = (r.json ?? {}) as Record<string, unknown>;
	if (r.status === 422) return { ok: false, status: 422, message: String(j.error ?? 'validation failed'), errors: (j.errors as ServerError[]) ?? [] };
	if (r.status !== 200) return { ok: false, status: r.status, message: String(j.error ?? `HTTP ${r.status}`) };
	return {
		ok: true, status: 200, written: Number(j.written ?? 0), deleted: Number(j.deleted ?? 0), unchanged: bundle.notes.length - changed.length + Number(j.unchanged ?? 0),
		media: Number(j.media ?? 0), build: (j.build as PublishResult['build']) ?? null, dryRun: Boolean(j.dryRun),
	};
}

export function describeResult(r: PublishResult): string {
	if (!r.ok) {
		const first = (r.errors ?? []).slice(0, 3).map((e) => `${e.path}${e.line ? `:${e.line}` : ''} – ${e.message}`).join('\n');
		return `FIT publish failed: ${r.message ?? r.status}${first ? `\n${first}` : ''}`;
	}
	const head = r.dryRun ? 'Validation passed' : 'Published';
	return `FIT ${head}: ${r.written} updated, ${r.deleted} removed, ${r.unchanged} unchanged${r.build ? ' — site build started' : ''}.`;
}

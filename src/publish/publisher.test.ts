import { describe, it, expect, vi } from 'vitest';
import { publishBundle, serverPathFor, describeResult, sha256Hex, type Bundle, type HttpFn } from './publisher';

const settings = { publishUrl: 'https://site.test/', publishToken: 'vgp_t', publishFolder: 'arman', publishBuild: true };

describe('serverPathFor', () => {
	it('maps vault paths to server paths', () => {
		expect(serverPathFor('arman/project/en/Vegord.md', 'arman')).toEqual({ path: 'projects/en/Vegord.md', collection: 'projects', lang: 'en' });
		expect(serverPathFor('arman/journal/fa/sub/x.mdx', 'arman/')?.path).toBe('journal/fa/sub/x.mdx');
		expect(serverPathFor('journal/en/x.md', '')?.path).toBe('journal/en/x.md');
	});
	it('rejects files outside the publish tree', () => {
		expect(serverPathFor('other/journal/en/x.md', 'arman')).toBeNull();
		expect(serverPathFor('arman/journal/de/x.md', 'arman')).toBeNull();
		expect(serverPathFor('arman/journal/en/x.png', 'arman')).toBeNull();
		expect(serverPathFor('arman/notes/en/x.md', 'arman')).toBeNull();
	});
});

describe('publishBundle', () => {
	const bundle = async (): Promise<Bundle> => ({
		notes: [
			{ path: 'journal/en/a.md', content: 'A', sha: await sha256Hex('A') },
			{ path: 'journal/en/b.md', content: 'B', sha: await sha256Hex('B') },
		],
		media: new Map([['journal/en/b.md', [{ name: 'h.png', base64: 'AA==' }]]]),
		warnings: [],
	});

	it('sends only changed notes, deletes vault notes that disappeared, and uploads media of changed notes', async () => {
		const b = await bundle();
		const calls: any[] = [];
		const http: HttpFn = vi.fn(async (req) => {
			calls.push(req);
			if (req.url.endsWith('/manifest')) return { status: 200, json: { files: { 'journal/en/a.md': b.notes[0].sha, 'journal/en/old.md': 'zzz' } } };
			return { status: 200, json: { written: 1, deleted: 1, unchanged: 0, media: 1, build: { id: '1', queued: false } } };
		});
		const r = await publishBundle(settings, b, http);
		const sent = JSON.parse(calls[1].body);
		expect(calls[0].url).toBe('https://site.test/api/ingest/manifest');
		expect(sent.files.map((f: any) => f.path)).toEqual(['journal/en/b.md']);
		expect(sent.delete).toEqual(['journal/en/old.md']);
		expect(sent.media).toHaveLength(1);
		expect(sent.build).toBe(true);
		expect(r).toMatchObject({ ok: true, written: 1, deleted: 1, unchanged: 1 });
		expect(describeResult(r)).toContain('Published: 1 updated, 1 removed, 1 unchanged');
	});

	it('reports a rejected token without sending notes', async () => {
		const http: HttpFn = vi.fn(async () => ({ status: 401, json: {} }));
		const r = await publishBundle(settings, await bundle(), http);
		expect(r.ok).toBe(false);
		expect(http).toHaveBeenCalledTimes(1);
		expect(describeResult(r)).toContain('token');
	});

	it('surfaces server validation errors with file and line', async () => {
		const http: HttpFn = async (req) => (req.url.endsWith('/manifest')
			? { status: 200, json: { files: {} } }
			: { status: 422, json: { error: 'validation failed – nothing was written', errors: [{ path: 'journal/en/b.mdx', line: 7, message: 'Unexpected closing tag' }] } });
		const r = await publishBundle(settings, await bundle(), http);
		expect(r).toMatchObject({ ok: false, status: 422 });
		expect(describeResult(r)).toContain('journal/en/b.mdx:7 – Unexpected closing tag');
	});

	it('refuses to wipe the site when the vault folder yields no notes', async () => {
		const http: HttpFn = vi.fn(async () => ({ status: 200, json: { files: { 'journal/en/a.md': 'x' } } }));
		const r = await publishBundle(settings, { notes: [], media: new Map(), warnings: [] }, http);
		expect(r.ok).toBe(false);
		expect(r.message).toContain('refusing to remove 1 page');
		expect(http).toHaveBeenCalledTimes(1);
	});

	it('marks dry runs', async () => {
		const http: HttpFn = async (req) => (req.url.endsWith('/manifest')
			? { status: 200, json: { files: {} } }
			: { status: 200, json: { dryRun: true, written: 2, deleted: 0, unchanged: 0, media: 0 } });
		const r = await publishBundle(settings, await bundle(), http, { dryRun: true });
		expect(describeResult(r)).toContain('Validation passed');
	});
});

import { describe, it, expect } from 'vitest';
import { convertObsidianMarkdown, frontmatterValue } from './obsidianSyntax';

const ctx = {
	resolveLink: (t: string) => (t === 'Vegord' ? '/en/projects/vegord/' : null),
	resolveImage: (n: string) => (n === 'arc.png' ? '/media/vault/abc.png' : null),
};
const conv = (s: string) => convertObsidianMarkdown(s, ctx);

describe('convertObsidianMarkdown', () => {
	it('resolves wikilinks, aliases and headings; falls back to plain text', () => {
		expect(conv('See [[Vegord]] and [[Vegord|the tool]] and [[Vegord#Big Part]] and [[Missing|nope]].').text)
			.toBe('See [Vegord](/en/projects/vegord/) and [the tool](/en/projects/vegord/) and [Big Part](/en/projects/vegord/#big-part) and nope.');
	});
	it('converts image embeds and reports them', () => {
		const r = conv('![[arc.png|Card]] ![[gone.png]]');
		expect(r.text.trim()).toBe('![Card](/media/vault/abc.png)');
		expect(r.images).toEqual(['arc.png']);
	});
	it('handles highlights, comments, callouts and block ids', () => {
		const r = conv('==hot== %%secret%%x\n> [!tip] Heads up\n> body\ntext ^abc12\n');
		expect(r.text).toBe('<mark>hot</mark> x\n> **Heads up**\n> body\ntext\n');
	});
	it('never touches fenced or inline code', () => {
		const src = 'a ==x==\n```ts\nconst h = "==y== [[Vegord]] %%z%%";\n```\nuse `[[Vegord]]` here';
		const out = conv(src).text;
		expect(out).toContain('const h = "==y== [[Vegord]] %%z%%";');
		expect(out).toContain('`[[Vegord]]`');
		expect(out).toContain('<mark>x</mark>');
	});
	it('leaves frontmatter untouched', () => {
		const src = '---\ntitle: "==a== [[b]]"\n---\nbody';
		expect(conv(src).text.startsWith('---\ntitle: "==a== [[b]]"\n---\n')).toBe(true);
	});
});

describe('frontmatterValue', () => {
	it('reads scalars', () => {
		expect(frontmatterValue('---\npublish: false\nslug: "my-slug"\n---\nx', 'publish')).toBe('false');
		expect(frontmatterValue('---\nslug: "my-slug"\n---\nx', 'slug')).toBe('my-slug');
		expect(frontmatterValue('no fm', 'slug')).toBeUndefined();
	});
});

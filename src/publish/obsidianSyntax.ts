/**
 * Converts Obsidian-flavoured Markdown into what the website's Astro/MDX pipeline understands.
 * Pure functions only (no Obsidian API), so they are trivially unit-testable.
 */

export interface ConvertContext {
	/** Public URL for a wikilink target (note name without extension), or null if unpublished. */
	resolveLink: (target: string) => string | null;
	/** Public URL for an embedded image file name, or null when it cannot be published. */
	resolveImage: (fileName: string) => string | null;
}

export interface ConvertResult {
	text: string;
	/** Image file names referenced by `![[...]]` / `![](local)` that were resolved. */
	images: string[];
}

const IMAGE_EXT = /\.(png|jpe?g|webp|avif|gif|svg)$/i;

/** Apply `fn` only to the parts of a document outside fenced and inline code. */
function outsideCode(text: string, fn: (chunk: string) => string): string {
	const out: string[] = [];
	const fence = /^(```|~~~)[^\n]*\n[\s\S]*?^\1[ \t]*$/gm;
	let last = 0;
	for (const m of text.matchAll(fence)) {
		out.push(transformInline(text.slice(last, m.index), fn), m[0]);
		last = (m.index ?? 0) + m[0].length;
	}
	out.push(transformInline(text.slice(last), fn));
	return out.join('');
}

function transformInline(chunk: string, fn: (c: string) => string): string {
	return chunk.split(/(`[^`\n]*`)/g).map((part, i) => (i % 2 === 1 ? part : fn(part))).join('');
}

export function slugifyHeading(text: string): string {
	return text.normalize('NFC').toLowerCase().trim().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-');
}

export function splitFrontmatter(src: string): { fm: string; body: string } {
	const m = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(src);
	return m ? { fm: m[0], body: src.slice(m[0].length) } : { fm: '', body: src };
}

export function convertObsidianMarkdown(src: string, ctx: ConvertContext): ConvertResult {
	const { fm, body } = splitFrontmatter(src);
	const images: string[] = [];

	const converted = outsideCode(body, (chunk) => {
		let s = chunk;
		// %%comments%% (single or multi-line)
		s = s.replace(/%%[\s\S]*?%%/g, '');
		// ![[image.png|alt or size]]
		s = s.replace(/!\[\[([^\]|#]+?)(?:\|([^\]]*))?\]\]/g, (_m, file: string, alias?: string) => {
			const name = file.trim();
			if (IMAGE_EXT.test(name)) {
				const url = ctx.resolveImage(name);
				if (url) {
					images.push(name);
					const alt = alias && !/^\d+(x\d+)?$/.test(alias.trim()) ? alias.trim() : name.replace(/\.[^.]+$/, '');
					return `![${alt}](${url})`;
				}
				return '';
			}
			return ''; // note embeds are not supported on the web; drop rather than leak raw syntax
		});
		// [[target#heading|alias]]
		s = s.replace(/\[\[([^\]|#]+?)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/g, (_m, target: string, heading?: string, alias?: string) => {
			const text = (alias ?? heading ?? target).trim();
			const url = ctx.resolveLink(target.trim());
			if (!url) return text;
			return `[${text}](${url}${heading ? `#${slugifyHeading(heading)}` : ''})`;
		});
		// ==highlight==
		s = s.replace(/==([^=\n][^\n]*?)==/g, '<mark>$1</mark>');
		// callouts: "> [!tip] Title" -> "> **Title**"
		s = s.replace(/^(\s*>\s*)\[!(\w+)\][+-]?[ \t]*(.*)$/gm, (_m, prefix: string, kind: string, title: string) =>
			`${prefix}**${title.trim() || kind[0].toUpperCase() + kind.slice(1).toLowerCase()}**`);
		// trailing block ids: "text ^abc123"
		s = s.replace(/[ \t]+\^[A-Za-z0-9-]+[ \t]*$/gm, '');
		return s;
	});
	return { text: fm + converted, images };
}

/** `---\nkey: x\n---` → value of a top-level scalar, or undefined. Good enough for `publish:`/`lang:`. */
export function frontmatterValue(src: string, key: string): string | undefined {
	const { fm } = splitFrontmatter(src);
	const m = new RegExp(`^${key}\\s*:\\s*(.*?)\\s*$`, 'm').exec(fm);
	return m ? m[1].replace(/^["']|["']$/g, '') : undefined;
}

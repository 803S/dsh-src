// Real knowledge-file discovery. No runtime globals, no silent fallback on IO errors.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { readCapsManifest, dshHomeOf } from '../capability-loader.js';
import { listAllLessons, readLessonFile } from '../lessons.js';
export const documentVersion = (text) => createHash('sha256').update(text).digest('hex').slice(0, 20);
export const documentIdentity = (source, file, text) => `${source}:${file}@${documentVersion(text)}`;
async function hydrateCandidate(candidate, manifest) {
  if (!candidate.readId || candidate.identity) return candidate;
  try {
    let raw, source;
    if (candidate.readTool === 'src_read_capability') {
      const cap = manifest.items.find((row) => row.id === candidate.readCapabilityId);
      if (!cap?.dir || cap.status !== 'installed' || cap.enabled === false) return { ...candidate, unavailable: true };
      source = path.resolve(cap.dir);
      const absolute = path.resolve(source, candidate.readId);
      if (!absolute.startsWith(source + path.sep)) return { ...candidate, unavailable: true };
      raw = await fs.readFile(absolute, 'utf8');
    } else { source = 'lesson'; raw = (await readLessonFile(candidate.readId)).text; }
    return { ...candidate, identity: documentIdentity(source, candidate.readId, raw) };
  } catch { return { ...candidate, unavailable: true }; }
}
export async function hydrateCandidates(candidates, home = dshHomeOf()) {
  let manifest;
  try { manifest = await readCapsManifest(home); } catch { manifest = { items: [] }; }
  return Promise.all(candidates.map((candidate) => hydrateCandidate(candidate, manifest)));
}
export function contextTerms(ctx) {
  const text = `${ctx.intentTitle ?? ''} ${ctx.intentDetail ?? ''} ${ctx.justification ?? ''} ${ctx.objective ?? ''} ${ctx.path ?? ''} ${ctx.query ?? ''}`.toLowerCase();
  const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
  return [...new Set([...segmenter.segment(text)].filter((s) => s.isWordLike && s.segment.length >= 2).map((s) => s.segment))].slice(0, 80);
}
export async function recallKnowledgeCandidates(ctx, max = 8, { home = dshHomeOf(), onError = () => {}, manifestReader = readCapsManifest, lessons = listAllLessons, lessonReader = readLessonFile } = {}) {
  const terms = contextTerms(ctx);
  if (!terms.length) return [];
  const documents = [];
  const report = (stage, error) => onError({ stage, code: String(error?.code ?? 'io') });
  let cap;
  try {
    const manifest = await manifestReader(home);
    if (manifest.parseError) report('manifest', { code: 'parse' });
    cap = manifest.items.find((row) => row.id === 'clown-src-playbook' && typeof row.dir === 'string' && row.enabled !== false && row.status === 'installed');
  }
  catch (error) { report('manifest', error); }
  if (cap) {
    const root = path.resolve(cap.dir);
    const walk = async (dir) => {
      let entries;
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch (error) { report('directory', error); return; }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const absolute = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(absolute);
        else if (entry.isFile() && entry.name.endsWith('.md')) {
          try {
            const text = await fs.readFile(absolute, 'utf8');
            const file = path.relative(root, absolute).split(path.sep).join('/');
            documents.push({ file, text, identity: documentIdentity(root, file, text), readTool: 'src_read_capability', readCapabilityId: cap.id });
          } catch (error) { report('file', error); }
        }
      }
    };
    await walk(path.join(root, 'skills/skill/知识库'));
  }
  // Lessons supplement the installed library; failures are not cached forever.
  try {
    for (const row of await lessons()) {
      try { const { text } = await lessonReader(row.file); documents.push({ file: row.file, text, identity: documentIdentity('lesson', row.file, text), readTool: 'src_read_lesson' }); }
      catch (error) { report('lesson', error); }
    }
  } catch (error) { report('lessons-index', error); }
  const df = new Map(terms.map((term) => [term, documents.filter((doc) => `${doc.file} ${doc.text}`.toLowerCase().includes(term)).length]));
  return documents.flatMap((doc) => {
    const title = /^#\s+(.+)$/m.exec(doc.text)?.[1]?.trim() ?? doc.file;
    const hay = `${doc.file} ${doc.text}`.toLowerCase();
    const matchedBy = terms.filter((term) => hay.includes(term));
    if (!matchedBy.length) return [];
    const score = matchedBy.reduce((n, term) => n + Math.log(1 + documents.length / (df.get(term) || 1)) * (title.toLowerCase().includes(term) ? 2 : 1), 0);
    return [{ id: doc.identity, identity: doc.identity, kind: 'lesson', title, summary: doc.text.split('\n').filter((line) => matchedBy.some((term) => line.toLowerCase().includes(term))).slice(0, 3).join('\n').slice(0, 1200), score, matchedBy, doc: doc.file, docs: [doc.file], readId: doc.file, readTool: doc.readTool, ...(doc.readCapabilityId ? { readCapabilityId: doc.readCapabilityId } : {}) }];
  }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, max);
}

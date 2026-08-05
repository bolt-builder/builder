import { describe, expect, it } from 'vitest';
import {
  KNOWLEDGE_DIR_ABSOLUTE,
  KNOWLEDGE_INJECTION_CHAR_BUDGET,
  buildKnowledgeBaseSection,
  collectKnowledgeDocuments,
  sanitizeKnowledgeFileName,
} from './knowledge';

const knowledgePath = (name: string) => `${KNOWLEDGE_DIR_ABSOLUTE}/${name}`;

describe('sanitizeKnowledgeFileName', () => {
  it('strips path segments and unsafe characters', () => {
    expect(sanitizeKnowledgeFileName('../../docs/my style?guide.md')).toBe('my style-guide.md');
    expect(sanitizeKnowledgeFileName('C:\\docs\\API Notes.txt')).toBe('API Notes.txt');
  });

  it('rejects names without an allowed extension or nothing usable', () => {
    expect(sanitizeKnowledgeFileName('script.sh')).toBeUndefined();
    expect(sanitizeKnowledgeFileName('...')).toBeUndefined();
  });
});

describe('collectKnowledgeDocuments', () => {
  it('returns only non-empty text files under the knowledge dir, sorted by name', () => {
    const documents = collectKnowledgeDocuments({
      [knowledgePath('b.md')]: { type: 'file', content: 'beta' },
      [knowledgePath('a.txt')]: { type: 'file', content: 'alpha' },
      [knowledgePath('empty.md')]: { type: 'file', content: '   ' },
      [knowledgePath('image.md')]: { type: 'file', content: 'x', isBinary: true },
      [KNOWLEDGE_DIR_ABSOLUTE]: { type: 'folder' },
      '/home/project/src/index.ts': { type: 'file', content: 'code' },
    });

    expect(documents.map((doc) => doc.name)).toEqual(['a.txt', 'b.md']);
    expect(documents[0]).toMatchObject({ path: knowledgePath('a.txt'), content: 'alpha' });
  });
});

describe('buildKnowledgeBaseSection', () => {
  it('returns undefined when there are no knowledge documents', () => {
    expect(buildKnowledgeBaseSection(undefined)).toBeUndefined();
    expect(buildKnowledgeBaseSection({ '/home/project/README.md': { type: 'file', content: 'hi' } })).toBeUndefined();
  });

  it('renders each document inside the knowledge_base wrapper', () => {
    const section = buildKnowledgeBaseSection({
      [knowledgePath('style.md')]: { type: 'file', content: 'Use tabs.' },
    });

    expect(section).toContain('<knowledge_base>');
    expect(section).toContain('<document name="style.md">');
    expect(section).toContain('Use tabs.');
  });

  it('truncates oversized documents and notes omitted ones', () => {
    const section = buildKnowledgeBaseSection({
      [knowledgePath('a-huge.md')]: { type: 'file', content: 'x'.repeat(KNOWLEDGE_INJECTION_CHAR_BUDGET + 1000) },
      [knowledgePath('b-late.md')]: { type: 'file', content: 'y'.repeat(1000) },
    });

    expect(section).toContain('[... truncated');
    expect(section).toContain('1 additional document(s) omitted');
    expect(section).not.toContain('yyyy');
  });
});

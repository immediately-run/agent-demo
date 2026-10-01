import { describe, it, expect } from 'vitest';
import { normalizeGrepFlags, ignoredFlagsNote, ignoredFlagReason } from './grepFlags';

// R3-856 — every case of the normaliser, including the transcript's own "n"
// and the stateful g/y pair that must never reach new RegExp.
describe('normalizeGrepFlags', () => {
  it('keeps the safe per-line flags, deduped', () => {
    expect(normalizeGrepFlags('i')).toEqual({ flags: 'i', ignored: [] });
    expect(normalizeGrepFlags('imsu')).toEqual({ flags: 'imsu', ignored: [] });
    expect(normalizeGrepFlags('iim')).toEqual({ flags: 'im', ignored: [] });
    expect(normalizeGrepFlags('')).toEqual({ flags: '', ignored: [] });
  });

  it('the transcript case: "n" is ignored, never an invalid-regex death', () => {
    expect(normalizeGrepFlags('n')).toEqual({ flags: '', ignored: ['n'] });
    expect(normalizeGrepFlags('in')).toEqual({ flags: 'i', ignored: ['n'] });
  });

  it('drops the stateful pair g and y', () => {
    expect(normalizeGrepFlags('g')).toEqual({ flags: '', ignored: ['g'] });
    expect(normalizeGrepFlags('y')).toEqual({ flags: '', ignored: ['y'] });
    expect(normalizeGrepFlags('gi')).toEqual({ flags: 'i', ignored: ['g'] });
  });

  it('ignores letters that are not accepted here — including the valid-elsewhere d and v', () => {
    expect(normalizeGrepFlags('v')).toEqual({ flags: '', ignored: ['v'] });
    expect(normalizeGrepFlags('inx')).toEqual({ flags: 'i', ignored: ['n', 'x'] });
    expect(ignoredFlagReason('v')).toBe('not accepted here (only i, m, s, u are)');
  });

  it('uppercase, digits and non-ASCII are ignored AND named, never silently dropped', () => {
    // round-1 finding: 'I' used to vanish with no note, running case-sensitive
    // — the exact failure class this item exists to kill.
    expect(normalizeGrepFlags('I')).toEqual({ flags: '', ignored: ['I'] });
    expect(normalizeGrepFlags('N2')).toEqual({ flags: '', ignored: ['N', '2'] });
    expect(normalizeGrepFlags('í')).toEqual({ flags: '', ignored: ['í'] });
    expect(ignoredFlagsNote(['I'])).toBe(' (ignored flags: I — not accepted here (only i, m, s, u are))');
  });

  it('a nullish raw reads as no flags, not a crash', () => {
    expect(normalizeGrepFlags(undefined as unknown as string)).toEqual({ flags: '', ignored: [] });
  });
});

describe('ignoredFlagsNote', () => {
  it('is empty when nothing was ignored', () => {
    expect(ignoredFlagsNote([])).toBe('');
  });

  it('names each ignored letter with its reason — the transcript wording', () => {
    expect(ignoredFlagsNote(['n'])).toBe(' (ignored flags: n — line numbers are always shown)');
    expect(ignoredFlagsNote(['g', 'y'])).toBe(
      ' (ignored flags: g — stateful with re.test here — matches would be skipped; y — stateful with re.test here — matches would be skipped)',
    );
  });

  it('unknown letters say they are not accepted here', () => {
    expect(ignoredFlagReason('v')).toBe('not accepted here (only i, m, s, u are)');
    expect(ignoredFlagReason('n')).toBe('line numbers are always shown');
  });
});

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

  it('ignores letters that are not JS RegExp flags at all', () => {
    expect(normalizeGrepFlags('v')).toEqual({ flags: '', ignored: ['v'] });
    expect(normalizeGrepFlags('inx')).toEqual({ flags: 'i', ignored: ['n', 'x'] });
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

  it('unknown letters say they are not JS RegExp flags', () => {
    expect(ignoredFlagReason('v')).toBe('not a JS RegExp flag');
    expect(ignoredFlagReason('n')).toBe('line numbers are always shown');
  });
});

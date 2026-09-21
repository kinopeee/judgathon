import { describe, it, expect } from 'vitest';
import { applyNameMask, buildNameMaskMap } from '../src/core/name-masking.js';

describe('name masking', () => {
  it('masks a single チーム<Name> occurrence', () => {
    const map = buildNameMaskMap(['チームAlpha を紹介します']);
    expect(applyNameMask('チームAlpha を紹介します', map)).toBe('チームA を紹介します');
  });

  it('masks Team <Name>', () => {
    const map = buildNameMaskMap(['Team Phoenix presents']);
    expect(applyNameMask('Team Phoenix presents', map)).toBe('Team A presents');
  });

  it('assigns labels in first-occurrence order across texts and reuses them', () => {
    const map = buildNameMaskMap([
      'チームGoogle と チームApple',
      'Team Phoenix',
      'また チームGoogle が登場',
    ]);
    expect(map.get('チームGoogle')).toBe('チームA');
    expect(map.get('チームApple')).toBe('チームB');
    expect(map.get('Team Phoenix')).toBe('Team C');
    expect(map.size).toBe(3);
    expect(applyNameMask('チームGoogle と チームApple', map)).toBe('チームA と チームB');
    expect(applyNameMask('Team Phoenix', map)).toBe('Team C');
    expect(applyNameMask('また チームGoogle が登場', map)).toBe('また チームA が登場');
  });

  it.each([
    'チームで開発した',
    'チームの構成',
    'PostgreSQL と Stripe を使った',
    'three pilot teams',
  ])('does not capture %s', (text) => {
    const map = buildNameMaskMap([text]);
    expect(map.size).toBe(0);
    expect(applyNameMask(text, map)).toBe(text);
  });

  it('preserves a lowercase prefix', () => {
    const map = buildNameMaskMap(['team alpha']);
    expect(applyNameMask('team alpha', map)).toBe('team A');
  });

  it('is deterministic and order-dependent', () => {
    const texts = ['Team Phoenix leads', 'チームAlpha follows'];
    const a = buildNameMaskMap(texts);
    const b = buildNameMaskMap(texts);
    expect([...a]).toEqual([...b]);
    const reversed = buildNameMaskMap([...texts].reverse());
    expect(reversed.get('チームAlpha')).toBe('チームA');
    expect(reversed.get('Team Phoenix')).toBe('Team B');
  });

  it('uses Excel-style labels past Z', () => {
    const texts = Array.from({ length: 27 }, (_, i) => `Team Name${i}`);
    const map = buildNameMaskMap(texts);
    expect(map.get('Team Name0')).toBe('Team A');
    expect(map.get('Team Name25')).toBe('Team Z');
    expect(map.get('Team Name26')).toBe('Team AA');
  });
});

import { describe, it, expect } from 'vitest';
import { constantTimeEqual } from './token.js';

describe('constantTimeEqual', () => {
  it('returns true for identical strings', () => {
    expect(constantTimeEqual('abc123', 'abc123')).toBe(true);
  });

  it('returns false for different strings of the same length', () => {
    expect(constantTimeEqual('abc123', 'abc124')).toBe(false);
  });

  it('returns false for strings of different length', () => {
    expect(constantTimeEqual('short', 'muchlongerstring')).toBe(false);
  });

  it('returns false against an empty string', () => {
    expect(constantTimeEqual('', 'nonempty')).toBe(false);
  });
});

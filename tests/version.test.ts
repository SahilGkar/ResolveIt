import { describe, it, expect } from 'vitest';
import { version, name, description } from '../src/version.js';

describe('version', () => {
  it('should have a version string', () => {
    expect(version).toBeDefined();
    expect(typeof version).toBe('string');
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('should have a name', () => {
    expect(name).toBe('resolveit');
  });

  it('should have a description', () => {
    expect(description).toBeDefined();
    expect(typeof description).toBe('string');
    expect(description.length).toBeGreaterThan(0);
  });
});
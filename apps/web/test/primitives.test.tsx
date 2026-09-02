/* =============================================================================
   Better Trigger — primitives regressions (T3).

   Sparkline fed a 0- or 1-point trend used to emit NaN/Infinity path
   coordinates (division by data.length - 1, Math.min over an empty spread).
   And every <Icon name="…"> reference must resolve to a real glyph — the
   "Load older logs" button shipped with an undefined chevronUp that silently
   rendered an empty svg.
   ============================================================================= */
/// <reference types="node" />
import { render } from '@testing-library/react';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Icon, Sparkline } from '../src/components/primitives';

describe('Sparkline degenerate trends', () => {
  it('renders nothing for an empty or single-point series', () => {
    for (const data of [[], [5]]) {
      const { container } = render(<Sparkline data={data} />);
      expect(container.querySelector('svg')).toBeNull();
    }
  });

  it('emits a finite path for two or more points', () => {
    const { container } = render(<Sparkline data={[1, 2, 3]} />);
    const paths = container.querySelectorAll('path');
    expect(paths.length).toBe(2);
    for (const p of paths) {
      expect(p.getAttribute('d')).not.toMatch(/NaN|Infinity/);
    }
  });
});

describe('icon references', () => {
  const collect = (): Set<string> => {
    const srcDir = join(process.cwd(), 'src');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name)) files.push(full);
      }
    };
    walk(srcDir);
    const patterns = [
      /<(?:Icon|IconButton)\b[^>]*?\bname="([a-zA-Z][a-zA-Z0-9]*)"/g,
      /\bicon="([a-zA-Z][a-zA-Z0-9]*)"/g,
      /\biconRight="([a-zA-Z][a-zA-Z0-9]*)"/g,
      /\bicon:\s*'([a-zA-Z][a-zA-Z0-9]*)'/g,
    ];
    const names = new Set<string>();
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const re of patterns) {
        let m: RegExpExecArray | null;
        while ((m = re.exec(text))) names.add(m[1]);
      }
    }
    return names;
  };

  it('references a non-empty set of icon names, including chevronUp', () => {
    const names = collect();
    expect(names.size).toBeGreaterThan(10);
    expect(names.has('chevronUp')).toBe(true);
  });

  it('every referenced icon name renders a real glyph (no empty svg)', () => {
    for (const name of collect()) {
      const { container } = render(<Icon name={name} />);
      const svg = container.querySelector('svg');
      expect(svg, `${name} renders no element`).not.toBeNull();
      expect(svg!.childElementCount, `${name} is referenced but not defined in ICONS`).toBeGreaterThan(0);
    }
  });
});

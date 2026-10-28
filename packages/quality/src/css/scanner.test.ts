import { describe, expect, it } from 'vitest';
import { allBlocks, scanCss } from './scanner.js';

describe('the CSS scanner', () => {
  it('finds the blocks, the declarations and the lines', () => {
    const source = ['.card {', '  color: red;', '  margin: 0 auto;', '}'].join('\n');

    const document = scanCss(source);

    expect(document.blocks).toHaveLength(1);
    const block = document.blocks[0];
    expect(block?.selector).toBe('.card');
    expect(block?.line).toBe(1);
    expect(block?.declarations.map((declaration) => declaration.property)).toEqual([
      'color',
      'margin',
    ]);
    expect(block?.declarations[0]?.line).toBe(2);
    expect(block?.declarations[1]?.line).toBe(3);
  });

  it('keeps a comment out of the way of the braces', () => {
    const source = ['/* a } in a comment */', '.card {', '  color: red;', '}'].join('\n');

    const document = scanCss(source);

    expect(document.blocks).toHaveLength(1);
    expect(document.blocks[0]?.selector).toBe('.card');
    expect(document.blocks[0]?.line).toBe(2);
  });

  it('keeps a string out of the way of the braces', () => {
    const source = ['.card {', '  content: "}";', '}'].join('\n');

    const document = scanCss(source);

    expect(document.blocks).toHaveLength(1);
    expect(document.blocks[0]?.declarations[0]?.value).toBe('"}"');
  });

  it('remembers the at-rule a block sits in', () => {
    const source = ['@media (min-width: 40rem) {', '  .card {', '    color: red;', '  }', '}'].join(
      '\n',
    );

    const document = scanCss(source);

    expect(document.blocks).toHaveLength(1);
    expect(document.blocks[0]?.selector).toBe('.card');
    expect(document.blocks[0]?.atRules).toEqual(['@media (min-width: 40rem)']);
    expect(document.atRules[0]?.name).toBe('media');
    expect(document.atRules[0]?.params).toBe('(min-width: 40rem)');
  });

  it('reads a keyframes block as steps, not as blocks', () => {
    const source = [
      '@keyframes fade {',
      '  from { opacity: 0; }',
      '  to { opacity: 1; }',
      '}',
    ].join('\n');

    const document = scanCss(source);

    expect(document.blocks).toHaveLength(0);
    expect(document.keyframes).toHaveLength(1);
    expect(document.keyframes[0]?.name).toBe('fade');
    expect(document.keyframes[0]?.steps).toHaveLength(2);
    expect(document.keyframes[0]?.steps[0]?.selector).toBe('from');
    expect(allBlocks(document)).toHaveLength(2);
  });

  it('marks an important declaration', () => {
    const source = ['.card {', '  color: red !important;', '}'].join('\n');

    const document = scanCss(source);

    expect(document.blocks[0]?.declarations[0]?.important).toBe(true);
    expect(document.blocks[0]?.declarations[0]?.value).toBe('red');
  });

  it('reads a declaration that has no semicolon', () => {
    const source = ['.card {', '  color: red', '}'].join('\n');

    const document = scanCss(source);

    expect(document.blocks[0]?.declarations).toHaveLength(1);
  });
});

import { describe, expect, it } from 'vitest';
import { copyOf } from './copy.js';
import { scanMarkup } from './scanner.js';

describe('the copy of a page', () => {
  it('is the text of the elements', () => {
    const document = scanMarkup('<h1>Ship faster</h1><p>And keep the record.</p>', 'html');
    const copy = copyOf(document);

    expect(copy.map((text) => text.text)).toEqual(['Ship faster', 'And keep the record.']);
  });

  it('is the value of the attributes a person reads', () => {
    const document = scanMarkup(
      '<img src="/a.png" alt="The board" title="The board at work" />',
      'html',
    );
    const copy = copyOf(document);

    expect(copy.map((text) => text.text)).toEqual(['The board', 'The board at work']);
  });

  it('is not the value of the attributes a person does not read', () => {
    const document = scanMarkup('<div class="card" id="a" data-x="1">Hello</div>', 'html');
    const copy = copyOf(document);

    expect(copy.map((text) => text.text)).toEqual(['Hello']);
  });

  it('is not the content of a code block', () => {
    const document = scanMarkup('<pre><code>const x = 1;</code></pre><p>Hello</p>', 'html');
    const copy = copyOf(document);

    expect(copy.map((text) => text.text)).toEqual(['Hello']);
  });

  it('is not a comment', () => {
    const document = scanMarkup('<p><!-- a note --></p>', 'html');

    expect(copyOf(document)).toEqual([]);
  });

  it('is not the text of a JSX file outside an element', () => {
    const document = scanMarkup('const x = 1;\n<div>Hello</div>', 'jsx');
    const copy = copyOf(document);

    expect(copy.map((text) => text.text)).toEqual(['Hello']);
  });

  it('knows the element it is in and the ancestors of it', () => {
    const document = scanMarkup('<section><p>Hello</p></section>', 'html');
    const [copy] = copyOf(document);

    expect(copy?.element?.name).toBe('p');
    // The tree has a root of its own, so the ancestors of the paragraph are
    // the root and the section, not the section alone.
    expect(copy?.ancestors.map((ancestor) => ancestor.name)).toEqual(['#document', 'section']);
  });
});

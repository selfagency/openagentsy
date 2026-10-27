import { describe, expect, it } from 'vitest';
import {
  attribute,
  classNames,
  elementsWithAncestors,
  hasAttribute,
  lineAt,
  scanMarkup,
} from './scanner.js';

describe('the markup scanner', () => {
  it('finds the elements of a page and the line they are on', () => {
    const document = scanMarkup('<div>\n  <p>Hello</p>\n</div>\n', 'html');

    const found = elementsWithAncestors(document.root);
    expect(found.map((entry) => entry.node.name)).toEqual(['div', 'p']);
    expect(found.map((entry) => entry.node.line)).toEqual([1, 2]);
  });

  it('reads the attributes of an element', () => {
    const document = scanMarkup('<a href="/plans" class="link">Plans</a>', 'html');
    const [link] = elementsWithAncestors(document.root);

    expect(attribute(link?.node ?? document.root, 'href')).toBe('/plans');
    expect(classNames(link?.node ?? document.root)).toEqual(['link']);
    expect(hasAttribute(link?.node ?? document.root, 'href')).toBe(true);
  });

  it('reads an attribute whatever the case it is written in', () => {
    const document = scanMarkup('<button onclick="save()">Save</button>', 'html');
    const [button] = elementsWithAncestors(document.root);

    expect(hasAttribute(button?.node ?? document.root, 'onClick')).toBe(true);
  });

  it('keeps a comment out of the text', () => {
    const document = scanMarkup('<p>before<!-- a note -->after</p>', 'html');
    const [paragraph] = elementsWithAncestors(document.root);
    const texts = (paragraph?.node ?? document.root).children.filter(
      (child) => child.kind === 'text',
    );

    expect(texts.map((child) => child.text)).toEqual(['before', 'after']);
    expect(
      (paragraph?.node ?? document.root).children.some((child) => child.kind === 'comment'),
    ).toBe(true);
  });

  it('does not read the content of a script as markup', () => {
    const document = scanMarkup('<script>if (a < b) { x(); }</script><p>after</p>', 'html');

    expect(elementsWithAncestors(document.root).map((entry) => entry.node.name)).toEqual([
      'script',
      'p',
    ]);
  });

  it('does not read a JSX expression as text', () => {
    const document = scanMarkup('<p>Hello {name}!</p>', 'jsx');
    const [paragraph] = elementsWithAncestors(document.root);
    const texts = (paragraph?.node ?? document.root).children.filter(
      (child) => child.kind === 'text',
    );

    // The expression is dropped and the text around it is merged, so the
    // paragraph holds one text node: the words, and the mark after them.
    expect(texts.map((child) => child.text)).toEqual(['Hello !']);
  });

  it('does not read a type argument as a tag', () => {
    const document = scanMarkup('const state = useState<string>(null);', 'jsx');

    expect(elementsWithAncestors(document.root)).toEqual([]);
  });

  it('reads a JSX element as an element', () => {
    const document = scanMarkup('export default <div>Hello</div>;', 'jsx');

    expect(elementsWithAncestors(document.root).map((entry) => entry.node.name)).toEqual(['div']);
  });

  it('leaves the text of a JSX file outside an element to the code', () => {
    const document = scanMarkup('const x = 1;\n<div>Hello</div>', 'jsx');
    const [element] = elementsWithAncestors(document.root);

    expect(element?.node.children[0]?.text).toBe('Hello');
  });
});

describe('the line of a match', () => {
  it('counts the lines the text holds before the match', () => {
    expect(lineAt(3, 'one\ntwo\nthree', 8)).toBe(5);
  });

  it('is the line of the text when the match is at the start', () => {
    expect(lineAt(7, 'one', 0)).toBe(7);
  });
});

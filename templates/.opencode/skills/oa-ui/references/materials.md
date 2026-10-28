# The material inventory

Hallmark's rule, and the one that keeps a change honest: before you
write a line, know what is real.

## The list

Three parts, and the third is the one people skip.

1. **What is real.** The things that exist and can be used: the copy
   that is written, the data that is there, the product that ships, the
   screenshot that was actually taken, the number that was measured.
2. **Which pictures exist.** Every image, chart, diagram, logo and
   screenshot, and where each one comes from. A path, a URL, a
   screenshot in the repository, a place it will be produced.
3. **What is absent.** The things the design assumes and nobody has
   supplied: a photo, a customer name, a logo, a price, a count, a
   quote.

## Holding the change to the list

Every element in the change maps to an entry. An element that maps to
nothing is either invented or missing, and both are the same failure:
the page says something that is not true.

An **invented** element is a fact that was never true: a made-up
customer, a statistic nobody measured, a testimonial nobody gave, a
logo of a company that is not a customer, a chart drawn from invented
data. This is a floor finding, because it is an honesty failure.

A **missing** element is a placeholder the design asked for and nobody
supplied: the photograph of the team, the price of the third tier, the
screenshot of the report. This is not a failure, as long as it is
visible as a placeholder and not dressed up as the real thing.

## Honest placeholders

A placeholder is honest when it says what it is, and it looks like a
placeholder to anyone who sees the page.

```html
<!-- source: the pricing table in the 2026 Q3 export, row 4 -->
<p>Teams save 12 hours a week on average</p>

<img src="/images/team-placeholder.png" data-placeholder="team photo, 2026" alt="The support team" />
```

The rule that matters: **a placeholder never wears the clothes of the
real thing.** A grey box that is styled like a photograph is a
photograph to a reader who does not know better. The mark has to be
visible.

## Claims

A claim is any statement a reader could check: a number, a ratio, a
time, a count, a superlative, a name of a customer, a quote.

Every claim is either:

- **sourced** - it came from somewhere, and the source is in the
  change, next to it, so a reader can check it;
- **a placeholder** - the value is not known yet, and the mark says so;
- **not a claim** - it is a description of the thing itself, not a
  measurement of it. "Three steps" is a description. "Cuts onboarding
  by 60%" is a claim.

The floor rule behind this: an unsourced claim is resolved by adding a
source or a placeholder marker. **Deleting the copy is not required**,
and deleting the requirement is not a fix. If the product needs the
number, the number has to come from somewhere.

## What counts as a picture

A picture is anything the reader sees as an image: a photograph, an
illustration, an icon, a logo, a chart, a diagram, a screenshot, a
video poster, an avatar.

Each one needs an answer to two questions:

- **Does it exist?** A path that resolves, a file in the repository, a
  URL that is known to work. A file name that was invented is not a
  picture, it is a broken image with a good name.
- **Where did it come from?** A licence, a photographer, a screenshot
  of what, a chart built from which export.

An icon is a picture too. An emoji used as an icon is a picture with
no licence and no consistency, and it is a reflex finding.

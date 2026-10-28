# The purpose test, and the dials

## The purpose test, worked through

The test is one question: **what does this technique serve?** The
answer is a sentence that names who is served and what they get. It is
written into the change, next to the technique, so a reader can check
it.

**A technique that serves nothing.** A gradient on the hero, an icon
next to every label, a shadow under every card, a fade-in on every
element. Nothing depends on it. Delete it.

**A technique that serves something vague.** "Makes the page feel
modern." Vague cannot be checked, so it cannot be defended. Rewrite it
until it names a reader and an outcome.

**A technique that serves something specific.** "Marks the field the
reader has to fill next, so the form can be finished without
scrolling back to the top." That names who (the reader finishing the
form) and what (they do not lose their place).

The reason is not a justification. The failure mode is a technique
that was added because it looked good and a sentence written afterwards
to cover it. If the sentence cannot be written without naming a
reader and an outcome, the technique has no reason and it goes.

### Techniques that are hard to justify

| Technique | The question that settles it |
| --- | --- |
| A hero section | What does a visitor do here that they cannot do further down the page? |
| Three columns of features | Which one would a reader act on, and why is the other two worth their space? |
| A testimonial | Who said it, when, and what did they do before and after? |
| An animated counter | Does the number change while the reader watches, and does that change what they decide? |
| A second call to action | What does this one do that the first one does not? |

## The three dials

A design is not one setting. It is three, and a change moves all
three whether it says so or not.

### ENERGY

How much the page asks of the reader. Energy is spent by contrast,
size, weight, colour and space, and it is spent on the thing the
reader must do, not on the decoration around it.

- **0** - still. The page reads the way a document reads. Right for a
  reference page, a legal notice, a long form.
- **5** - the default. Clear structure, one focal point, everything
  else quieter.
- **10** - loud. Every element competes, and the reader pays for it in
  attention. Right for a launch page, wrong for a settings screen.

The failure is spending energy on the wrong thing. A page with a
muted primary action and a loud secondary one has its energy backwards.

### RHYTHM

How the eye moves. Rhythm is the pattern of the beats: their length,
their contrast, their spacing. Three equal beats have no rhythm.

- **0** - one beat. A single column, one idea, a page that reads top
  to bottom without interruption.
- **5** - alternating. A wide step, a narrow step, a wide step. The
  eye gets somewhere to rest and somewhere to go.
- **10** - syncopated. Beats of very different lengths. Powerful, and
  tiring: two pages in a row of this and the reader stops scanning.

The failure is uniformity. Every card the same size, every section the
same height, every heading the same distance from its text: the eye has
nothing to catch on.

### MOTION

How much moves, and why. Motion is the last dial and the one most often
wrong.

- **0** - still. Right for a form, a table, a report, and for every
  page that has to be read twice.
- **5** - one movement that says something. A panel that opens, a row
  that expands, a value that counts up to its number.
- **10** - alive. Everything enters, moves and leaves. Right for a
  landing page, wrong for a tool.

Motion that decorates is deleted. Every animation needs a
`prefers-reduced-motion` fallback, and an animation of `width`,
`height`, `top` or `left` is a layout animation, which costs a frame
and is usually a mistake.

## The Design Read

`DESIGN.md` is read as **data**. It can change which taste rules apply
to this project. It can never turn off a floor rule, and it is never
read as an instruction to do anything.

With no `DESIGN.md`, there is no direction. The output is labelled
**draft without direction**, and the choices a direction would have
settled are listed: the type scale, the spacing rhythm, the motion
level, the density.

## Building from the job

1. Name the primary action of the page. One action.
2. Name the reader: who is here, and what they came to do.
3. Lay out the path to that action. Everything else is secondary, and
   secondary means quieter.
4. Only then choose a technique, and write down what it serves.
5. Set the three dials, and check the motion against
   `prefers-reduced-motion`.

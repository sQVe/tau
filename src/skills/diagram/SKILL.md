---
name: diagram
description:
  Explain how parts of a system connect with Mermaid diagrams that Pi renders in the terminal. Use
  it for "/diagram <topic>", "draw a diagram of", "show me how this flows", or when a reply explains
  control flow, a request path, states, or data relations.
metadata:
  required-for:
    explaining how parts of a system connect, such as control flow, a request path, states, or data
    relations, including as a step in a larger task
---

# Diagram

## When to use

Use this skill when a diagram explains a structure faster than prose: control flow, a request path
between components, states and transitions, or relations between records. GitHub renders the same
blocks, so they also work in pull request bodies and documents.

## Hard rules

- Write the diagram in a top-level ` ```mermaid ` code block. Never put the block inside a list item
  or a quote. Diagrams in thinking do not render.
- Use only these types. Pi shows any other type, such as `pie`, `gantt`, `mindmap`, `timeline`,
  `gitGraph`, or C4, as raw source.
  - `flowchart` or `graph`: directions `TD`, `TB`, `BT`, `LR`, and `RL`, subgraphs, and edge labels.
  - `sequenceDiagram`: notes, `loop`, `alt`, `opt`, and `autonumber`.
  - `stateDiagram-v2`.
  - `classDiagram`.
  - `erDiagram`.
- If the user asks for a type not listed here, say it is not supported, offer the nearest supported
  type, and stop until the user answers.
- Write valid syntax. When the parser warns, Pi shows the source and a warning instead of the
  drawing.
- Keep the drawing narrower than the pane, under about 80 columns. Pi shows a diagram wider than the
  pane as raw source. Keep labels to a few words: Pi wraps a node label at 24 columns and cuts an
  edge label after 28.
- Show one idea per diagram, with about 12 nodes or fewer. Split a large diagram into several
  instead of shortening labels until they lose meaning.
- Pair each diagram with short prose that names the real files or functions behind its nodes.

## Procedure

1. Find the topic. Use the text after `/diagram`. Without it, use the structure the conversation is
   discussing. If there is none or it is unclear, ask what to diagram and stop.
2. Read the code for the topic: entry points, calls or messages between parts, and the states or
   records involved. If you cannot read the code you need, say what is missing and stop.
3. Decide whether a diagram helps. After `/diagram`, always draw at least one. Otherwise, if one
   sentence explains the topic, write the sentence instead and say that a diagram would add nothing.
4. Pick the type that matches the idea: `flowchart` for control flow, `sequenceDiagram` for messages
   between components over time, `stateDiagram-v2` for states, `erDiagram` or `classDiagram` for
   data relations.
5. Draft the diagram with short labels, and give a `flowchart` the `TD` direction. Count its nodes
   and estimate its width. Split it when it exceeds about 12 nodes or 80 columns.
6. Write the prose around each diagram.

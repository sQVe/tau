---
name: diagram
description:
  Draw Mermaid diagrams that Pi renders in the terminal. Use it when a reply explains how parts of a
  system connect. With a topic after `/diagram`, such as `/diagram the worker lifecycle`, read the
  relevant code and explain that topic with one or more diagrams.
metadata:
  required-for:
    explaining how parts of a system connect, such as control flow, a request path, states, or data
    relations
---

# Diagram

## When to use

Use this skill when a diagram explains a structure faster than prose: control flow, a request path
between components, states and transitions, or relations between records.

With `/diagram <topic>`, read the code for the topic first. Then explain it with one or more
diagrams and short prose.

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
- Write valid syntax. When the parser warns, Pi shows the source and a warning instead of the
  drawing.
- Keep the drawing narrower than the pane. Pi shows a diagram wider than the pane as raw source.
  Prefer `TD` over `LR`, keep labels to a few words, and aim for under about 80 columns.
- Show one idea per diagram, with about 12 nodes or fewer. Split a large diagram into several
  instead of shortening labels until they lose meaning.
- Pair each diagram with short prose that names the real files or functions behind its nodes.

## Procedure

1. Decide whether a diagram helps. If one sentence explains the point, write the sentence instead.
2. Pick the type that matches the idea: `flowchart` for control flow, `sequenceDiagram` for messages
   between components over time, `stateDiagram-v2` for states, `erDiagram` or `classDiagram` for
   data relations.
3. Draft the diagram with short labels in `TD` direction. Count its nodes and estimate its width.
   Split it when it exceeds about 12 nodes or 80 columns.
4. Write the prose around each diagram. Name the files or functions each part comes from.

The same blocks render on GitHub, so you can reuse them in pull request bodies and documents.

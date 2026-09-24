---
name: PrepForge Chess
description: Incumbent desktop design system recorded before the desktop redesign
colors:
  background: "#f4f3f1"
  panel: "#ffffff"
  panel-soft: "#faf9f7"
  line: "#d8d4ce"
  text: "#1c1c1c"
  muted: "#5e5e5e"
  amber: "#d18b3f"
  amber-strong: "#9d5e1f"
  dark-background: "#151311"
  dark-panel: "#211d19"
  dark-text: "#f5efe8"
  dark-amber: "#dda15e"
rounded:
  control: "4px"
  card: "6px"
spacing:
  tight: "6px"
  regular: "10px"
  workspace: "18px"
---

## Overview

This records the visual system present on `origin/main` before the desktop redesign. The code source is `web-src/styles.css`; baseline browser captures are in `.impeccable/review/before-*.png`.

## Colors

The interface pairs warm neutral surfaces and amber actions with a tan and brown chessboard. A dark theme uses brown-black surfaces, pale warm text, and brighter amber. Green, red, and blue are reserved for meaningful success, danger, and brilliant move states.

## Typography

The UI uses Inter with Segoe UI and system sans fallbacks at a 14 px root size. Section headings are compact and bold. Data and chess notation use monospace where alignment or notation matters.

## Layout

At desktop widths the study views use a square board sized against viewport height and a flexible right sidebar. The sidebar scrolls internally. Games and Teams use up to 1400 px of width; Settings remains narrower. At mobile widths the layouts collapse to a vertical flow.

## Elevation & Depth

The incumbent interface is mostly flat. Fine borders and tonal surface changes separate cards; overlays receive soft shadows.

## Shapes

Controls use 4 px corners, cards 6 px, and small chips may be pill shaped. The board frame remains square with a subtle corner.

## Components

Primary buttons carry amber fill. Ghost buttons, segmented controls, cards, collapsible drawers, list rows, and status chips share border and text tokens. Navigation uses an amber active tab. Keyboard focus is explicitly outlined.

## Do's and Don'ts

Preserve the board's prominence, task labels, focus visibility, semantic status color, and warm palette. Avoid decorative cards or space consuming copy that competes with active chess work.

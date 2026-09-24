---
name: PrepForge Chess
description: Warm amber workbench for chess preparation and review
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
  card: "10px"
spacing:
  tight: "6px"
  regular: "10px"
  workspace: "20px"
---

## Overview

This records the current desktop workbench. The incumbent system is archived in `docs/desktop-design-before.md`; implementation tokens and responsive rules live in `web-src/styles.css`.

## Colors

The interface pairs warm neutral surfaces and amber actions with a tan and brown chessboard. A dark theme uses brown-black surfaces, pale warm text, and brighter amber. Green, red, and blue are reserved for meaningful success, danger, and brilliant move states.

## Typography

The UI uses Inter with Segoe UI and system sans fallbacks at a 14 px root size. Section headings are compact and bold. Data and chess notation use monospace where alignment or notation matters.

## Layout

At desktop widths the study views use a square board sized against viewport height and a flexible right sidebar. The board takes priority and stays stable while side content scrolls. Games and Scout reserve broad result canvases, Teams uses a master/detail split, and Settings uses two columns up to 1200 px. At mobile widths the layouts collapse to a vertical flow.

## Elevation & Depth

The interface is mostly flat. Fine borders and tonal surface changes separate regions; the board has a soft offset shadow, and overlays receive stronger soft shadows.

## Shapes

Controls use 4 px corners, desktop cards 10 px, and small chips may be pill shaped. The board frame remains square with a subtle corner.

## Components

Primary buttons carry amber fill. Ghost buttons, segmented controls, cards, collapsible drawers, list rows, and status chips share border and text tokens. Navigation uses an amber active tab. Keyboard focus is explicitly outlined.

## Do's and Don'ts

Preserve the board's prominence, task labels, focus visibility, semantic status color, and warm palette. Reserve space for data as it loads. Use quiet empty states; keep action groups compact and visible. Avoid decorative cards or space consuming copy that competes with active chess work.

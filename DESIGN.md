---
name: OAI-PMH Explorer
description: A precise metadata workbench for inspecting OAI-PMH repositories.
colors:
  cool-paper: "oklch(0.985 0.003 240)"
  cool-paper-soft: "oklch(0.97 0.004 240)"
  surface: "#ffffff"
  border: "oklch(0.9 0.005 240)"
  border-strong: "oklch(0.82 0.008 240)"
  graphite: "oklch(0.2 0.012 240)"
  graphite-muted: "oklch(0.45 0.012 240)"
  graphite-dim: "oklch(0.6 0.01 240)"
  teal: "oklch(0.55 0.13 195)"
  teal-hover: "oklch(0.48 0.14 195)"
  teal-soft: "oklch(0.96 0.03 195)"
typography:
  headline:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, Segoe UI, system-ui, sans-serif"
    fontSize: "36px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  body:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, Segoe UI, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, Segoe UI, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.5
  mono:
    fontFamily: "JetBrains Mono, ui-monospace, SF Mono, Menlo, Consolas, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  sm: "2px"
  md: "4px"
  lg: "6px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.teal}"
    textColor: "{colors.surface}"
    rounded: "{rounded.md}"
    padding: "9px 16px"
  button-primary-hover:
    backgroundColor: "{colors.teal-hover}"
    textColor: "{colors.surface}"
    rounded: "{rounded.md}"
    padding: "9px 16px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.graphite}"
    rounded: "{rounded.md}"
    padding: "9px 12px"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.graphite}"
    rounded: "{rounded.md}"
    padding: "20px"
---

# Design System: OAI-PMH Explorer

## 1. Overview

**Creative North Star: "Metadata Workbench"**

Interface feels like a dependable specialist tool: precise, quiet, and ready for sustained metadata work. Familiar controls and compact information density help experienced users move quickly while clear labels support people still learning OAI-PMH.

Visual hierarchy comes from spacing, typography, borders, and restrained teal state color. System rejects playful SaaS styling, decorative effects, and invented controls.

**Key Characteristics:**

- Cool, paper-like surfaces with graphite text
- Restrained teal reserved for actions, focus, and state
- Dense but readable metadata presentation
- Responsive layouts that preserve task order on narrow screens

## 2. Colors

Cool neutrals create a low-distraction workspace; muted teal marks interaction without dominating content.

### Primary

- **Workbench Teal** (`oklch(0.55 0.13 195)`): Primary actions and active state.
- **Deep Workbench Teal** (`oklch(0.48 0.14 195)`): Hover state.
- **Teal Wash** (`oklch(0.96 0.03 195)`): Focus rings and selected rows.

### Neutral

- **Cool Paper** (`oklch(0.985 0.003 240)`): Page background.
- **Soft Cool Paper** (`oklch(0.97 0.004 240)`): Secondary surfaces and hover fills.
- **Surface White** (`#ffffff`): Inputs, cards, tables, and navigation surfaces.
- **Graphite** (`oklch(0.2 0.012 240)`): Primary text.
- **Muted Graphite** (`oklch(0.45 0.012 240)`): Supporting text.
- **Structural Border** (`oklch(0.9 0.005 240)`): Dividers and containers.

**The One Signal Rule.** Teal communicates action or state; it is not decoration.

## 3. Typography

**Display Font:** Inter (system sans fallback)
**Body Font:** Inter (system sans fallback)
**Label/Mono Font:** JetBrains Mono (system monospace fallback)

**Character:** Neutral sans-serif keeps controls familiar. Monospace distinguishes identifiers, XML, URLs, commands, and protocol values.

### Hierarchy

- **Display** (600, 36px, 1.2): Documentation and landing titles.
- **Headline** (600, 17px, 1.3): Screen and card headings.
- **Title** (600, 14px, 1.5): Section headings.
- **Body** (400, 14px, 1.5): Interface copy, with prose capped near 65ch.
- **Label** (500, 12px, -0.005em): Form and control labels.

**The Protocol Type Rule.** Use monospace only where exact characters carry meaning.

## 4. Elevation

System is flat by default. Borders and tonal surfaces establish structure; compact shadows appear only on floating overlays or where layers would otherwise be ambiguous.

### Shadow Vocabulary

- **Surface Hairline** (`0 1px 0 rgba(15, 23, 42, 0.04)`): Minimal separation.
- **Raised Surface** (`0 1px 2px rgba(15, 23, 42, 0.06), 0 0 0 1px rgba(15, 23, 42, 0.03)`): Rare raised containers.
- **Overlay** (`0 10px 28px rgba(15, 23, 42, 0.1), 0 2px 6px rgba(15, 23, 42, 0.04)`): Combobox popovers.

**The Flat-by-Default Rule.** Add shadow only when element occupies a higher interaction layer.

## 5. Components

### Buttons

- **Shape:** Compact rectangle with 4px radius.
- **Primary:** Workbench Teal, white text, 9px 16px padding.
- **Hover / Focus:** Darker teal on hover; visible teal focus ring.
- **Secondary:** White surface, structural border, graphite text.

### Chips

- **Style:** Pill shape, white background, muted text, structural border.
- **State:** Teal reserved for selected or actionable state, not decoration.

### Cards / Containers

- **Corner Style:** 4px radius.
- **Background:** Surface White.
- **Shadow Strategy:** Flat by default.
- **Border:** 1px Structural Border.
- **Internal Padding:** Usually 16px to 24px.

### Inputs / Fields

- **Style:** White surface, 1px strong border, 4px radius, 9px 12px padding.
- **Focus:** Teal border with 3px Teal Wash ring.
- **Affordance:** Text fields use text cursors; only real selects show dropdown carets.

### Navigation

Sticky white top bar with structural bottom border. Labels use compact sans-serif type; narrow layouts remove secondary content before primary navigation.

### Set Combobox

Searchable repository-set picker. Trigger matches input styling; popover uses overlay shadow and selected rows use Teal Wash.

## 6. Do's and Don'ts

### Do:

- **Do** preserve native and familiar control behavior.
- **Do** reserve Workbench Teal for actions, focus, selection, and status.
- **Do** use monospace for exact metadata and protocol values.
- **Do** stack controls in task order below the 800px breakpoint.
- **Do** maintain visible keyboard focus and WCAG 2.2 AA contrast.

### Don't:

- **Don't** use playful SaaS styling.
- **Don't** invent controls or add misleading affordances.
- **Don't** use teal as decorative filler.
- **Don't** hide essential metadata to make mobile layouts appear simpler.
- **Don't** use deep shadows on static containers.

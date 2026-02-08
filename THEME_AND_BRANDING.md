# Theme & Branding Instructions
## Deep Dive Brewing Co Website

## Purpose
Define a calm, readable, long-lasting visual system for the Deep Dive Brewing website.
This is a brewery and hospitality brand — not a tech product, design demo, or marketing experiment.

---

## Core Design Principles
* Calm and readable
* Crafted, not clinical
* Earthy and grounded
* Typography-driven
* Single, consistent palette

---

## Non-Negotiable Rules
* Do NOT use pure black (#000000)
* Do NOT use pure white (#FFFFFF)
* Do NOT implement light/dark mode
* Do NOT introduce diagonal stripes, dive-flag motifs, or label graphics unless explicitly requested
* Do NOT use beer label typography outside of beer names
* Do NOT introduce new colors without updating this document

---

## Base Site Palette (Global)
These colors are used across the entire site.

### Background ("Paper")
Warm off-white used for all page backgrounds and cards.
```
Paper: #FAFAF8
```

### Primary Text ("Ink")
Soft charcoal / blue-black used for all body text and headings.
```
Ink: #0B0F14
```
This replaces pure black everywhere.

### Secondary Neutral ("Stone")
Quiet neutral used for borders and dividers.
```
Stone: #E6E7E3
```

---

## Earth Accent Colors (Support Only)
These colors are accents, not primary UI colors.
Refined from the beer label color palette but used site-wide.

```
Moss (green):  #2F6F4E
Ember (red):   #9B2C2C
Sand (grain):  #B08968
Ocean (blue):  #334E68
```

### Usage Rules:
* Small highlights only
* Icons, separators, metadata badges
* Horizontal rules and dividers
* Never as full backgrounds or navigation colors
* Never as primary text color

---

## Beer Color Palette (Contextual Use Only)
These colors represent specific beer styles and are extracted from actual can labels.
They may be used ONLY in:
* Beer cards
* Beer detail pages
* Small beer-specific accents

Beer colors must NEVER be used in:
* Global navigation
* Page backgrounds
* Typography outside beer sections
* General UI elements

### Color Definitions

```
Pilsner Green:      #1E8E3E  (vibrant green from Pilsner can)
Double IPA Purple:  #7B5D9E  (muted purple/lavender from DIPA can)
Stout Brown:        #A67C52  (warm tan/brown from Stout can)
American Amber Red: #D32F2F  (bright red from Amber can)
Pale Lager Yellow:  #FFD700  (golden yellow from Lager can)
NEIPA Orange:       #FF8C42  (coral/peach orange from NEIPA can)
Belgian IPA Sage:   #B8C5A0  (muted sage green from Belgian IPA can)
Dutch Kuit Blue:    #004B87  (deep blue from Kuit can)
Dutch Kuit Orange:  #E47041  (burnt orange from Kuit can)
```

### Beer Color Usage Examples:
* Thin left border on beer cards (2px)
* Tag backgrounds at 10-15% opacity
* Hover state accent on beer cards
* Small icon fills in beer detail pages
* NEVER as full card backgrounds
* NEVER as text color

---

## Typography System
Typography is the primary brand expression.

### Brand Typography (Site-Wide)

#### Primary Brand Font: Festival Budaya XXXI
Use only for:
* Homepage hero headline
* Rare, high-impact brand moments

**Sizes:**
* Hero (homepage): 56px / 64px line-height (desktop), 40px / 48px (mobile)

#### Secondary Brand Font: Trajan Pro Bold
Use for:
* Section headings
* Page titles
* Editorial hierarchy

**Sizes:**
* H1 (Page titles): 40px / 48px line-height (desktop), 32px / 40px (mobile)
* H2 (Section headings): 32px / 40px line-height (desktop), 28px / 36px (mobile)
* H3 (Subsections): 24px / 32px line-height (desktop), 20px / 28px (mobile)

---

### Body Typography: Inter

Inter is used for all body text, navigation, buttons, and general UI.

**Sizes:**
* Body (default): 18px / 28px line-height (desktop), 16px / 24px (mobile)
* Small text: 14px / 20px line-height
* Caption/metadata: 12px / 18px line-height

**Font weights:**
* Regular (400): Body text
* Medium (500): Subtle emphasis, navigation
* Semibold (600): Buttons, strong emphasis
* Bold (700): Rare use only

---

### Product / Label Typography (Beer Names ONLY)
These fonts are product typography, not brand typography.
They appear on beer labels and should remain contextual to beer-specific content only.

#### Money Money Plus
Use ONLY for:
* Beer names on beer cards
* Beer titles on detail pages

**Sizes:**
* Beer card title: 32px / 36px line-height
* Detail page hero: 48px / 56px line-height (desktop), 36px / 44px (mobile)

#### AccaciaFlare Bold
Use ONLY for:
* Beer style/type labels (IPA, Amber, Lager, Stout, etc.)

**Sizes:**
* Style tags: 12px / 16px line-height, uppercase, letter-spacing: 0.05em

#### Gotham Black
Use sparingly for:
* Small supporting beer metadata (e.g. "Made on Saba" text)
* ABV/IBU specifications

**Sizes:**
* Date labels: 11px / 14px line-height, uppercase
* Specs (ABV/IBU): 12px / 16px line-height

---

### Label Typography Rules
Label typography (Money Money Plus, AccaciaFlare Bold, Gotham Black) must NEVER be used for:
* Navigation
* Call-to-action buttons
* Page headings outside beer sections
* General UI text
* Footer content
* Form labels

---

## Spacing & Layout System

### Vertical Spacing (Section Separation)
* Large sections: 120px (desktop), 80px (mobile)
* Medium sections: 80px (desktop), 48px (mobile)
* Small sections: 48px (desktop), 32px (mobile)

### Component Spacing
* Card padding: 32px (desktop), 24px (mobile)
* Card gap (grid): 24px
* Inline elements: 16px horizontal spacing (desktop), 12px (mobile)
* Button padding: 16px vertical, 32px horizontal

### Content Width
* Max content width: 1200px (keeps lines readable)
* Optimal reading width (text-heavy): 720px
* Full bleed allowed for: hero images, background videos, full-width CTA sections

### Whitespace Philosophy
Generous whitespace is a design feature, not wasted space.
When in doubt, add more space rather than less.

---

## Motion & Animation Guidelines

### Animation Principles
* Minimal animation
* Functional, not decorative
* Feels like printed material coming into view, not a web app

### Allowed Animations
* Hover states: Subtle opacity shift (1.0 → 0.85) or slight color change (200ms ease)
* Loading states: Simple fade-in (300ms ease)
* Page transitions: None (or instant)
* Scroll effects: None (no parallax, no scroll-triggered reveals)

### Forbidden Animations
* Parallax scrolling
* Animated SVG decorations
* Bouncing or elastic easing
* Rotating elements
* Auto-playing carousels

If animation is used, it must feel calm and purposeful.

---

## Visual No-Go List
These elements are explicitly banned from the design system:

* Gradient backgrounds
* Drop shadows (except very subtle card shadows: 0 1px 3px rgba(0,0,0,0.08))
* Neon colors or high saturation outside beer colors
* Geometric patterns (triangles, hexagons, tessellations)
* Cartoon illustrations
* Stock photos of people holding beer glasses
* Animated background effects
* Particle systems or floating elements
* Glowing effects or outer glow
* Beveled edges or embossing

---

## Layout & UI Tone
* Mobile-first responsive design
* Generous whitespace
* Editorial rhythm (varies content density for visual interest)
* Minimal decoration
* Clear hierarchy through typography and spacing, not color

The site should feel calm even when color is present.

---

## shadcn / Tailwind Guidance
* Use light mode variables only
* Map colors semantically (paper, ink, stone, earth accents)
* Avoid raw hex values inside components
* Keep components restrained and composable
* Use CSS variables for all color references

### Example Tailwind Config Mapping
```
colors: {
  paper: '#FAFAF8',
  ink: '#0B0F14',
  stone: '#E6E7E3',
  moss: '#2F6F4E',
  ember: '#9B2C2C',
  sand: '#B08968',
  ocean: '#334E68',
}
```

---

## Design Philosophy

### This site should feel like:
* A printed tasting sheet
* A well-designed bar menu
* A confident craft brand
* An editorial magazine spread

### It should NOT feel like:
* A startup landing page
* A design trend experiment
* A UI showcase
* A beer label reproduction
* A SaaS product dashboard

---

## Success Criteria
The theme is correct when:
* The site is calm and readable
* Typography does most of the branding work
* Beer names feel special without overpowering the UI
* Nothing feels loud, trendy, or forced
* Color is used intentionally and sparingly
* Whitespace creates rhythm and breathing room

**When in doubt, remove visual elements rather than add them.**

---

## Updating This Document
This document is the single source of truth for Deep Dive Brewing's web design system.

Any changes to:
* Colors
* Typography
* Spacing
* Animation rules

Must be documented here FIRST before implementation.

If a new beer color is introduced, add it to the Beer Color Palette section.
If a design pattern is questioned, refer back to the Core Design Principles and Success Criteria.

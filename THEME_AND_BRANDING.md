# Theme & Branding Instructions
## Deep Dive Brewing Co Website

> Release baseline: **1.01** (`1.0.1`)
> Project state: **Shelved / maintenance mode**

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
Typography is the primary brand expression through simplicity and restraint.

### Brand Typography

#### Primary Brand Font: Festival Budaya XXXI
Use ONLY for:
* Site name "Deep Dive Brewing Co." (homepage hero and navigation logo)
* Nowhere else

**Sizes:**
* Homepage hero: 56px / 64px line-height (desktop), 40px / 48px (mobile)
* Navigation logo: 24px / 28px line-height

---

### All Other Typography: Inter

Inter is used for **everything else** on the site:
* All headings (H1, H2, H3, H4, H5, H6)
* All body text
* Navigation links
* Buttons
* Beer names
* Beer descriptions
* Form labels
* Footer content
* Metadata

**Sizes:**
* H1 (Page titles): 40px / 48px line-height (desktop), 32px / 40px (mobile)
* H2 (Section headings): 32px / 40px line-height (desktop), 28px / 36px (mobile)
* H3 (Subsections): 24px / 32px line-height (desktop), 20px / 28px (mobile)
* H4 (Minor headings): 20px / 28px line-height
* Body (default): 18px / 28px line-height (desktop), 16px / 24px (mobile)
* Small text: 14px / 20px line-height
* Caption/metadata: 12px / 18px line-height

**Font weights:**
* Regular (400): Body text, general content
* Medium (500): Navigation, subtle emphasis
* Semibold (600): Headings, buttons, strong emphasis
* Bold (700): Beer names, important headings

**Special Typography Rules:**
* Beer names use **Inter Bold** at larger sizes (32-48px) to make them feel special
* Beer style labels (IPA, Lager, Stout) use **Inter Semibold, uppercase, letter-spacing: 0.05em** at 12px
* ABV/IBU specs use **Inter Medium** at 12-14px

---

### Typography Philosophy

**Simplicity is sophistication.**

By using only two fonts (Festival for branding, Inter for everything else), the site:
* Feels cohesive and intentional
* Loads faster (fewer font files)
* Lets content and imagery do the branding work
* Avoids typographic clutter

**Inter handles all the heavy lifting** through weight variation (Regular, Medium, Semibold, Bold) and size hierarchy, not through font changes.

---

## Beer Image Assets

All beer imagery is stored in Firebase Storage and follows a consistent naming convention.

### Firebase Storage Structure

```
gs://deepdivebrewing-web.firebasestorage.app/beers/
├── pilsner/
│   ├── pilsner_card_1200x1500.jpg      (for beer listing cards)
│   └── pilsner_hero_1920x1080.jpg      (for beer detail page hero)
├── neipa/
│   ├── neipa_card_1200x1500.jpg
│   └── neipa_hero_1920x1080.jpg
├── american-amber/
│   ├── american-amber_card_1200x1500.jpg
│   └── american-amber_hero_1920x1080.jpg
├── pale-lager/
│   ├── pale-lager_card_1200x1500.jpg
│   └── pale-lager_hero_1920x1080.jpg
├── double-ipa/
│   ├── double-ipa_card_1200x1500.jpg
│   └── double-ipa_hero_1920x1080.jpg
├── stout/
│   ├── stout_card_1200x1500.jpg
│   └── stout_hero_1920x1080.jpg
├── belgian-ipa/
│   ├── belgian-ipa_card_1200x1500.jpg
│   └── belgian-ipa_hero_1920x1080.jpg
└── dutch-kuit/
    ├── dutch-kuit_card_1200x1500.jpg
    └── dutch-kuit_hero_1920x1080.jpg
```

### Image Specifications

#### Card Images (`*_card_1200x1500.jpg`)
* **Dimensions**: 1200px wide × 1500px tall (4:5 aspect ratio)
* **Purpose**: Beer listing cards on homepage and beer list pages
* **Format**: JPG, optimized for web
* **File size target**: Under 200KB
* **Aspect ratio**: Portrait orientation matches can labels

#### Hero Images (`*_hero_1920x1080.jpg`)
* **Dimensions**: 1920px wide × 1080px tall (16:9 aspect ratio)
* **Purpose**: Full-width hero image on individual beer detail pages (e.g., `/beers/neipa`)
* **Format**: JPG, optimized for web
* **File size target**: Under 400KB
* **Behavior**: Grows with screen width, maintains aspect ratio
* **Responsive**: Will be served at different sizes based on viewport

### Naming Convention

All beer image filenames follow this pattern:
```
{beer-slug}_{image-type}_{dimensions}.jpg
```

**Examples:**
* `neipa_card_1200x1500.jpg`
* `neipa_hero_1920x1080.jpg`
* `american-amber_card_1200x1500.jpg`
* `american-amber_hero_1920x1080.jpg`

**Rules:**
* Use lowercase
* Use hyphens for multi-word beer names (e.g., `american-amber`, `double-ipa`, `dutch-kuit`)
* No spaces in filenames
* Consistent dimensions in filename for clarity

### Usage in Code

```typescript
// Example: Fetching beer card image from Firebase Storage
const cardImageUrl = `gs://deepdivebrewing-web.firebasestorage.app/beers/${beerSlug}/${beerSlug}_card_1200x1500.jpg`;

// Example: Fetching beer hero image for detail page
const heroImageUrl = `gs://deepdivebrewing-web.firebasestorage.app/beers/${beerSlug}/${beerSlug}_hero_1920x1080.jpg`;
```

### Image Optimization Notes

* All images should be optimized before upload using tools like ImageOptim, TinyPNG, or similar
* Card images are portrait to match can label aesthetic
* Hero images are landscape to work well in full-width page headers
* Both formats use actual can photography for authenticity
* Hero images should be cropped to showcase the can label while allowing for responsive width scaling

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
* Scroll-triggered reveals: Simple fade-in (600ms ease)

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
```javascript
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
* Image asset structure

Must be documented here FIRST before implementation.

If a new beer color is introduced, add it to the Beer Color Palette section.
If a new image format is needed, document it in the Beer Image Assets section.
If a design pattern is questioned, refer back to the Core Design Principles and Success Criteria.

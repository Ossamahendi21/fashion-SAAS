# Fitcheck design direction

Fitcheck is a personal wardrobe and styling studio, not an administration dashboard. The signed-in app uses a horizontal wordmark/navigation bar, a quiet off-white canvas (near-black in dark mode), strong tightly spaced typography, garment cutouts and full-length photographs. Design reference: Renson Gerald's AI Wardrobe Stylist case study on Dribbble. Borrow hierarchy and focus on clothes; do not reuse reference artwork or sustainability features.

- Use existing neutral semantic tokens. Clothing supplies colour. Status colours retain their meaning.
- Page headings: 34px mobile / 44px desktop, medium weight, -0.055em tracking. Section captions: 10px uppercase mono, 0.16em tracking. Main content: up to 1520px including 16/32/48px responsive gutters.
- Signature: viewfinder/check wordmark, fine divider lines, editorial captions, large garment imagery. Avoid decorative gradients, generic metric cards and repeated icon circles.
- Organize around tasks. Upload controls sit alongside scans. Saved outfits show a large selected render on the left and an always-visible compact grid of pieces/settings on the right; thumbnails switch the main image. Keep important controls above the fold. A styling brief and real wardrobe imagery share the studio screen. Settings are grouped by purpose with clear section navigation.
- One primary action per step. Secondary links stay quiet. Do not fill empty space with decorative cards or fake stats/content. Empty states explain the next useful step.
- Use shadcn/Base UI for accessible interaction primitives; customize composition. Never edit generated primitives for visual styling.
- Keep render images at 2:3 with object-contain: hair, feet and proportions must remain visible.
- Keep real loading, pending, partial, failure and completion states. Mobile layouts stack in task order with no page overflow. Respect reduced motion. Keyboard actions must remain accessible.

The horizontal shell intentionally supersedes the sidebar layout in the original PLAN.md; the current PLAN.md documents this shell, the global stylist and the scan/selection/import contract.

## Public landing page

The landing page has its own fashion editorial composition: Manrope display type, outlined headline accents, a layered campaign collage, a scroll-driven three-chapter wardrobe story, an interactive style study, open pricing columns and an oversized wordmark footer. Scope these styles to the landing page; the signed-in studio keeps its existing typography and functional density.

The user explicitly requested parallax. The public page therefore uses Motion scroll transforms and a native CSS sticky story, an intentional exception to the app's short layout-only motion convention. Never intercept wheel/touch scrolling. Mobile, short viewports and reduced-motion preferences get a normal stacked story with no extended sticky scrolling. All essential text and signup links remain visible without entrance-animation delays.

Campaign photos in `public/landing/` depict generated fictional adults. They are style inspiration, not customer results or private user uploads. Label illustrative previews accordingly. Use optimized Next Images and shared plan/credit constants; do not invent testimonials or usage metrics.

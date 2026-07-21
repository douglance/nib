# Nib native design rules

Build every native screen as a premium utility, not a dashboard.

## Visual thesis

Nib should feel like a crafted object: quiet, precise, trustworthy, tactile,
and useful. It should look like something a discerning person keeps open on
purpose.

## Palette

- Background: desktop graphite (`#101010`) across iPhone and Watch.
- Text: desktop soft white (`#f2f2f2`) with `#cccccc` secondary text.
- Surfaces: `#181818` and translucent `#2c2c2c`, with thin white hairlines.
- Accents: desktop blue (`#0078d4`), green (`#2e7d32`), and red (`#c62828`).
- Reserve semantic color for focus and decisions; avoid gradients.

## Typography

- Use system-native SF typography.
- Favor sentence case.
- Use scale and spacing for hierarchy, not all-caps labels.
- Keep lines short, calm, and direct.

## Layout

- One main decision per screen.
- Use generous margins and vertical rhythm.
- Use large, composed request surfaces instead of dense lists where possible.
- Avoid nested cards. A card is a display surface for one request or one detail.

## Components

- Buttons should be rounded, confident, and quiet.
- Primary actions can use dark fills with subtle highlights.
- Secondary actions should be low-contrast but clear.
- Icons should be minimal line icons, used only when they clarify.
- Motion should be smooth and restrained. No bounce or novelty effects.

## Request detail

The request detail screen is the core object. It should show:

- title and prompt
- essential context only
- choices as calm, full-width action rows
- text reply as a focused input surface
- screenshots and photos as product-photo-like objects
- website open action with native polish

Do not make the screen feel like a ticketing system.

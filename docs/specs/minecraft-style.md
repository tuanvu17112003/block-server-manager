# Spec — Minecraft-look reskin (mc-style-001)

Source: mc-style-001-R research. Scope: FULL look, whole app (shell + 7 tabs + global Create), pure CSS only, pixel font headings-only. Stack: Tailwind React (`src/**` only, no new deps except `@fontsource/press-start-2p` OFL-1.1).

## IP red lines (binding)
- NEVER: Minecraft/Mojang logos, game textures/sounds/fonts, splash lines, panoramas, "Minecraft" as app title.
- Allowed: original CSS + OFL pixel font + community-inspired hexes. App must carry footer/about line: `NOT AN OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT.` Refer to game only descriptively ("servers for Minecraft™").
- All hexes below are inspired-by (fan-wiki eyedrops), never "Minecraft texture colors".

## Palette (inspired-by)
- Stone light `#C6C6C6` panel/slot face; slot mid `#8B8B8B`; text gray `#555555`; bevel dark `#373737`; near-black `#212121` wells, `#121212` console bg.
- Grass `#7CBD6B`, leaves `#48B518`, chat green `#55FF55`, dark green `#00AA00`, XP lime `#80C71F` (use for XP-style bars, NOT unverified `#7EFC20`).
- Gold `#FFAA00`, splash yellow `#FFFF55` (accents only, check contrast); red `#FF5555`, dark red `#AA0000` (EULA/destructive).
- Dirt browns `#5D4037`/`#7C4B2A`, stone gray `#9E9E9E`, sky `#4FC3F7` (links/info only), creeper greens `#0F800F`/`#0DB50D`.
- Contrast: normal text ≥4.5:1 on dark; pixel headings ≥3:1 (prefer 4.5:1, pixel fonts render thin small).

## Font
- Press Start 2P (OFL-1.1, `@fontsource/press-start-2p`, weight 400) for: app title, CardTitle, tab labels (10-11px), chunky button labels, modal titles. Body/tables/console stay system sans/mono. Do NOT use Monocraft (IP optics + mono misuse risk).

## Signature CSS recipes (pure CSS)
- Chunky button: 2px black outer border + inner bevel `box-shadow: inset 2px 2px 0 <light>, inset -2px -2px 0 <dark>`; sharp corners (0-2px radius); hard `text-shadow: 2px 2px 0 #000` on labels; hover = tint overlay + `#FFFFA0`-ish text; press = invert bevel (inset only, NO size/border change); disabled = desaturated + `cursor-not-allowed` + keeps readable + explains why (EULA tooltip pattern); focus-visible = 2px yellow outline offset 2px.
- Panels: 2px black border + bevel shadows (replace `rounded-lg border-zinc-800`); sidebar dirt-dark `#2A1D12`-range + `repeating-linear-gradient` grain; server rows = stone slots, active = 2px grass-green inset ring; StatusDot = square 8px + 1px black border.
- Tabs: unselected dark stone top-bevel; selected light stone face + 3px green underline; pixel labels.
- Tables: `#212121` header pixel 10px; zebra `#1D1D21`/`#2A2A2A`; 1px `#555555` grid; selected row 4px green left border.
- Console: NO pixel font — mono 12-13px `#E0E0E0` on `#121212`; levels green/red/gold per chat codes; thin scrollbar thumb `#555555`.
- Bars: 6px, 2px black border, `#212121` well, `#80C71F` fill + lighter top highlight; square stone slider thumb.
- Modals: stone panel + black border + `box-shadow: 4px 4px 0 #000`; scrim black/70; toasts green/red/stone with 2px borders.
- Splash-style tag (Create wizard "NEW"): original text only, yellow + hard shadow, rotated ~-12deg, subtle pulse. Never copied splash lines.

## Per-area notes
Sidebar dirt + slots; header title pixel 12-14px + EULA `dark_red` solid banner; TabBar java-tab look; Overview/Metrics header strip grass-green; Worlds/Backups inventory slots (`#C6C6C6` face, `#373737` wells); Create edition cards as large selectable slots; Settings keep 7-field subset + cracked warn readable.

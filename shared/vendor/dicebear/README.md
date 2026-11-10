# DiceBear Glyphs

`glyphs.json` is the Glyphs definition from `@dicebear/styles` **10.6.0**
(`dist/glyphs.min.json`, exported as `@dicebear/styles/glyphs.json`). Its content
is unchanged; repository formatting may change whitespace.

- Artist: **Matt Houser** — https://x.com/mattkhouser
- Original artwork: [Abstract Avatars for All Creative Profile Use](https://www.figma.com/community/file/1249154526125777853)
- Definition source: https://github.com/dicebear/styles/blob/main/src/glyphs.json
- License: **Creative Commons Attribution 4.0 International (CC BY 4.0)** —
  https://creativecommons.org/licenses/by/4.0/
- Upstream attribution: `@dicebear/styles` 10.6.0 `LICENSE.md`, “Glyphs”.

Both the web avatar and Swift path generator consume this file. The web renderer
replaces the white base with the theme surface and scopes SVG IDs; the Swift
generator converts paths into drawing instructions. These adaptations retain
Matt Houser's attribution. The separate DiceBear core renderer remains a dependency.

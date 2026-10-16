# Workspace visual references

Reviewed on October 14, 2026. Reference images are research material, not shipped product assets.

- [OpenAI, Introducing the Codex app](https://openai.com/index/introducing-the-codex-app/): project-grouped conversations, restrained native sidebar, message hierarchy, composer and optional review panel. Official page was read; its asset download returned HTTP 403. `references/codex.png` is a screenshot of the official product page [republished by Zun-Beho](https://note.com/akikito/n/nf91346061592), downloaded and visually reviewed. Only the product interface was used as reference; the promotional gradient was deliberately excluded.
- [Vercel, New dashboard redesign is now the default](https://vercel.com/changelog/dashboard-navigation-redesign-rollout): `references/vercel.png` is the actual light dashboard screenshot downloaded from Vercel's official image CDN and visually reviewed. Reference: quiet neutral navigation, concise labels and clear active selection.
- [Things by Cultured Code](https://culturedcode.com/things/): `references/things-native.png`, downloaded and reviewed by the native implementation lead. Reference: semantic grouping, quiet sidebar, proportion and alignment.
- [Linear, Mobile app redesign](https://linear.app/changelog/2025-10-16-mobile-app-redesign): `references/linear-mobile.png`, downloaded and reviewed by the native implementation lead. Reference: compact mobile navigation and task hierarchy; its marketing photograph was less relevant than the product screenshots.

## Design plan and review

Palette: white canvas #ffffff, navigator #f7f7f8, selection #e9e9ec, ink #202123, secondary #777980, divider #e7e7e9. Type: platform system UI for native continuity; monospaced text only for code and commands. Conversation: 14px body, 1.75 line height, 720px maximum width. Shell: 240px repository/task rail, flexible conversation, optional 340px inspector. Mobile uses an explicit toggle for the project rail and an overlaid inspector.

The first review rejected a three-column permanent inspector and bordered task cards: both overemphasized infrastructure and reduced conversation space. The implemented layout centers the real working conversation, reserves rounded surfaces for user messages/composer, uses unbordered navigation, and reveals detailed check output on demand. No decorative metrics, gradient or invented product controls were added.

## Codex hierarchy refinement

The second pass follows the user's explicit Codex benchmark: a global New task action, independent tasks in the top-level Tasks section, and collapsible project folders containing their own conversations. Project membership is optional data, not a visual filter. Project creation is a secondary dialog; task creation uses the main composer with No project and computer context.

Palette remains paper #FFFFFF, rail #F8F8F8, selection #E9E9EB, ink #242529, secondary #767880 and divider #E8E8EB. System UI type connects web and native clients. The 264px navigator gives nested tasks room; the 740px conversation aligns with the composer. Desktop chrome is a single 62px row with task title and quiet project context. Navigation metadata uses recency, with colored dots only for active work or attention.

The design review removed the earlier separate project selector and global task dump, sidebar creation fields, repeated computer inventory, promotional empty-state text, and raw execution event names in the conversation. The initial task composer now makes projectless work a first-class path.

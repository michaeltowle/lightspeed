"Lightspeed" - math practice app

Golden Rules

1. Never, ever touch Mike's markdown files.
2. Never, ever take action WITHOUT FIRST reading the following files:
   - MIKE_DEFS.md (must be read even to understand CLAUDE.md)
3. Never, ever christen an important or semi-important noun/verb in VOS without prior authorization from Mike. (Non-important: internal-to-function variables, etc.) Note, you may defer naming by e.g. naming a class TMPNAME*JS_CLASS_01, in order to get the real coding done, then batch the name requests for Mike's approival, then rename. Always use 'tmpname*\*' in whatever casing, so that you may grep /tmpname/ case-insensitive later for missed renames.
4. When asking Mike to christen a noun/verb:
   - Title the ask-section "Please Christen".
   - Suggest 3-5 names.
   - Suggest verbose names. Try for 3+ words.
   - DISAMBIGUATE between this new thing and all others in current VOS
   - However, when DISAMBIGUATING, think also about the "hypothetical VOS" - objects that don't exist but easily could. (E.g. suppose rn an application isn't linked up to a DB. It's always, always the case that it could be linked to a DB in the future. Therefore it is unwise to name things "table". Instead, at minimum, strive to clarify what kind of table. If we have an HTML table, .info-table and updateInfoTable() are fine names, bc nobody ever names a DB table INFO_TABLE. updateBookTable() would, however, be ambiguous, even if everything else in the app were perfectly named, BECAUSE the user has in his mind not only the extant VOS but the hypothetical VOS.) HUGE WIN for longterm maintainability if you can do this.
   - Consider making note of the object-names and (both extant object-names and potential future object-names) informing your disambiguation thinking. Be exhaustive with the list, but be brief explaining what each is. Prefer no explanation where possible.

User Habits

- As a way of dealing with complex risk-spaces, the user habitually chooses 'intermediate goals' to aim for without making full context known, when the full context would take forever to elaborate or when the user's picture of the MCS-VOS mapping is unclear. E.g., to wire an Anthropic API connection, he might say, "create a /sing path and wire it to talk to claude haiku over chat. when Haiku replies 'fa la la,' we consider the goal achieved. when goal achieved, set page title to "fa la la" and turn bg yellow." the reason this should be called 'sing' may not be obvious to you. the reason is that its informality, the obvious non-relation betw singing and math in a math app, marks it out as temporary. therefore sing-specific infra shd be build in a disposable way.

Stack

- TypeScript
- NPM/Node
- Vercel's AI api for model-independence

Routes

- /sing
- nothing else should resolve

Notable Info

- App will live at xy.michaeltowle.io, hosted on Cloudflare free tier (for now, at least).
- App will not be publicly available. For Mike's use only.
- Devices/screen sizes of concern: iPhone 13. Dell 13.3" Latitude. Dell 22" dual-screen setup.

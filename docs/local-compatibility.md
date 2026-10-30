# Native-base deployment

The interface starts from official OpenMausBot v0.1.134, commit
`0213b7435fc83a936f77c18475ba2a0d7b7c2de4`. The previous custom Sidebar,
organization navigation, ProjectsPanel, broad stylesheet overrides and patched
compiled assets are not part of this interface.

The retained source overlay contains account and thread isolation, attachment
visibility, model fallback and context settings, group member models, voice
controls and Gemini Live, and the existing company data/API. The company board
is served separately at `/company`, with a link in the web chat menu for an
owner/admin. Its permission boundary is unchanged: it does not grant tool
permissions or turn an accepted task into an execution.

## Interface exceptions

- `ChatMarkdown`: a Persian sentence beginning with an English product name
  uses RTL; English prose containing an occasional Persian word remains LTR.
- `ChatView`, `GroupView`, and `compat-layout.css`: mobile assistant replies,
  including the inner blocks around tables, use the available message width.
- `RichTable`: its expanded dialog occupies the viewport and its scrolling
  body fills the space below the controls. Native search, sort, CSV, focus
  containment and Escape behavior remain available.
- Voice components and their transport retain the earlier pause/resume,
  playback rate, download and Gemini integration. Gemini credentials use the
  server configuration API; this web deployment does not add an unsupported
  Electron credential IPC slot.

Project tools are advertised only for a matching project turn. The server
continues to scope each call independently of the advertised catalog.

## Updating

Keep official source and local changes in Git. Build an independent release
directory; do not edit the installed minified JS or replace the live service
while investigating a new release. An overlay applicability check is only a
syntax/anchor gate, not proof of semantic compatibility with a newer version.

For each upgrade:

1. Fetch and pin the official tag, commit and registry integrity.
2. Apply or rebase the retained overlay in an isolated checkout. Review any
   changed upstream contract; never resolve a conflict by choosing a whole
   old file automatically.
3. Run type checks, affected unit tests, account/thread isolation tests and
   isolated conversation fixtures. Exercise per-member models and multiple
   responders; a stored model name is not execution evidence.
4. Build the frontend and server; validate the referenced asset graph and
   run the packaged-server smoke test outside the source tree.
5. Read a private copy of real data with the new readers. Check identities,
   thread links, model selections, provider configuration and company data.
   Do not start automations or send messages from that copy.
6. Check the affected real subscription engines with bounded tool-free
   connection checks. Test the browser with a new disposable profile and a
   local fixture, including form input and the interactive relay.
7. Inspect the actual UI at phone, tablet and desktop widths. Keep a tested
   backup and rollback path before changing the live service command.
8. Wait for active work to settle, take a consistent private snapshot, switch
   the service to the new pinned release, then verify health, assets, account
   status and the user's actual UI. Restore the prior command if those fail.

An in-app or global npm upgrade alone does not carry this overlay. The live
service must point to a qualified release directory, so installing another
package cannot silently replace the running customized build.

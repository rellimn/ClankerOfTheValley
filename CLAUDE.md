# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

PhantomBot — a Twitch chat bot written in Java that hosts a Mozilla Rhino JavaScript engine. Java provides the runtime (event bus, HTTP/WS server, Twitch/Discord/EventSub clients, DataStore, panel WS, command dispatcher); the user-facing bot behavior (commands, games, handlers, panel pages) is implemented in JavaScript modules that are auto-loaded at boot and can be hot-reloaded from chat.

There is no `package.json`, no Node — every JS file runs under Rhino on the JVM with access to `Packages.*` for Java interop. Treat `javascript-source/` as scripts hosted by the Java app, not a standalone JS project.

## Build & run

Build is Apache **Ant** (`build.xml`) with **Apache Ivy** for dependency resolution. Java source level is fixed at **17**. There is no Maven/Gradle.

Common commands (from repo root, requires `ant` on PATH):

```
ant ivy-retrieve         # download dependencies into lib/ and lib.extra/
ant jar                  # compile + jar + stage dist/PhantomBot-custom/
ant test                 # strict-warning compile (the CI "test" — there is no JUnit suite)
ant run                  # build + launch the bot from dist/
ant dist                 # build + zip into dist/PhantomBot-custom.zip
ant clean / distclean    # wipe build/ (and dist/ for distclean)
ant javadoc              # generate dist/javadoc/
```

Dev container / Linux shortcut (`Makefile`): `make build`, `make run`, `make rebuild`, `make kill`. These wrap the Ant targets and assume the bundled `java-runtime-linux` JRE.

The CI workflow (`.github/workflows/ci.yml`) runs only `ant test` plus a Docker build. **There is no unit-test suite to run a single test from.** "Verifying a change" in this codebase means: build the jar, launch it, exercise the feature in chat or via the panel at `http://localhost:25000`.

The Ant `pre.compile` target rewrites `source/tv/phantombot/RepoVersion.java` and `source/com/gmt2001/RollbarProvider.java` with build-time values; `post.compile` restores the templated placeholders. **Expect those two files to show as modified mid-build** — don't commit the modified versions; an interrupted build can leave them dirty.

## Architecture

Two halves wired together via the event bus:

**Java host (`source/`)** — entry point `tv.phantombot.PhantomBot#main`. Key areas:

- `tv/phantombot/event/` — every Java event class corresponds 1:1 to a `$.bind('name', ...)` hook on the JS side (class name minus `Event` suffix, lower-camelCased). Adding a new bindable event = adding a Java event class here.
- `tv/phantombot/script/` — Rhino integration: script loader, `$` global construction, the `@ExposePropertyToScripts` mechanism that surfaces Java objects to JS.
- `tv/phantombot/cache/` — long-lived API result caches (followers, subscribers, emotes, etc.).
- `tv/phantombot/twitch/` — Twitch IRC/Helix/EventSub clients.
- `tv/phantombot/discord/` — Discord4J integration.
- `tv/phantombot/httpserver/` — embedded Netty HTTPS server (port 25000): static panel, `/addons/*` public files, `/ws/alertspolls` unauth WS, authenticated panel WS.
- `tv/phantombot/panel/` — panel WS server, custom-manifest validation, panel-user permissions.
- `com/gmt2001/` — DataStore backends (H2/SQLite/MySQL/MariaDB), `HttpRequest`, `PathValidator` (filesystem allowlist), Rollbar provider, logging.
- `com/illusionaryone/`, `com/scaniatv/` — contributed APIs, `CustomAPI` HTTP wrapper.

**JavaScript modules (`javascript-source/`)** — loaded recursively at boot in order:
`core/bootstrap` → `core` → `commands`, `games`, `handlers`, `systems`, `custom` → `discord/`. Top-level code in a script runs at load time; everything else runs from `$.bind(...)` callbacks dispatched by the Java event bus.

- `core/` — always-on infrastructure: `commandRegister.js`, `permissions.js`, `lang.js`, `misc.js` (typed `$.getSetIniDb*` wrappers), `customScripts.js` (the `!reloadcustom` hot-reloader).
- `systems/` — long-running subsystems that export APIs on `$` for other modules (`$.points.*`, `$.subscription.*`, etc.).
- `handlers/`, `commands/`, `games/` — feature modules.
- `custom/` — user/operator-installed modules (do not put project-owned code here; it's the user's slot and is the default mount point in Docker).
- `lang/` — translation files; `lang/custom/` loads last and overrides everything.

**Concurrency model** — Rhino is single-threaded per context but the Java event bus dispatches on a thread pool. Two `command` events for the same module can run concurrently; shared in-memory JS state mutated from multiple handlers needs a `Packages.java.util.concurrent.locks.ReentrantLock`. Pure `$.inidb` writes are already atomic — don't add a JS lock around them.

**Inter-module communication** — preferred order: (1) functions exported onto `$` at the bottom of an IIFE, (2) shared `$.inidb` tables as schema-as-API, (3) Java EventBus for one-to-many broadcasts (limited to existing Java event classes — there's no facility to define a JS-only event), (4) panel WebSocket for panel↔script.

## Transformers (command-tag expanders)

"Transformer" in this codebase is **not** an ML model and **not** the GoF design pattern. It's PhantomBot's name for a function that expands a `(tagName argsep args)` placeholder inside a user-authored template string — the things stream operators write into custom commands (`!addcom !lucky Your lucky number is (#)`), sub/resub/gift messages, welcome greetings, keyword replies, channel-point redemption text, etc.

**Engine:** `javascript-source/core/commandTags.js` (exported as `$.transformers`, with legacy aliases `$.tags`, `$.escapeTags`, `$.addTagTransformer`).

**Built-in transformers:** 15 files in `javascript-source/core/transformers/`, grouped by domain — `user.js`, `points.js`, `time.js`, `math.js`, `customapi.js`, `discord.js`, `channelstream.js`, `channelpoints.js`, `commands.js`, `teams.js`, `alerts.js`, `meta.js`, `file.js`, `basic.js`, `misc.js`. Each file registers its tags by constructing `new $.transformers.transformer(tag, labels, fn)` and calling `$.transformers.addTransformer(...)`.

**Tag grammar** (the `tagPattern` regex in `commandTags.js`):

```
(tagName argsep args)
```

`argsep` is one of space, `!`, `=`, `|`, `>` (with optional `>` and `!` modifiers — see `buildArgs` in `core/transformers/user.js` for the full matrix of `(1)`, `(1>)`, `(1!)`, `(1=tag)`, `(1|default)` and combinations). `\(` and `\)` escape literal parens. Unmatched tags are escaped and left intact in the output.

**Transformer return contract** — every transformer function returns `{result, cancel, raw, cache}`:

| Key | Default | Meaning |
|---|---|---|
| `result` | `''` | What the tag is replaced with |
| `cancel` | `false` | Abort the whole expansion pass and return `null` to the caller (used to suppress the message entirely on error) |
| `raw` | `false` | When `false`, `result` is escaped before substitution so any `(...)` it contains isn't re-processed; when `true`, nested tags expand |
| `cache` | `false` | When `true`, identical occurrences of the tag in the same input reuse the value (cache is per-message, cleared after) |

Returning `undefined` (or nothing) means the tag didn't match and the next transformer / the local-vs-global pathway can try.

**Labels** are how the engine decides which transformers are available in which call site. Three axes:

- Platform — `twitch`, `discord`
- Event — `commandevent` (requires a `CommandEvent`), `noevent` (callable without an event), `keywordevent`, `customapi`, etc.
- Category — `user`, `points`, `basic`, `math`, `time`, ... (mostly informational)

`$.transformers.tags(event, message, globalRequiredLabels, opts)` takes a **required** label set (transformer must have all) and an optional **any** label set (must have at least one). A sub-array inside the required set is an OR group — the default `['twitch', ['commandevent', 'noevent']]` means "twitch AND (commandevent OR noevent)". This is what restricts e.g. `(1)` (needs a CommandEvent) from firing in a welcome message.

**Local transformers** are passed via `opts.localTransformers = {tagname: fn, ...}` and are checked **before** the global registry — they win on name collision. Use them for context-specific tags that only make sense inside one feature: `subscribeHandler.js` defines `reward`, `name`, `plan`, `giftmonths`, etc. inline and passes them in alongside `customArgs: {reward: 100}` so the local `reward` function can return the actual number. Local transformers don't go through label filtering — they're trusted by the caller.

**`$.transformers` public API:**

```javascript
$.transformers.transformer(tag, labels, fn)        // constructor
$.transformers.addTransformer(t)
$.transformers.addTransformers([t1, t2, ...])
$.transformers.tags(event, msg, requiredLabels, { globalTransformerAnyLabels, localTransformers, customArgs, atEnabled, platform })
$.transformers.getTransformer(tag)
$.transformers.getTransformers()
$.transformers.getTransformersWithLabel(label)
$.transformers.getTransformersWithAllLabels([...])
$.transformers.getTransformersWithAnyLabel([...])
$.transformers.escapeTags(s) / unescapeTags(s) / stripTrailingEscape(s)
```

**`atEnabled`** — when no tag matched, the sender is a mod, and the command was called with at least one argument, the engine prepends `arg0 -> ` to the output. This is the `!addcom`-style "redirect to user" behavior; opt in by passing `atEnabled: true`.

**Doc generation** — `development-resources/parse_transformers.py` parses the `@transformer` / `@localtransformer` JSDoc blocks above each function and writes `docs/guides/content/commands/command-variables.md`. The grammar at the top of `parse_transformers.py` is the spec; the most important tags are `@formula (...) description`, `@labels ...`, `@example ...`, `@raw`, `@cached`, `@cancels`, `@customarg`. If you add a transformer, the doc block is mandatory — it's the *only* user-facing reference. Modules that **call** `$.transformers.tags` annotate the binding with `@usestransformers global local twitch noevent` so the docs page can show "this event supports these tags."

**Call sites worth knowing:** `commands/customCommands.js` (drives `!addcom`), `discord/commands/customCommands.js`, `systems/welcomeSystem.js`, `systems/greetingSystem.js`, `handlers/subscribeHandler.js` (sub/resub/gift/massgift, with type-conditional local transformer sets), `handlers/keywordHandler.js`, `handlers/channelPointsHandler.js`. Anywhere a feature lets the operator template the bot's response, it routes through `$.transformers.tags`.

**When writing a new transformer:**

1. Pick the right file in `javascript-source/core/transformers/` by domain, or define it locally if it only makes sense in one handler.
2. Use the `@transformer`/`@formula`/`@labels`/`@example` doc block — it's load-bearing for the published docs.
3. Choose labels honestly: `commandevent` if you read `args.event.getArgs()`, `noevent` if the tag works without an event, both platforms if it does, otherwise just `twitch` or `discord`.
4. Set `cache: true` for any pure function of the inputs (the engine de-duplicates work within one message). Set `raw: true` only when you intentionally want nested-tag processing on the output.
5. Set `cancel: true` to swallow the whole output on a fatal error (mirroring how `customapi` aborts on missing required `$1`–`$9` substitutions).

## Custom-module development

A thorough working reference for the Rhino runtime, event hooks, command registration, the panel `manifest.json` schema, the file-path allowlist, and the OBS overlay pattern lives at `docs/claude/phantombot-module-development-reference.md`. **Read it before writing or reviewing JS in `javascript-source/custom/` or anything that touches the panel.** It captures behavior that isn't obvious from grepping (e.g. `!reloadcustom` only re-fires `initReady` on newly loaded modules; the `registerChatCommand` script-path string must exactly match the file's path relative to `scripts/`).

## Documentation generation

The public docs under `docs/guides/content/` are **generated** from custom JSDoc tags in source by five standalone Python scripts in `development-resources/`. Each script walks a source tree, parses block comments with a small state machine, and overwrites a single target Markdown file. They take no arguments, use stdlib only (Python 3), and **must be run from the repo root** (paths like `./javascript-source` are hard-coded).

| Script | Tags it consumes | Source tree | Output |
|---|---|---|---|
| `parse_transformers.py` | `@transformer`, `@localtransformer`, `@category`, `@formula`, `@labels`, `@customarg`, `@notes`, `@example`, `@raw`, `@cached`, `@cancels`, `@usestransformers` (+ following `$.bind`/`@bind` to attach hooks) | `./javascript-source` | `docs/guides/content/commands/command-variables.md` |
| `parse_twitchcommands.py` | `@commandpath cmd [req] (opt) - desc` | `./javascript-source` | `docs/guides/content/commands/commands.md` |
| `parse_discordcommands.py` | `@discordcommandpath ...` | `./javascript-source` | `docs/guides/content/commands/discord-commands.md` |
| `parse_consolecommands.py` | `@consolecommand ...` | `./javascript-source` | `docs/guides/content/commands/console-commands.md` |
| `parse_botproperties.py` | `@botproperty`, `@botpropertycatsort`, `@botpropertyrestart`, `@botpropertytype` | `./source` (Java) | `docs/guides/content/setupbot/bot-properties.md` |

Run after editing any of those tag types:

```
python development-resources/parse_transformers.py
python development-resources/parse_twitchcommands.py
python development-resources/parse_discordcommands.py
python development-resources/parse_consolecommands.py
python development-resources/parse_botproperties.py
```

The grammar comment at the top of each parser **is the spec** — when adding a new tag form, mirror what the parser already accepts (`@formula`, `@notes`, `@example` allow multi-line bodies; everything else is single-line). `parse_transformers.py` is the most elaborate: states 0–8, with `@notes` and `@example` accumulating until the next `@tag` or `*/`, and `@usestransformers` consuming the *next* `$.bind('name', ...)` or `@bind name` line to attach the hook. The other four parsers are essentially one-tag-per-comment.

The docs are not regenerated automatically — CI does not run these scripts. Re-run the matching parser after touching tagged code and commit the regenerated `.md` alongside the source change.

## Code style

From `development-resources/CODESTYLE.md` — what's worth remembering beyond what an autoformatter handles:

- **4-space indents, no tabs**, in both Java and JS.
- **Hugging braces, no inner padding:** `if (cond) {`, not `if ( cond ){` or brace-on-next-line.
- **Single quotes** for JS string literals.
- **JS modules are IIFE-wrapped:** `(function () { ... })();` — don't leak locals to `$` unless they're meant as exports.
- Java strings returned by event getters are `java.lang.String`, not JS strings — convert with `$.jsString(x)` and compare with `$.equalsIgnoreCase(a, b)` (not `===`) when the value crossed the Java/JS boundary.
- `@commandpath` JSDoc tags above command handlers are parsed by `development-resources/parse_twitchcommands.py` (Discord uses `@discordcommandpath`, console uses `@consolecommand`) for the docs site — keep the `@commandpath cmd subargs - description` format on a single line. See **Documentation generation** below for the full set of parsers.

## Things to avoid

- **Don't put project-owned modules in `javascript-source/custom/`, `scripts/lang/custom/`, or `scripts/discord/custom/`.** Those folders are the user's mount points and are bind-mounted out in Docker; anything you put there will be invisible in a Docker deployment.
- **Don't edit stock JS modules to add features** — bind to events from a new module instead. Upgrades will clobber edits.
- **Don't commit the build-time mutations** to `source/tv/phantombot/RepoVersion.java` or `source/com/gmt2001/RollbarProvider.java`.
- **Don't bypass `PathValidator`.** Script file ops are allowlisted to `./addons`, `./config/{audio-hooks,gif-alerts,clips,emotes}`, `./logs`, `./scripts`. Out-of-path writes silently no-op with a `Blocked X target outside of validPaths` log.

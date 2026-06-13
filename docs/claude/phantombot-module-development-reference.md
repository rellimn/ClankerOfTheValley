# PhantomBot Custom Module Development — Reference

A working reference for developing custom modules for PhantomBot. Distilled from the current `PhantomBot/PhantomBot` GitHub repo (master branch — `javascript-source/`, `source/`, and `docs/guides/`) and verified against the source. Not from the forum (which is outdated). Use this as background context when writing or modifying PhantomBot modules.

---

## 1. Runtime model

- **Language:** Mozilla Rhino JavaScript on the JVM. Not Node.js. No `require`, no npm, no DOM.
- **Threading:** Rhino itself is single-threaded *per script context*, but PhantomBot's Java event bus dispatches events (`command`, `ircModeration`, Twitch/EventSub events, panel WS, `setInterval`/`setTimeout` callbacks) on a **thread pool**. Two `command` events for the same module can run concurrently.
- **Java interop:** `Packages.java.util.concurrent.locks.ReentrantLock`, `Packages.tv.phantombot.event.EventBus`, etc. are reachable directly.
- **Global namespace:** Every script shares one `$` object. Modules attach exports at the bottom of their IIFE.
- **Strings:** Event getters often return Java strings, not JS strings. Use `$.jsString(x)` to convert and `$.equalsIgnoreCase(a, b)` instead of `===`.
- **Timers:** `setTimeout`, `setInterval`, `clearTimeout`, `clearInterval` are provided (`core/bootstrap/80jsTimers.js`).
- **IIFE wrapper:** Standard module shape is `(function () { ... })();`.

---

## 2. Directory layout

Paths are relative to the **install root** (the folder containing `scripts/`, `web/`, `config/`).

| Piece | Path | Required? |
|---|---|---|
| Twitch bot logic | `scripts/custom/**/*.js` | Always |
| Discord bot logic | `scripts/discord/custom/**/*.js` | Discord side only |
| Lang strings | `scripts/lang/custom/*` (`.js` or `.json`) | Optional |
| Panel manifest | `web/panel/custom/<moduleId>/manifest.json` | Only for panel UI |
| Panel page HTML | `web/panel/pages/custom/<moduleId>/<name>.html` | If `nav` entry references it |
| Panel page JS | `web/panel/js/pages/custom/<moduleId>/<name>.js` | Optional |
| Persistent files | `addons/<something>/...` | Optional (OBS overlays, exports) |

Do **not** put custom scripts in stock folders (`scripts/games/`, `scripts/systems/`, etc.) — those are overwritten on upgrade.

---

## 3. Module skeleton

```javascript
/**
 * myModule.js
 */
(function () {
    // Seed defaults (also makes them discoverable by the panel)
    var greeting = $.getSetIniDbString('mymodule_settings', 'greeting', 'Hello');

    /**
     * @event command
     */
    $.bind('command', function (event) {
        var sender = event.getSender().toLowerCase(),
            command = event.getCommand(),
            args = event.getArgs();

        /**
         * @commandpath mycmd - Says hello
         */
        if ($.equalsIgnoreCase(command, 'mycmd')) {
            if (args[0] !== undefined && $.equalsIgnoreCase(args[0], 'set')) {
                greeting = args.slice(1).join(' ');
                $.setIniDbString('mymodule_settings', 'greeting', greeting);
                $.say($.whisperPrefix(sender) + $.lang.get('mymodule.set.ok'));
                return;
            }
            $.say(greeting + ', ' + $.username.resolve(sender) + '!');
        }
    });

    /**
     * @event initReady
     */
    $.bind('initReady', function () {
        $.registerChatCommand('./custom/myModule.js', 'mycmd', $.PERMISSION.Viewer);
        $.registerChatSubcommand('mycmd', 'set', $.PERMISSION.Admin);
    });

    // Exports (optional)
    $.myModule = { setGreeting: function (s) { greeting = s; } };
})();
```

**Two non-negotiable rules:**

1. Register commands inside `$.bind('initReady', ...)`. `!reloadcustom` re-fires `initReady` on newly loaded modules so they register without a restart; commands registered elsewhere may never register on hot-load.
2. The script-path string in `registerChatCommand` must exactly match the file's path relative to `scripts/`, starting with `./` (e.g. `./custom/myModule.js`). Wrong path silently breaks the `!module` toggle and the dispatcher's enabled-check.

---

## 4. Lifecycle and module management

**Loading:** scripts are auto-loaded recursively at boot. Order: `core/bootstrap` → `core` → top-level dirs (including `custom/`) → Discord side. Top-level code runs at load time; code inside `$.bind` callbacks runs later.

**Hot-reload from chat (caster):**
```
!reloadcustom         Re-scan scripts/custom/ and scripts/lang/custom/; fire initReady on new modules
!reloadcustom silent  Same, no chat reply (panel uses this automatically after manifest load)
```

**Module enable/disable (admin):**
```
!module list
!module status ./custom/myModule.js
!module enable ./custom/myModule.js
!module disable ./custom/myModule.js
!module reload [path|all]
!module delete [path]      Removes DB entry only, not the file
```

Every loaded script is registered in the `modules` DB table and enabled by default. Disabled modules' event handlers are not called.

**Removing:** stop the bot, delete the files, start again.

---

## 5. Event system (`$.bind`)

```javascript
$.bind('eventName', function (event) { /* ... */ });
```

Event names come from Java event classes in `source/tv/phantombot/event/` — class name minus `Event` suffix, lower-camel-cased (`TwitchOnlineEvent` → `twitchOnline`). The callback receives the Java event object; call its getters.

**Common hooks (not exhaustive — check `source/tv/phantombot/event/` for the full list):**

| Hook | Fires when |
|---|---|
| `initReady` | Once after bot joins chat and all modules are loaded; re-fired per-module by `!reloadcustom` |
| `command` | Registered chat command used (after permission/cooldown checks) |
| `ircChannelMessage` | Any chat message |
| `ircModeration` | Pre-moderation pass on a message |
| `ircChannelJoin` / `ircChannelLeave` | Users joining/leaving chat |
| `ircPrivateMessage` | Whispers |
| `twitchOnline` / `twitchOffline` | Stream live/offline |
| `twitchFollow` | New follower |
| `twitchSubscriber`, `twitchReSubscriber`, `twitchPrimeSubscriber`, `twitchSubscriptionGift`, `twitchMassSubscriptionGifted`, ... | Subscription events |
| `twitchBits` | Cheers |
| `twitchRaid` | Incoming raid |
| `twitchClip` | New clip |
| `twitchGameChange` / `twitchTitleChange` | Category/title changes |
| `eventSub*` | Raw Twitch EventSub events |
| `webPanelSocketUpdate` / `webPanelSocketConnect` | Panel WS messages |
| `discordChannelMessage`, `discordChannelCommand`, `discordChannelJoin`, ... | Discord events |
| `streamLabsDonation`, `tipeeeStreamDonation`, `streamElementsDonation` | Donation integrations |
| `ytPlayer*` | YouTube player events |
| `emotesCacheUpdated` | Emote cache rebuilt (bus broadcast) |

There is **no facility to create a JS-only custom event** — every `$.bind` name resolves to a Java event class. For pure JS pub/sub, build a subscribe/publish pair on your own namespace.

---

## 6. Commands

### Registration (`core/commandRegister.js`)

```javascript
$.registerChatCommand(script, command, groupId, restriction);
$.registerChatSubcommand(command, subcommand, groupId, restriction);
$.registerChatAlias(alias, target, script);
$.unregisterChatCommand(command);
$.unregisterChatSubcommand(command, subcommand);
```

- `script` — path string, e.g. `./custom/myModule.js`.
- `command` — lowercase, no `!`.
- `groupId` — default permission; falls back to `Viewer` if omitted. User-configured permission overrides on subsequent loads.
- `restriction` — `-1` none (default), `1` online-only, `2` offline-only. Constants on `RESTRICTION` in `commandRegister.js`.

### Permission groups (`$.PERMISSION`)

Lower ID = more privileged. Use the constants, not bare numbers.

| Constant | ID |
|---|---|
| `Caster` | 0 |
| `Admin` | 1 |
| `Mod` | 2 |
| `Sub` | 3 (swaps with VIP if VIP-above-sub is configured) |
| `Donator` | 4 |
| `VIP` | 5 |
| `Regular` | 6 |
| `Viewer` | 7 |
| `Panel` | 30 (panel-only; never usable from chat) |
| `None` | 99 |

### Runtime checks
```javascript
$.checkUserPermission(sender, event.getTags(), $.PERMISSION.Mod);
$.isModv3(sender, event.getTags());
```

### Programmatic invocation
```javascript
$.command.run(sender, command, args, tags);  // synthesizes a CommandEvent
```
Use this when a redemption/keyword/timer should trigger an existing command — inherits its permission/cooldown/restriction checks.

### `@commandpath` comments
Stock format `/** @commandpath cmd subargs - description */` feeds help-list tooling. Use the same convention.

---

## 7. Database — `$.inidb`

**Backing store:** H2 (default), SQLite, MySQL, or MariaDB via pooled JDBC. The "ini" in the name is historical; this is a real database with transactions. Tables are namespaced as `phantombot_<table>` in storage.

**Used for both configuration AND high-churn data** (points, watch time, inventory, cooldown timestamps, stats). Not a slow side-store — the stock points and watch-time systems write through it on every event.

### Core API
```javascript
$.inidb.set(table, key, value);
$.inidb.get(table, key);              // string or null
$.inidb.exists(table, key);
$.inidb.del(table, key);
$.inidb.incr(table, key, amount);     // atomic
$.inidb.decr(table, key, amount);     // atomic
$.inidb.GetKeyList(table, section);
$.inidb.RemoveFile(table);            // drop entire table
$.inidb.GetBoolean(table, section, key);
```

### Typed wrappers (`core/misc.js`) — prefer these
```javascript
$.getSetIniDbString(table, key, default);   // read; seed default if missing
$.getSetIniDbNumber(table, key, default);
$.getSetIniDbBoolean(table, key, default);
$.getIniDbString / Number / Boolean(table, key, default);
$.setIniDbString / Number / Boolean(table, key, value);
```

### Batch operations (use for many keys at once)
```javascript
$.inidb.IncreaseBatchString(table, section, keys[], amount);  // one transaction
$.inidb.SetBatchString(table, section, keys[], values[]);
```
The stock points payout interval and 60-second watch-time tick use `IncreaseBatchString` so updating hundreds of chatters is one transaction.

### Conventions
- Namespace your tables with your module's name: `mymodule_settings`, `mymodule_inventory`, `mymodule_stats`.
- Core-owned tables (`points`, `time`, `permcom`, `modules`, `disabledCommands`, ...) — interact via public helpers like `$.inidb.incr('points', user, n)`.
- For values read on every chat message, cache in JS and re-read on change (see stock `roll.js`'s `loadPrizes()` pattern).

---

## 8. Language files

**Load order (`core/bootstrap/140lang.js`):** `lang/english` → configured language → `lang/custom` last. Custom entries override everything. Both `.js` and `.json` formats supported, scanned recursively.

### JS format
```javascript
$.lang.register('mymodule.greet', '$1, welcome back $2!');
$.lang.register('mymodule.set.ok', 'Greeting updated.');
```

### JSON format
```json
{
  "mymodule.greet": "$1, welcome back $2!",
  "mymodule.set.ok": "Greeting updated."
}
```

### API
```javascript
$.lang.get(key, p1, p2, ...);   // $1..$9 substituted; missing key returns '' + warn
$.lang.exists(key);
$.lang.paramCount(key);
```

- Keys lowercased internally; namespace with your module name; only letters/periods/hyphens.
- Empty string registers a placeholder so `$.lang.get` returns `''` silently — how users blank out individual messages.
- `!reloadcustom` re-runs lang load. `!lang <name>` switches language at runtime.

---

## 9. Concurrency — when to use Java locks

### The pattern
```javascript
var _lock = new Packages.java.util.concurrent.locks.ReentrantLock();

_lock.lock();
try {
    // mutate shared state
} finally {
    _lock.unlock();
}
```

Always `ReentrantLock` (Rhino has no `synchronized` keyword; reentrant because helpers may re-take the same lock). No `ReadWriteLock` usage in stock — maintainers haven't found it worth the complexity.

### Decision rule
For each piece of state, ask three questions:
1. Does it live in JS (variable/array/object) or in the DB? **DB-only → no JS lock needed**; the DataStore handles concurrency.
2. Is it touched by more than one event handler, or by a handler plus a timer? **One source → no lock needed.**
3. Is the operation read-modify-write or a multi-step mutation that must be atomic? **Single write → usually fine; multi-step → lock.**

All three lean "yes" → lock. Otherwise it's overhead.

### Lock these patterns
- **Shared collection mutated from multiple events:** in-memory entry lists, queues, active-round state. (`raffleSystem`, `queueSystem`, `bettingSystem`, `auctionSystem`, `pollSystem`.)
- **Read-then-write where the read informs the write:** "don't repeat last value" state, counters with dedup. (`games/8ball.js`.)
- **Event handler + timer coordinating on the same map:** cache rebuild timer vs lookup handlers. (`emotesHandler`, `commandCoolDown`, `keywordCoolDown`, `commandPause`.)
- **Game state machine:** open → joining → running → payout transitions. (`adventureSystem`.)
- **Runtime-mutated registry:** commands/permissions maps mutated by `registerChatCommand` and dispatcher concurrently. (`commandRegister`, `permissions`.)

### Don't lock these
- Stateless command handler whose only mutation is `$.inidb.incr(...)` — DataStore is atomic. (`deathctrCommand`, `roll`, donation/raid/follow/subscribe handlers.)
- Module bound only to a single event source with no shared state writers elsewhere.
- Double-fire races where a brief stale read is harmless (e.g. a config toggle being read just before it changes).

---

## 10. Inter-module communication

Four patterns, in order of preference for typical needs:

### 10.1 Exported functions/namespaces on `$` — most common
Synchronous, returns values. Attach at bottom of IIFE.

```javascript
// Flat:
$.getUserPoints = getUserPoints;
$.resolveRank = resolveRank;

// Namespaced:
$.points = {
    nameSingle: getPointNameSingle,
    give: givePoints,
    take: takePoints
};
```

Stock examples: `$.points.*`, `$.subscription.*`, `$.poll.*`, `$.channelpoints.*`, `$.discord.*`, `$.command.run`.

### 10.2 Java EventBus — one-to-many broadcast
Requires an existing Java event class. The only event classes useful from scripts are usually `CommandEvent` (replay a chat command) and `DiscordChannelCommandEvent` (Discord equivalent). `EmotesCacheUpdatedEvent` is the canonical "broadcast something happened" example.

```javascript
var EventBus = Packages.tv.phantombot.event.EventBus,
    CommandEvent = Packages.tv.phantombot.event.command.CommandEvent;
EventBus.instance().postAsync(new CommandEvent($.botName, 'ytp', 'togglerandom'));
```

Or use the wrapper `$.command.run(...)`.

### 10.3 Shared database — schema as API
Other modules read/write your tables directly via `$.inidb`. This is how every game module awards points without calling into `pointSystem.js`. Makes upgrades less coupled to internal function shapes.

### 10.4 Panel websocket — for panel → script
Panel pages send messages; the owning script listens with `$.bind('webPanelSocketUpdate', ...)`. Used by the declarative `settingsModal` "panel-settings-saved" notification (see §13).

### Load-order gotcha
Top-level code (outside event handlers) executes at script-load time in directory order. References to `$.points.give` at the top level of your module may be `undefined` if `pointSystem` hasn't loaded yet. **Move cross-module references inside `initReady` or command handlers** — by then all modules are loaded.

### Convention for "reload yourself" notifications
Stock pattern is to export a `reload*` function (`$.reloadRaffle`, `$.reloadBet`, `$.reloadRaid`, `$.updateFollowConfig`, ...) and have the panel command or settings save call it. Lighter than a custom event for one or two known callers.

---

## 11. External communication

### Outbound — bot reaches out

**`$.customAPI` — general HTTP client:**
```javascript
$.customAPI.get(url);              // returns HttpResponse {content, httpCode, success, exception}
$.customAPI.get(url, accept);
$.customAPI.post(url, content);
$.customAPI.put(url, content);
$.customAPI.getJSON(url);
```

**`Packages.com.gmt2001.HttpRequest` — lower-level** (custom headers, body encoding):
```javascript
var HttpRequest = Packages.com.gmt2001.HttpRequest,
    HashMap = Packages.java.util.HashMap;
var headers = new HashMap();
headers.put('Content-Type', 'application/json');
var res = HttpRequest.getData(HttpRequest.RequestType.GET, url, body, headers);
// res.success, res.httpCode, res.content, res.exception
```

**Pre-built service clients on `$`:**
| Property | Service |
|---|---|
| `$.helix` | Twitch Helix |
| `$.twitch` | Older TwitchAPIv5 wrapper |
| `$.youtube` | YouTube Data API v3 |
| `$.streamLabsAPI` | StreamLabs |
| `$.discordAPI` | Discord (`$.discord.*` wraps it) |

Prefer these over raw HTTP — they handle auth and rate limits.

**`(customapi ...)` command tag** — end-users can put `(customapi http://...)` in custom commands; the bot GETs the URL when the command fires. User-facing, not script-facing.

### Inbound — bot accepts connections

The bot runs an embedded HTTPS + WebSocket server (Netty, default port 25000). Three channels:

**`/addons/*` — public HTTP** (`HTTPNoAuthHandler.java`). Anything under `./addons/` is web-fetchable without auth. Query-param features:
- `?refresh=N` — wraps response in HTML that auto-reloads every N seconds (perfect for OBS browser sources reading text files).
- `?marquee=...` — scrolling-text wrapping.

**`/ws/alertspolls` — unauthenticated WebSocket** for pushing to overlays. Exposed to scripts as `$.alertspollssocket`:
```javascript
$.alertspollssocket.sendJSONToAll(JSON.stringify({
    type: 'death_added', game: currentGame, count: newCount
}));
```
Also has `alertImage(...)` for the built-in alert system.

**Panel WebSocket — authenticated.** Push: `$.panelsocketserver.sendJSONToAll(...)`. Pull (panel → script): `webPanelSocketUpdate` event.

### What's NOT available from scripts
- **No raw TCP/UDP sockets.** Technically reachable via `Packages.java.net.Socket`, but unsupported; no stock script does it.
- **No process execution.** No `Runtime.exec`, no `ProcessBuilder` in stock scripts.
- **File ops are path-restricted.** `$.writeToFile`, `$.readFile`, `$.mkDir`, `$.findFiles`, etc. allowlist (from `com/gmt2001/PathValidator.java`):

  | Use | Allowed roots |
  |---|---|
  | Script file ops | `./addons`, `./config/audio-hooks`, `./config/gif-alerts`, `./config/clips`, `./config/emotes`, `./logs`, `./scripts` |
  | Unauth HTTP serving | `./web`, `./addons`, the four `./config/*` media folders |
  | Auth HTTP serving | `./logs` (plus `./web`) |
  | Lang files | `./scripts/lang` |

  Out-of-path attempts log `Blocked X target outside of validPaths` and no-op.

### Patterns for common goals

| Goal | Channel |
|---|---|
| Webhook out on in-bot event | `$.customAPI.post/get` |
| Fetch data in a chat command | `$.customAPI.get` (or `(customapi ...)` tag) |
| Drive a static OBS text overlay | Write `./addons/<module>/<file>.txt`, browser source `…?refresh=N` |
| Drive an animated overlay | HTML in `./addons/<module>/`, JS connects to `/ws/alertspolls`, script calls `sendJSONToAll` |
| Authenticated external dashboard | Panel page + panel WS + `webPanelSocketUpdate` |
| Twitch/YouTube/Discord/StreamLabs | Use the matching `$` client |
| Raw sockets, processes, arbitrary FS access | Run as sidecar process; talk to it over HTTP from `$.customAPI` |

### Canonical OBS overlay pattern (the deathctr style)
The stock `deathctrCommand.js` mirrors a counter to `addons/deathctr/deathctr.txt` on every mutation **plus** every 10 seconds via `setInterval`. DB is source of truth; file is a one-way render target for OBS's "Read from file" text source. Use this pattern for any counter, timer, or status string surfaced on stream.

---

## 12. Common helpers (`$`)

```javascript
$.say(message);                       // send to chat (respects mute/me settings)
$.whisperPrefix(sender);              // "@User, " prefix
$.username.resolve(name);             // display-name resolution
$.user.sanitize(name);                // strips '@'/spaces, lowercases — apply to user args
$.jsString(x);                        // Java string → JS string
$.equalsIgnoreCase(a, b);
$.randRange(min, max);
$.rand(max);
$.trueRandRange(min, max);            // random.org-backed; falls back to local
$.getPointsString(n);
$.getGame(channelName);
$.isOnline(channelName);
$.systemTime();
$.getCurrentLocalTimeString(fmt);
$.log.event(msg);
$.log.error(msg);
$.log.warn(msg);
$.consoleLn(msg);
$.consoleDebug(msg);
```

---

## 13. Panel integration (`manifest.json`)

Drop `web/panel/custom/<moduleId>/manifest.json`. Bot scans, validates, merges, and serves merged result at authenticated `GET /panel/custom-manifests.json`. Invalid entries are skipped with a console warning naming the manifest path.

Must contain at least one non-empty `nav` or `cards` array.

### `nav` (sidebar links)

```json
{
  "nav": [
    { "label": "My Module", "folder": "custom/mymodule",
      "page": "panel.html", "section": "extra" }
  ]
}
```

| Field | Required | Rules |
|---|---|---|
| `label` | yes | Sidebar text |
| `folder` | yes | Must start with `custom/`; matches `web/panel/pages/<folder>/` |
| `page` | yes | Single filename like `something.html`; no `/`, `..`, `\`, reserved URI chars |
| `hash` | no | If present, must equal `page` |
| `section` | no | `extra` (default), `alerts`, `giveaways`, `audio`. Others log warn → fall back to `extra` |

Duplicate `folder`+`page` deduplicated, first wins.

### `cards` (Games page)

```json
{
  "cards": [{
    "section": "games", "id": "mymodule-game", "title": "My Minigame",
    "description": "Card body.",
    "scriptPath": "./custom/games/myGame.js",
    "detailsModal": { "title": "About", "content": "<p>Sanitized HTML.</p>" },
    "settingsModal": {
      "title": "Settings",
      "fields": [
        { "id": "min-bet", "type": "number", "label": "Min bet",
          "table": "mymodule_settings", "key": "min_bet", "min": 1 }
      ]
    }
  }]
}
```

| Field | Required | Rules |
|---|---|---|
| `id` | yes | Letters/digits/`_`/`-`; max 64 chars |
| `title` | yes | — |
| `description` | no | Escaped on render |
| `section` | no | Only `games` supported today |
| `scriptPath` | no | Wires module toggle. Must start with `./`, contain a directory segment, end with `.js`, 8–256 chars, no `..`/backslashes. Bare `./foo.js` rejected. Malformed → whole card skipped |
| `detailsModal` | no | `content` required (max 16384 chars), sanitized HTML allowlist (`p`,`br`,`strong`,`em`,`b`,`i`,`u`,`s`,`h4`–`h6`,`ul`,`ol`,`li`,`a` with safe `href`,`code`,`pre`,`blockquote`,`div`,`span`,`hr`). `title` max 200 |
| `settingsModal` | no | See below |

### `settingsModal` fields

Requires `title` plus **either** flat `fields[]` **or** `sections[]` (accordion panels each with `{id, title, defaultExpanded?, fields[]}`) — not both. Limits: 50 fields total, 10 sections.

Every field needs `id`, `type`, `label`, `table`, `key`. Optional `help`.

| `type` | Storage | Extras |
|---|---|---|
| `number` | numeric | optional `min`, `max` |
| `text` | string | — |
| `textarea` | string | `unlimited: true` to lift default cap |
| `boolean` | boolean | optional `options: [trueLabel, falseLabel]`; defaults Yes/No |
| `toggle` | boolean | compact switch |
| `checkboxgroup` | multiple booleans | shared `table` on parent; `checkboxes: [{id, label, key, help?}]`; inner ids unique across the whole modal |
| `dropdown` | string | `options: [string]` |
| `permission` | group id | — |

### Save notification

After a successful save with `scriptPath` set, the panel sends a panel WS event with `args[0] === "panel-settings-saved"`. Handle to refresh cached settings:

```javascript
$.bind('webPanelSocketUpdate', function (event) {
    if (event.getScript().equalsIgnoreCase('./custom/games/myGame.js')
            && $.equalsIgnoreCase(event.getArgs()[0], 'panel-settings-saved')) {
        reloadSettings();
    }
});
```

DOM-side, `pbCustomCardSettingsSaved` `CustomEvent` is dispatched on `document` with detail `{cardId, section, scriptPath, title}`.

### Panel user permissions

Uses same Settings → Panel Users sections as stock (no per-module ACL):
- **Full Access** — read + write
- **Read Only** — visible, reads only; Games card toggle/cog auto-disabled; **custom nav pages must implement this themselves**
- **No access** — section omitted from `custom-manifests.json` for that user

For custom nav pages, use `window.__pbCustomPanel__` (loaded before your page script):

| Helper | Purpose |
|---|---|
| `panelSectionCanWrite(section)` | true if Full Access |
| `requirePanelSectionWrite(section)` | returns false + shows permission toast if read-only — call at top of click/save handlers |
| `READ_ONLY_PANEL_TITLE` | tooltip text for disabled controls |

Use the same `section` string as the manifest; `$.currentPage().panelSection` exposes the active value after navigation.

---

## 14. Discord modules

Live in `scripts/discord/custom/`. Discord-side API on `$.discord`:

```javascript
(function () {
    $.bind('discordChannelCommand', function (event) {
        var command = event.getCommand(),
            channel = event.getDiscordChannel(),
            args = event.getArgs();
        if ($.equalsIgnoreCase(command, 'mycmd')) {
            $.discord.say(channel, 'Hello!');
        }
    });

    $.bind('initReady', function () {
        $.discord.registerCommand('./discord/custom/myDiscordModule.js', 'mycmd', 0);
    });
})();
```

Discord permissions are their own scheme (admin flag / roles), not the Twitch group IDs.

Events: `discordChannelMessage`, `discordChannelCommand`, `discordChannelJoin/Part`, `discordRole*`, `discordMessageReaction`. Source: `source/tv/phantombot/event/discord/`.

---

## 15. Docker

Bind-mount data directory (typically `/opt/PhantomBot_data`). Image symlinks writable paths into it:

| Container path | Resolves to |
|---|---|
| `/opt/PhantomBot/scripts/custom` | `/opt/PhantomBot_data/scripts/custom` |
| `/opt/PhantomBot/scripts/lang/custom` | `/opt/PhantomBot_data/scripts/lang/custom` |
| `/opt/PhantomBot/scripts/discord/custom` | `/opt/PhantomBot_data/scripts/discord/custom` |
| `/opt/PhantomBot/web/panel/custom` | `/opt/PhantomBot_data/web/panel/custom` |
| `/opt/PhantomBot/web/panel/pages/custom` | `/opt/PhantomBot_data/web/panel/pages/custom` |
| `/opt/PhantomBot/web/panel/js/pages/custom` | `/opt/PhantomBot_data/web/panel/js/pages/custom` |
| `/opt/PhantomBot/addons` | `/opt/PhantomBot_data/addons` |
| `/opt/PhantomBot/config` | `/opt/PhantomBot_data/config` |

Edit on the host; no image rebuild required. Entrypoint creates subdirectories on first boot.

---

## 16. Conventions checklist

- IIFE-wrap every script.
- Namespace everything: tables (`mymodule_*`), lang keys (`mymodule.*`), commands (avoid clobbering stock — `registerChatCommand` silently no-ops if the command exists).
- Seed every setting with `$.getSetIniDb*` at module top so panel/other scripts can discover it.
- Register commands inside `$.bind('initReady', ...)` with the correct script path.
- Cross-module references go inside event handlers, not module top-level.
- Attach exports at the bottom of the IIFE.
- Don't edit stock scripts; bind to events instead.
- Use batch INIDB ops (`IncreaseBatchString`, `SetBatchString`) for many-key updates.
- Use `$.command.run` to inherit permission/cooldown checks when triggering existing commands.
- Lock shared in-memory state mutated from multiple event threads; don't lock pure DB writes.
- Drop OBS overlay text into `./addons/<module>/` and serve via the bot's HTTP server with `?refresh=N`.
- Use sidecar processes (over HTTP) for anything needing OS access; don't try to escape the script sandbox.

---

## 17. Troubleshooting

| Symptom | Cause/fix |
|---|---|
| New commands missing | Run `!reloadcustom`; ensure registration is inside `$.bind('initReady', ...)` |
| Command never fires / can't be toggled | Script path string in `registerChatCommand` doesn't match real path |
| Sidebar link → blank/404 | `web/panel/pages/custom/<moduleId>/<page>.html` missing or wrong path |
| No sidebar link | Invalid JSON; `folder`/`page` failed validation; check console for `Custom panel manifest skipped nav` |
| No Games card | `section` must be `games`; check console `skipped card` reason |
| Card toggle no-op | `scriptPath` must be path `!module` understands (`./custom/games/foo.js`, not `./foo.js`) |
| Settings save but bot unchanged | Cache stale — handle `panel-settings-saved` in `webPanelSocketUpdate` |
| Read-only user sees success | Call `requirePanelSectionWrite(section)` before showing success UI |
| Writes denied / wrong section | Open page via manifest sidebar link so `$.currentPage().panelSection` matches `nav.section` |
| Panel shows stale UI | Hard-refresh (Ctrl+Shift+R) — panel assets are cached |
| File write silently fails | Path outside `PathValidator` allowlist — check `Blocked X target outside of validPaths` log |
| Lang string empty + warning | Key not registered (typo/case); file must be under `scripts/lang/custom/` |
| Broke after PhantomBot upgrade | Expected — retest after every upgrade, read release notes |

---

## 18. Reference locations in the repo

- `docs/guides/content/developerdocs/custommodules.md` — full manifest spec (source of phantombot.dev)
- `docs/guides/content/moduleguides/addingcustommodules.md` — install guide
- `docs/guides/content/developerdocs/registerchatcommand.md` — command registration
- `javascript-source/core/` — init.js, commandRegister.js, lang.js, permissions.js, misc.js, customScripts.js (reloadcustom), commandCoolDown.js
- `javascript-source/games/roll.js` — small, idiomatic example (settings, commands+subcommands, lang, points)
- `javascript-source/commands/deathctrCommand.js` — file-mirror pattern for OBS overlays
- `javascript-source/systems/pointSystem.js` — namespace exports, batch DB ops
- `javascript-source/systems/raffleSystem.js` — lock pattern for in-memory collections
- `javascript-source/handlers/emotesHandler.js` — EventBus broadcast example
- `source/tv/phantombot/event/` — every event class = every bindable hook
- `source/com/scaniatv/CustomAPI.java` — HTTP client surface
- `source/com/gmt2001/PathValidator.java` — file path allowlist
- `source/tv/phantombot/PhantomBot.java` — `ExposePropertyToScripts` calls = full list of Java objects on `$`
- JavaDoc at `https://phantombot.dev/javadoc/` (nightly) and `/javadoc-stable/`
- `PhantomBot/custom-modules` on GitHub — community examples

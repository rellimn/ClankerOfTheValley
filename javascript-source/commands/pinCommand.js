/*
 * Copyright (C) 2026 phantombot.github.io/PhantomBot
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * Sends and pins messages for the remainder of the stream.
 */
(function () {
    var lock = new Packages.java.util.concurrent.locks.ReentrantLock();

    function reply(sender, key) {
        $.say($.whisperPrefix(sender) + $.lang.get(key));
    }

    function failed(sender, response, posted) {
        var status = response.optInt('_http', 0);
        $.log.error('Chat pin request failed (HTTP ' + status + ').');
        if (posted) {
            reply(sender, 'pincommand.pin.failed');
        } else if (status === 401 || status === 403) {
            reply(sender, 'pincommand.authorization');
        } else if (status === 429) {
            reply(sender, 'pincommand.ratelimit');
        } else {
            reply(sender, 'pincommand.failed');
        }
    }

    $.bind('command', function (event) {
        var command = $.jsString(event.getCommand()).toLowerCase();
        if (command !== 'pin' && command !== 'unpin') {
            return;
        }
        var sender = event.getSender();
        if (!$.checkUserPermission(sender, event.getTags(), $.PERMISSION.Mod)) {
            return;
        }
        var message = $.jsString(event.getArguments()).trim();
        if (command === 'pin' && message.length === 0) {
            reply(sender, 'pincommand.pin.usage');
            return;
        }
        if (command === 'pin' && message.length > 500) {
            reply(sender, 'pincommand.toolong');
            return;
        }
        if (command === 'unpin' && message.length > 0) {
            reply(sender, 'pincommand.unpin.usage');
            return;
        }
        if (!lock.tryLock()) {
            reply(sender, 'pincommand.busy');
            return;
        }
        var posted = false;
        try {
            var broadcaster = $.viewer.broadcaster().id(),
                response = $.helix.getPinnedChatMessage(broadcaster);
            // Check moderation authorization before posting anything to chat.
            if (response.optInt('_http', 0) !== 200) {
                failed(sender, response, false);
                return;
            }

            /*
             * @commandpath pin [message] - Send and pin a message until manually unpinned, replaced, or the stream ends. Moderators only.
             */
            if (command === 'pin') {
                response = $.helix.sendChatMessage(false, broadcaster, message, false, null);
                if (response.optInt('_http', 0) !== 200) {
                    failed(sender, response, false);
                    return;
                }
                var data = response.getJSONArray('data');
                if (data.length() === 0 || !data.getJSONObject(0).optBoolean('is_sent', false)) {
                    reply(sender, 'pincommand.dropped');
                    return;
                }
                posted = true;
                var messageId = data.getJSONObject(0).getString('message_id');
                Packages.com.gmt2001.twitch.tmi.processors.PrivMsgTMIProcessor.preventSelfTrigger(messageId);
                response = $.helix.pinChatMessage(broadcaster, messageId);
                if (response.optInt('_http', 0) !== 204) {
                    failed(sender, response, true);
                    return;
                }
                reply(sender, 'pincommand.pin.success');
            }

            /*
             * @commandpath unpin - Remove the current pinned chat message. Moderators only.
             */
            if (command === 'unpin') {
                var pins = response.getJSONArray('data');
                if (pins.length() === 0) {
                    reply(sender, 'pincommand.empty');
                    return;
                }
                response = $.helix.unpinChatMessage(broadcaster, pins.getJSONObject(0).getString('message_id'));
                if (response.optInt('_http', 0) === 404) {
                    reply(sender, 'pincommand.changed');
                } else if (response.optInt('_http', 0) !== 204) {
                    failed(sender, response, false);
                } else {
                    reply(sender, 'pincommand.unpin.success');
                }
            }
        } catch (e) {
            $.log.error('Chat pin command failed: ' + e);
            reply(sender, posted ? 'pincommand.pin.failed' : 'pincommand.failed');
        } finally {
            lock.unlock();
        }
    });

    $.bind('initReady', function () {
        $.registerChatCommand('./commands/pinCommand.js', 'pin', $.PERMISSION.Mod);
        $.registerChatCommand('./commands/pinCommand.js', 'unpin', $.PERMISSION.Mod);
    });
})();

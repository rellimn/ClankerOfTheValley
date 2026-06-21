/*
 * Copyright (C) 2016-2026 phantombot.github.io/PhantomBot
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

/* global Packages */

(function () {
    /*
     * @transformer requiresubtier
     * @formula (requiresubtier tier:int message:str) cancels the command unless the sender has at least the given subscription tier; sends the optional message when the requirement is not met
     * @formula (requiresubtier tier:int @user:str message:str) cancels the command unless the given user has at least the given subscription tier; sends the optional message when the requirement is not met
     * @labels twitch commandevent meta
     * @example Caster: !addcom !tier2 This command is for Tier 2 subscribers. (requiresubtier 2 Please subscribe at Tier 2 or higher.)
     * User: !tier2
     * Bot: Please subscribe at Tier 2 or higher.
     * @notes `tier` must be 1, 2, or 3. Prefix an optional target user with `@`; without one, the sender is checked. The target prefix makes a message optional without treating its first word as a username.
     * @cancels sometimes
     */
    function requiresubtier(args) {
        let parsedArgs = $.parseArgs(args.args, ' ', 2, true);
        let requiredTier;
        let target = args.event.getSender();
        let message = '';
        let targetAndMessage = '';

        if (parsedArgs !== null) {
            requiredTier = parseInt(parsedArgs[0]);
            targetAndMessage = parsedArgs.length > 1 ? parsedArgs[1] : '';
        }

        if (targetAndMessage.startsWith('@')) {
            let targetMatch = targetAndMessage.match(/^@(\w+)(?:\s+(.*))?$/);
            if (targetMatch !== null) {
                target = targetMatch[1];
                message = targetMatch[2] || '';
            }
        } else {
            message = targetAndMessage;
        }

        if (requiredTier >= 1 && requiredTier <= 3) {
            try {
                let viewer = $.viewer.getByLogin($.user.sanitize(target));
                if (viewer !== null) {
                    let userIds = new Packages.java.util.ArrayList();
                    userIds.add(viewer.id());

                    let subscriptions = $.helix.getBroadcasterSubscriptions($.viewer.broadcaster().id(), userIds, 1, null);
                    if (subscriptions.has('data') && subscriptions.getJSONArray('data').length() === 1
                            && parseInt(subscriptions.getJSONArray('data').getJSONObject(0).getString('tier')) >= requiredTier * 1000) {
                        return {result: ''};
                    }
                }
            } catch (ex) {
                $.consoleDebug('requiresubtier: ' + ex);
            }
        }

        if (message.length > 0) {
            $.say(message);
        }
        return {cancel: true};
    }

    $.transformers.addTransformer(new $.transformers.transformer('requiresubtier', ['twitch', 'commandevent', 'meta'], requiresubtier));
})();

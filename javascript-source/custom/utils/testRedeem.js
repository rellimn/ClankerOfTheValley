/*
 * Copyright (C) 2016-2026 phantombot.github.io/PhantomBot
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

/* global Packages */

(function () {
    var SCRIPT = './custom/utils/testRedeem.js',
        EVENT_BUS = Packages.tv.phantombot.event.EventBus,
        REDEMPTION = Packages.com.gmt2001.twitch.eventsub.subscriptions.channel.channel_points.redemption.ChannelPointsCustomRewardRedemptionAdd,
        REDEMPTION_EVENT = Packages.tv.phantombot.event.eventsub.channel.channel_points.redemption.EventSubChannelPointsCustomRewardRedemptionAddEvent;

    function findConfiguredReward(id) {
        var commands;

        try {
            commands = JSON.parse($.getIniDbString('channelPointsSettings', 'commands', '[]'));
        } catch (ex) {
            $.log.error('testRedeem: unable to read channel point reward configuration: ' + ex);
            return null;
        }

        for (var i = 0; i < commands.length; i++) {
            if (commands[i].type === 'channelpoints' && $.equalsIgnoreCase(commands[i].id, id)) {
                return commands[i];
            }
        }

        return null;
    }

    function getRewardDetails(configuredReward) {
        var details = {
                title: $.jsString(configuredReward.title),
                cost: 0,
                prompt: ''
            },
            response,
            rewards,
            reward;

        try {
            response = $.helix.getCustomReward(null, null);
            if (!response.has('data')) {
                return details;
            }

            rewards = response.getJSONArray('data');
            for (var i = 0; i < rewards.length(); i++) {
                reward = rewards.getJSONObject(i);
                if ($.equalsIgnoreCase(reward.getString('id'), configuredReward.id)) {
                    details.title = $.jsString(reward.getString('title'));
                    details.cost = reward.getInt('cost');
                    details.prompt = $.jsString(reward.optString('prompt'));
                    break;
                }
            }
        } catch (ex) {
            $.log.warn('testRedeem: unable to retrieve live reward details: ' + ex);
        }

        return details;
    }

    /**
     * @commandpath testredeem reward-id user [user input] - Emits a synthetic Channel Points redemption for a configured reward and user
     */
    $.bind('command', function (event) {
        var command = event.getCommand(),
            args = event.getArgs(),
            sender = $.jsString(event.getSender()),
            rewardId,
            reward,
            broadcaster,
            viewer,
            target,
            userId,
            userName,
            input,
            rewardDetails,
            redemption;

        if (!$.equalsIgnoreCase(command, 'testredeem')) {
            return;
        }

        if (args[0] === undefined || $.jsString(args[0]).trim() === '' || args[1] === undefined || $.jsString(args[1]).trim() === '') {
            $.say($.whisperPrefix(sender) + 'Usage: !testredeem <reward-id> <user> [user input]');
            return;
        }

        rewardId = $.jsString(args[0]);
        reward = findConfiguredReward(rewardId);
        if (reward === null) {
            $.say($.whisperPrefix(sender) + 'That reward ID is not configured as a Channel Points command.');
            return;
        }

        broadcaster = $.viewer.broadcaster();
        target = $.user.sanitize($.jsString(args[1]));
        viewer = $.viewer.getByLogin(target);
        if (viewer === null) {
            $.say($.whisperPrefix(sender) + 'Unable to find Twitch user ' + target + '.');
            return;
        }

        userId = $.jsString(viewer.id());
        userName = $.jsString(viewer.name()) === '' ? target : $.jsString(viewer.name());
        input = args.slice(2).join(' ');
        rewardDetails = getRewardDetails(reward);

        redemption = REDEMPTION.createTestRedemption(
                $.jsString(broadcaster.id()), $.jsString(broadcaster.login()), $.jsString(broadcaster.name()),
                userId, target, userName, rewardId, rewardDetails.title, rewardDetails.cost, rewardDetails.prompt, input);
        EVENT_BUS.instance().postAsync(new REDEMPTION_EVENT(redemption));

        $.say($.whisperPrefix(sender) + 'Synthetic redemption emitted for ' + reward.title + '.');
    });

    $.bind('initReady', function () {
        $.registerChatCommand(SCRIPT, 'testredeem', $.PERMISSION.Admin);
    });
})();
